import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPreviewSpec } from 'previewhost';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PreviewRecipeGenerationRunError,
  PreviewRecipeGenerationService,
  validatePreviewRecipeDraft
} from './PreviewRecipeGenerationService';
import { PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION } from './PreviewRecipeGenerationSupport';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('PreviewRecipeGenerationService', () => {
  it.each([
    { name: 'app', type: 'command', cwd: '.', command: ['node', 'server.mjs'], env: { APP_LABEL: { fromEnv: 'APP_LABEL' } } },
    { name: 'app', type: 'environment', primary: 'web', services: {
      web: { type: 'command', cwd: '.', command: ['node', 'server.mjs'], ready: { type: 'command', command: ['node', 'check.mjs'], env: { APP_LABEL: { fromEnv: 'APP_LABEL' } } } }
    } },
    { name: 'app', type: 'environment', primary: 'web', services: {
      web: { type: 'static', directory: '.' }, database: { type: 'external-postgres', url: { fromEnv: 'DATABASE_URL' } }
    } }
  ])('rejects owner inputs that the embedded runtime cannot supply', (spec) => {
    expect(validatePreviewRecipeDraft(JSON.stringify(spec))).toMatchObject({ status: 'INVALID', issues: [{ message: expect.stringContaining('fromEnv') }] });
  });

  it('uses clarification with fresh evidence and rejects secret-bearing answers before provider delivery', async () => {
    const root = await previewWorktree();
    let calls = 0;
    const question = 'Which application should run?';
    const service = new PreviewRecipeGenerationService(async ({ cwd, instruction }) => {
      calls += 1;
      if (calls === 1) {
        return { result: Promise.resolve(JSON.stringify({
          ...JSON.parse(agentDraft()), status: 'insufficient-evidence', yaml: null,
          unresolvedDecisions: [question]
        })), cancel: async () => {} };
      }
      if (calls === 2) throw new PreviewRecipeGenerationRunError('UNAVAILABLE', 'Synthetic provider failure.');
      expect(instruction).toContain(JSON.stringify({ questions: [question], answer: 'Use the web application.' }));
      expect(await fs.readFile(path.join(cwd, 'repository-evidence.json'), 'utf8')).toContain('Updated setup details.');
      return { result: Promise.resolve(agentDraft()), cancel: async () => {} };
    });
    expect((await service.generate({ taskId: 'task', worktreePath: root })).status).toBe('NEEDS_INPUT');
    for (const clarification of ['DATABASE_PASSWORD=synthetic-only', '{"DATABASE_PASSWORD":"synthetic-only"}', '"API_SECRET": "synthetic-only"', '{"APP_LABEL":"web","DATABASE_PASSWORD":"synthetic-only"}']) {
      await expect(service.generate({ taskId: 'task', worktreePath: root, clarification })).rejects.toThrow('without secret values');
    }
    expect(calls).toBe(1);
    expect(service.get('task').status).toBe('NEEDS_INPUT');
    await fs.writeFile(path.join(root, 'README.md'), 'Updated setup details.');
    const failed = await service.generate({ taskId: 'task', worktreePath: root, clarification: 'Use the web application.' });
    expect(failed.status).toBe('FAILED');
    expect(failed.report?.unresolvedDecisions).toEqual([question]);
    expect((await service.generate({ taskId: 'task', worktreePath: root, clarification: 'Use the web application.' })).status).toBe('READY');
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();
  });

  it.each([
    'name: !!str application\ntype: static\ndirectory: .\n',
    '%YAML 1.1\n---\nname: application\ntype: static\ndirectory: .\n'
  ])('rejects YAML that the runtime loader cannot start', async (yaml) => {
    const root = await previewWorktree();
    const file = path.join(root, 'preview.yaml');
    await fs.writeFile(file, yaml);
    await expect(loadPreviewSpec(file)).rejects.toThrow();
    expect(validatePreviewRecipeDraft(yaml)).toMatchObject({
      status: 'INVALID', issues: [{ code: 'INVALID_RECIPE' }]
    });
  });

  it('rejects a literal secret in a liveness probe without an explicit readiness probe', () => {
    expect(validatePreviewRecipeDraft(`name: application
type: environment
primary: web
services:
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    liveness:
      intervalMs: 1000
      failureThreshold: 3
      probe:
        type: command
        command: [node, check.mjs]
        env: { API_SECRET: x }
`)).toMatchObject({ status: 'INVALID', issues: [{ code: 'SECRET_LITERAL' }] });
  });

  it('keeps a valid evidence-backed draft transient until exact acceptance', async () => {
    const root = await previewWorktree();
    let evidenceBundle = '';
    const service = new PreviewRecipeGenerationService(async ({ cwd, instruction }) => {
      evidenceBundle = await fs.readFile(path.join(cwd, 'repository-evidence.json'), 'utf8');
      expect(instruction).toContain('Do not run the application');
      return {
        result: Promise.resolve(agentDraft()),
        cancel: async () => {}
      };
    });

    const generated = await service.generate({
      taskId: 'task-1',
      worktreePath: root
    });

    expect(generated.status).toBe('READY');
    expect(generated.draft?.validation).toEqual({ status: 'VALID' });
    expect(evidenceBundle).toContain('package.json');
    expect(evidenceBundle).not.toContain('.env.local');
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();

    await service.writeAcceptedRecipe({
      taskId: 'task-1',
      draftId: generated.draft!.id,
      yaml: generated.draft!.yaml,
      worktreePath: root
    });

    expect(await fs.readFile(path.join(root, 'preview.yaml'), 'utf8')).toBe(
      generated.draft!.yaml
    );
    expect(service.completeAcceptance('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
  });

  it('rejects a result when the provider changes its bounded read-only evidence', async () => {
    const root = await previewWorktree();
    const evidenceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'preview-evidence-integrity-test-')
    );
    roots.push(evidenceRoot);
    const service = new PreviewRecipeGenerationService(async ({ cwd }) => {
      await fs.appendFile(
        path.join(cwd, 'repository-evidence.json'),
        '\nchanged by provider\n',
        'utf8'
      );
      return {
        result: Promise.resolve(agentDraft()),
        cancel: async () => {}
      };
    }, evidenceRoot);

    await expect(
      service.generate({ taskId: 'task-evidence-change', worktreePath: root })
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_AGENT_OUTPUT',
      message: expect.stringContaining('changed its read-only Preview evidence')
    });
    expect(await fs.readdir(evidenceRoot)).toEqual([]);
  });

  it('never overwrites a manual recipe that appears while a draft is reviewed', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(agentDraft()),
      cancel: async () => {}
    }));
    const generated = await service.generate({ taskId: 'task-1', worktreePath: root });
    await fs.writeFile(path.join(root, 'preview.yaml'), 'manual\n', 'utf8');

    await expect(
      service.writeAcceptedRecipe({
        taskId: 'task-1',
        draftId: generated.draft!.id,
        yaml: generated.draft!.yaml,
        worktreePath: root
      })
    ).rejects.toThrow('already exists');
    expect(await fs.readFile(path.join(root, 'preview.yaml'), 'utf8')).toBe(
      'manual\n'
    );
  });

  it('keeps validation, regeneration, close/reopen state, and discard transient', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(agentDraft()),
      cancel: async () => {}
    }));

    const first = await service.generate({ taskId: 'task-1', worktreePath: root });
    expect(service.get('task-1')).toEqual(first);
    expect(service.validate('task-1', first.draft!.id, first.draft!.yaml)).toEqual({
      status: 'VALID'
    });
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();

    const regenerated = await service.generate({ taskId: 'task-1', worktreePath: root });
    expect(regenerated.status).toBe('READY');
    expect(regenerated.draft!.id).not.toBe(first.draft!.id);
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();

    await expect(service.discard('task-1')).resolves.toEqual({
      taskId: 'task-1',
      status: 'EMPTY'
    });
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();
  });

  it('keeps the last valid draft when regeneration is stopped', async () => {
    const root = await previewWorktree();
    let secondStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let rejectSecond!: (error: Error) => void;
    let callCount = 0;
    const service = new PreviewRecipeGenerationService(async () => {
      callCount += 1;
      if (callCount === 1) {
        return { result: Promise.resolve(agentDraft()), cancel: async () => {} };
      }
      const result = new Promise<string>((_resolve, reject) => {
        rejectSecond = reject;
      });
      secondStarted();
      return {
        result,
        cancel: async () => {
          rejectSecond(new PreviewRecipeGenerationRunError('CANCELED', 'canceled'));
        }
      };
    });

    const first = await service.generate({ taskId: 'task-1', worktreePath: root });
    const regeneration = service.generate({ taskId: 'task-1', worktreePath: root });
    await started;
    const stopped = await service.discard('task-1');

    expect(await regeneration).toEqual(stopped);
    expect(stopped).toMatchObject({ status: 'READY', draft: { id: first.draft!.id } });
    expect(service.validate('task-1', first.draft!.id, first.draft!.yaml)).toEqual({
      status: 'VALID'
    });
  });

  it('keeps the displayed draft and report from the same valid generation', async () => {
    const root = await previewWorktree();
    let callCount = 0;
    const service = new PreviewRecipeGenerationService(async () => {
      callCount += 1;
      if (callCount === 1) {
        return { result: Promise.resolve(agentDraft()), cancel: async () => {} };
      }
      const rejected = JSON.parse(agentDraft()) as {
        yaml: string;
        summary: string;
      };
      rejected.yaml = 'version: 1\nservices: {}\nroutes: {}\n';
      rejected.summary = 'This report describes the rejected attempt.';
      return {
        result: Promise.resolve(JSON.stringify(rejected)),
        cancel: async () => {}
      };
    });

    const first = await service.generate({ taskId: 'task-1', worktreePath: root });
    const failed = await service.generate({ taskId: 'task-1', worktreePath: root });

    expect(failed).toMatchObject({
      status: 'FAILED',
      draft: { id: first.draft!.id },
      report: { summary: first.draft!.report.summary }
    });
    expect(failed.report?.summary).not.toBe(
      'This report describes the rejected attempt.'
    );
  });

  it('joins regeneration and removes the previous draft when its task is deleted', async () => {
    const root = await previewWorktree();
    let secondStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let rejectSecond!: (error: Error) => void;
    let callCount = 0;
    const service = new PreviewRecipeGenerationService(async () => {
      callCount += 1;
      if (callCount === 1) {
        return { result: Promise.resolve(agentDraft()), cancel: async () => {} };
      }
      const result = new Promise<string>((_resolve, reject) => {
        rejectSecond = reject;
      });
      secondStarted();
      return {
        result,
        cancel: async () => {
          rejectSecond(new PreviewRecipeGenerationRunError('CANCELED', 'canceled'));
        }
      };
    });

    const first = await service.generate({ taskId: 'task-1', worktreePath: root });
    const regeneration = service.generate({ taskId: 'task-1', worktreePath: root });
    await started;
    await service.clearTask('task-1');

    await expect(regeneration).resolves.toMatchObject({
      status: 'READY',
      draft: { id: first.draft!.id }
    });
    expect(service.get('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
    expect(() => service.validate('task-1', first.draft!.id, first.draft!.yaml)).toThrow(
      'no longer current'
    );
  });

  it('does not remove an active evidence bundle during recovery cleanup', async () => {
    const root = await previewWorktree();
    const evidenceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'preview-active-evidence-test-')
    );
    roots.push(evidenceRoot);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new PreviewRecipeGenerationService(async () => {
      signalStarted();
      await released;
      return { result: Promise.resolve(agentDraft()), cancel: async () => {} };
    }, evidenceRoot);

    const generation = service.generate({ taskId: 'task-1', worktreePath: root });
    await started;
    const [activeDirectory] = await fs.readdir(evidenceRoot);
    await service.recoverEvidence();
    expect(await fs.readdir(evidenceRoot)).toEqual([activeDirectory]);

    release();
    await expect(generation).resolves.toMatchObject({ status: 'READY' });
    expect(await fs.readdir(evidenceRoot)).toEqual([]);
  });

  it('returns a reviewable evidence report when the agent refuses to invent authority', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(JSON.stringify({
        schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
        status: 'insufficient-evidence',
        yaml: null,
        summary: 'No application entry point was proven.',
        evidence: [{ path: 'package.json', finding: 'No runnable preview script is declared.' }],
        assumptions: [],
        omissions: ['No command was guessed.'],
        unresolvedDecisions: ['Choose the application command and listening port.'],
        publicEnvironmentDecisions: []
      })),
      cancel: async () => {}
    }));

    const result = await service.generate({ taskId: 'task-1', worktreePath: root });

    expect(result.status).toBe('NEEDS_INPUT');
    expect(result.failureCode).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.report?.unresolvedDecisions).toEqual([
      'Choose the application command and listening port.'
    ]);
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();
  });

  it('accepts a final generation object after a separate ACP progress message', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(
        `Inspecting repository-evidence.json to prepare the recipe.${agentDraft()}`
      ),
      cancel: async () => {}
    }));

    await expect(
      service.generate({ taskId: 'task-acp-progress', worktreePath: root })
    ).resolves.toMatchObject({ status: 'READY' });
  });

  it('rejects trailing commentary and more than one generation object', async () => {
    const root = await previewWorktree();
    for (const [taskId, output] of [
      ['task-trailing', `${agentDraft()}\nDone.`],
      ['task-multiple', `${agentDraft()}\n${agentDraft()}`],
      ['task-long-prefix', `${'Working. '.repeat(600)}\n${agentDraft()}`]
    ] as const) {
      const service = new PreviewRecipeGenerationService(async () => ({
        result: Promise.resolve(output),
        cancel: async () => {}
      }));

      await expect(
        service.generate({ taskId, worktreePath: root })
      ).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'INVALID_AGENT_OUTPUT'
      });
    }
  });

  it('turns trusted Next.js fixed-port and HTTPS analysis into an actionable draft', async () => {
    const root = await nextWorktree();
    const service = new PreviewRecipeGenerationService(async ({ cwd, instruction }) => {
      const evidence = JSON.parse(
        await fs.readFile(path.join(cwd, 'repository-evidence.json'), 'utf8')
      ) as { frameworkCapabilities: { analyses: Array<Record<string, unknown>> } };
      expect(evidence.frameworkCapabilities.analyses[0]).toMatchObject({
        conflicts: [{ code: 'HTTPS_LISTENER' }, { code: 'FIXED_PORT' }],
        compatiblePreviewCommand: [
          './node_modules/.bin/next', 'dev', '--turbopack',
          '--hostname', '127.0.0.1'
        ],
        dependencyPreparation: expect.objectContaining({
          installCommand: ['npm', 'ci', '--no-audit', '--no-fund']
        })
      });
      expect(instruction).toContain('Do not report the listed port, protocol, or hostname conflicts as unresolved');
      return { result: Promise.resolve(nextAgentDraft()), cancel: async () => {} };
    });

    const result = await service.generate({ taskId: 'task-next', worktreePath: root });

    expect(result.status).toBe('READY');
    expect(result.draft?.yaml).toContain(
      "# The repository's existing development script pins port 8000 and enables"
    );
    expect(result.draft?.report.unresolvedDecisions).toEqual([]);
  });

  it('uses trusted PORT support for a standard Next.js script instead of requesting more evidence', async () => {
    const root = await nextWorktree('next dev --turbopack', '15.5.2');
    const service = new PreviewRecipeGenerationService(async ({ cwd }) => {
      const evidence = JSON.parse(
        await fs.readFile(path.join(cwd, 'repository-evidence.json'), 'utf8')
      ) as { frameworkCapabilities: { analyses: Array<Record<string, unknown>> } };
      expect(evidence.frameworkCapabilities.analyses[0]).toMatchObject({
        conflicts: [],
        compatiblePreviewCommand: ['npm', 'run', 'dev'],
        dependencyPreparation: expect.objectContaining({
          installCommand: ['npm', 'ci', '--no-audit', '--no-fund']
        }),
        portBinding: { type: 'environment', name: 'PORT' }
      });
      return {
        result: Promise.resolve(nextAgentDraft('[npm, run, dev]', '')),
        cancel: async () => {}
      };
    });

    const result = await service.generate({ taskId: 'task-next', worktreePath: root });

    expect(result.status).toBe('READY');
    expect(result.report).toBeUndefined();
    expect(result.draft?.report.unresolvedDecisions).toEqual([]);
  });

  it('requires a structured HTTP attachment decision for an evidenced public API origin', async () => {
    const root = await nextWorktreeWithPublicApi();
    const service = new PreviewRecipeGenerationService(async ({ cwd }) => {
      const evidence = JSON.parse(
        await fs.readFile(path.join(cwd, 'repository-evidence.json'), 'utf8')
      ) as { publicEnvironment: { candidates: Array<Record<string, unknown>> } };
      expect(evidence.publicEnvironment.candidates).toEqual([
        expect.objectContaining({
          id: 'next-public:NEXT_PUBLIC_API_URL',
          key: 'NEXT_PUBLIC_API_URL',
          sourceDefault: expect.objectContaining({ host: 'api.dev.example' })
        })
      ]);
      return { result: Promise.resolve(publicApiAgentDraft()), cancel: async () => {} };
    });

    const result = await service.generate({ taskId: 'task-next', worktreePath: root });

    expect(result.status).toBe('READY');
    expect(result.draft?.report.publicEnvironmentDecisions).toEqual([{
      candidateId: 'next-public:NEXT_PUBLIC_API_URL',
      key: 'NEXT_PUBLIC_API_URL',
      decision: 'HTTP_ATTACHMENT',
      reason: 'The browser API origin must be selected explicitly.',
      attachmentId: 'backend'
    }]);
    expect(result.draft?.yaml).toContain('service: backend');
    if (!result.draft) throw new Error('Expected generated draft.');
    const inconsistentEdit = result.draft.yaml.replace(
      'NEXT_PUBLIC_API_URL:',
      'NEXT_PUBLIC_OTHER_URL:'
    );
    expect(service.validate('task-next', result.draft.id, inconsistentEdit)).toEqual({
      status: 'INVALID',
      issues: [{
        code: 'PUBLIC_ENVIRONMENT_DECISION_INVALID',
        message: 'The generated public environment decision does not match the Preview recipe.'
      }]
    });
    await expect(service.writeAcceptedRecipe({
      taskId: 'task-next',
      draftId: result.draft.id,
      yaml: inconsistentEdit,
      worktreePath: root
    })).rejects.toThrow('does not match the Preview recipe');
  });

  it('accepts an omitted public value only when attachmentId is absent', async () => {
    const root = await nextWorktreeWithPublicApi();
    const omitted = JSON.parse(nextAgentDraft('[npm, run, dev]', '')) as Record<string, unknown>;
    omitted.publicEnvironmentDecisions = [{
      candidateId: 'next-public:NEXT_PUBLIC_API_URL',
      key: 'NEXT_PUBLIC_API_URL',
      decision: 'OMIT',
      reason: 'The Preview does not need the optional external API.'
    }];
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(JSON.stringify(omitted)),
      cancel: async () => {}
    }));

    await expect(
      service.generate({ taskId: 'task-omit', worktreePath: root })
    ).resolves.toMatchObject({ status: 'READY' });

    omitted.publicEnvironmentDecisions = [{
      candidateId: 'next-public:NEXT_PUBLIC_API_URL',
      key: 'NEXT_PUBLIC_API_URL',
      decision: 'OMIT',
      reason: 'The Preview does not need the optional external API.',
      attachmentId: null
    }];
    const invalid = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(JSON.stringify(omitted)),
      cancel: async () => {}
    }));
    await expect(
      invalid.generate({ taskId: 'task-omit-invalid', worktreePath: root })
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_AGENT_OUTPUT'
    });
  });

  it('rejects missing or YAML-inconsistent public environment decisions', async () => {
    const root = await nextWorktreeWithPublicApi();
    const missing = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(nextAgentDraft()),
      cancel: async () => {}
    }));
    const inconsistent = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(publicApiAgentDraft('other')),
      cancel: async () => {}
    }));
    const mixedRecipients = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(publicApiAgentDraftWithMixedRecipient()),
      cancel: async () => {}
    }));

    await expect(missing.generate({ taskId: 'task-missing', worktreePath: root })).resolves.toMatchObject({
      status: 'FAILED', failureCode: 'INVALID_AGENT_OUTPUT'
    });
    await expect(inconsistent.generate({ taskId: 'task-inconsistent', worktreePath: root })).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_AGENT_OUTPUT',
      message: 'The generated public environment decision does not match the Preview recipe.'
    });
    await expect(mixedRecipients.generate({ taskId: 'task-mixed', worktreePath: root })).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_AGENT_OUTPUT',
      message: 'The generated public environment decision does not match the Preview recipe.'
    });
  });

  it('enforces local selection when trusted public URL evidence conflicts', async () => {
    const root = await nextWorktreeWithPublicApi();
    const draft = JSON.parse(publicApiAgentDraft()) as { yaml: string };
    draft.yaml = draft.yaml.replace('check: false', 'check: false\n    url: http://127.0.0.1:4000/');
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(JSON.stringify(draft)),
      cancel: async () => {}
    }));

    await expect(service.generate({ taskId: 'task-conflict', worktreePath: root })).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_AGENT_OUTPUT',
      message: 'The generated public environment decision does not match the Preview recipe.'
    });
  });

  it.each([
    {
      name: 'the original conflicting repository script',
      command: '[npm, run, dev]',
      comment: nextCompatibilityComment()
    },
    {
      name: 'a rewritten command without its compatibility comment',
      command: '[./node_modules/.bin/next, dev, --turbopack, --hostname, 127.0.0.1]',
      comment: ''
    },
    {
      name: 'a direct Next.js command retaining conflicting listener flags',
      command: '[./node_modules/.bin/next, dev, --experimental-https, --port, "8000"]',
      comment: nextCompatibilityComment()
    }
  ])('rejects $name', async ({ command, comment }) => {
    const root = await nextWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(nextAgentDraft(command, comment)),
      cancel: async () => {}
    }));

    const result = await service.generate({ taskId: 'task-next', worktreePath: root });

    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('INVALID_AGENT_OUTPUT');
    expect(result.message).toMatch(/conflict|compatibility comment/);
  });

  it.each([
    ['the install job', { includeInstall: false }],
    ['the explicit success edge', { includeInstallNeed: false }],
    ['the lifecycle-script comment', { includeInstallComment: false }]
  ])('rejects a generated framework draft missing %s', async (_name, options) => {
    const root = await nextWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(nextAgentDraft(undefined, undefined, options)),
      cancel: async () => {}
    }));

    const result = await service.generate({ taskId: 'task-next', worktreePath: root });

    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('INVALID_AGENT_OUTPUT');
    expect(result.message).toMatch(/installation|install|lifecycle-script/);
  });

  it('rejects implicit package acquisition even when the command is otherwise valid YAML', async () => {
    const root = await nextWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(nextAgentDraft(
        '[npm, exec, --offline, --, next, dev, --turbopack, --hostname, 127.0.0.1]'
      )),
      cancel: async () => {}
    }));

    const result = await service.generate({ taskId: 'task-next', worktreePath: root });

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('implicit npm exec');
  });

  it('revalidates edited generated YAML against its transient framework facts before acceptance', async () => {
    const root = await nextWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(nextAgentDraft()),
      cancel: async () => {}
    }));
    const generated = await service.generate({ taskId: 'task-next', worktreePath: root });
    const edited = generated.draft!.yaml.replace('    dependsOn: [install]\n', '');

    expect(service.validate('task-next', generated.draft!.id, edited)).toMatchObject({
      status: 'INVALID',
      issues: [{ code: 'DEPENDENCY_PREPARATION_REQUIRED' }]
    });
    await expect(service.writeAcceptedRecipe({
      taskId: 'task-next',
      draftId: generated.draft!.id,
      yaml: edited,
      worktreePath: root
    })).rejects.toThrow('explicitly need');
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();
  });

  it('rejects literal secret-like environment delivery before acceptance', () => {
    expect(validatePreviewRecipeDraft(`name: application
type: environment
primary: web
services:
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    env: { API_TOKEN: plaintext-canary }
    ports: { http: PORT }
    ready: { type: tcp, port: http }
`)).toEqual({
      status: 'INVALID',
      issues: [{
        code: 'SECRET_LITERAL',
        message: 'Secret-like environment keys must use a secret reference, never a literal value.'
      }]
    });

    expect(validatePreviewRecipeDraft(`name: application
type: environment
primary: web
# token = "hardcoded-token-canary"
services:
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    ports: { http: PORT }
    ready: { type: tcp, port: http }
`)).toMatchObject({
      status: 'INVALID',
      issues: [{ code: 'SECRET_LITERAL' }]
    });
  });

  it('cancels and joins in-flight agent work during shutdown', async () => {
    const root = await previewWorktree();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let rejectResult!: (error: Error) => void;
    let cancelCount = 0;
    const result = new Promise<string>((_resolve, reject) => {
      rejectResult = reject;
    });
    const service = new PreviewRecipeGenerationService(async () => {
      signalStarted();
      return {
        result,
        cancel: async () => {
          cancelCount += 1;
          rejectResult(
            new PreviewRecipeGenerationRunError('CANCELED', 'canceled')
          );
        }
      };
    });

    const generation = service.generate({ taskId: 'task-1', worktreePath: root });
    await started;
    const discard = service.discard('task-1');
    await Promise.all([discard, service.shutdown()]);

    expect(cancelCount).toBe(1);
    expect((await generation).status).toBe('EMPTY');
    expect(service.get('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
  });

  it('keeps recovery evidence when cancellation races provider startup and cannot be confirmed', async () => {
    const root = await previewWorktree();
    const evidenceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'preview-cancel-recovery-test-')
    );
    roots.push(evidenceRoot);
    let signalRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      signalRunnerStarted = resolve;
    });
    let releaseRunner!: () => void;
    const runnerRelease = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const service = new PreviewRecipeGenerationService(async () => {
      signalRunnerStarted();
      await runnerRelease;
      return {
        result: new Promise<string>(() => {}),
        cancel: async () => {
          throw new PreviewRecipeGenerationRunError(
            'TERMINATION_UNCONFIRMED',
            'The provider stop result is uncertain.'
          );
        }
      };
    }, evidenceRoot);

    const generation = service.generate({ taskId: 'task-1', worktreePath: root });
    await runnerStarted;
    const discard = service.discard('task-1');
    releaseRunner();

    await expect(discard).rejects.toThrow('provider stop result is uncertain');
    await expect(generation).resolves.toMatchObject({
      status: 'FAILED',
      failureCode: 'CANCELLATION_UNCONFIRMED'
    });
    expect(await fs.readdir(evidenceRoot)).toHaveLength(1);

    await service.recoverEvidence();
    expect(await fs.readdir(evidenceRoot)).toEqual([]);
  });
});

async function previewWorktree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-generation-test-'));
  roots.push(root);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'server.mjs'),
    'import http from "node:http"; http.createServer().listen(Number(process.env.PORT));\n',
    'utf8'
  );
  await fs.writeFile(path.join(root, '.env.local'), 'API_TOKEN=plaintext-canary\n', 'utf8');
  return root;
}

async function nextWorktree(
  script = 'next dev --turbopack --experimental-https -p 8000',
  version = '^16.1.6'
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-next-generation-test-'));
  roots.push(root);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      dependencies: { next: version },
      scripts: { dev: script }
    }),
    'utf8'
  );
  const lockedVersion = version.startsWith('^16') || version.startsWith('~16')
    ? '16.2.3'
    : version.startsWith('^15') || version.startsWith('~15')
      ? '15.5.2'
      : version.replace(/^[~^]/, '');
  await fs.writeFile(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      name: 'preview-next-fixture',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { next: version } },
        'node_modules/next': { version: lockedVersion }
      },
      ignoredPadding: 'x'.repeat(400 * 1024)
    }),
    'utf8'
  );
  return root;
}

async function nextWorktreeWithPublicApi(): Promise<string> {
  const root = await nextWorktree('next dev --turbopack', '16.2.3');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(
    path.join(root, 'src', 'heyapi.ts'),
    "export const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'https://api.dev.example';\n",
    'utf8'
  );
  return root;
}

function agentDraft(): string {
  return JSON.stringify({
    schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
    status: 'draft',
    yaml: `name: application
type: environment
primary: web

services:
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    ports:
      http: PORT
    # No health endpoint was evidenced, so readiness checks only the listener.
    ready: { type: tcp, port: http }

`,
    summary: 'Runs the proven Node entry point behind one stable route.',
    evidence: [
      { path: 'package.json', finding: 'The dev script runs node server.mjs.' },
      { path: 'server.mjs', finding: 'The server listens on the injected PORT value.' }
    ],
    assumptions: [],
    omissions: ['No health endpoint was evidenced.'],
    unresolvedDecisions: [],
    publicEnvironmentDecisions: []
  });
}

function nextAgentDraft(
  command = '[./node_modules/.bin/next, dev, --turbopack, --hostname, 127.0.0.1]',
  comment = nextCompatibilityComment(),
  options: {
    includeInstall?: boolean;
    includeInstallNeed?: boolean;
    includeInstallComment?: boolean;
  } = {}
): string {
  const includeInstall = options.includeInstall ?? true;
  const install = includeInstall
    ? `  install:
    type: job
    cwd: .
${options.includeInstallComment === false ? '' : `${nextInstallComment()}\n`}    command: [npm, ci, --no-audit, --no-fund]
`
    : '';
  const installNeed = includeInstall && options.includeInstallNeed !== false
    ? '    dependsOn: [install]\n'
    : '';
  return JSON.stringify({
    schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
    status: 'draft',
    yaml: `name: application
type: environment
primary: web
services:
${install}
  web:
    type: command
    cwd: .
${comment}${comment ? '\n' : ''}    command: ${command}
${installNeed}    ports: { http: PORT }
    ready: { type: tcp, port: http }
`,
    summary: 'Runs Next.js through the trusted Preview-compatible HTTP command.',
    evidence: [
      { path: 'package.json', finding: 'The repository declares a supported Next.js dev script.' },
      { path: 'package-lock.json', finding: 'Trusted lockfile facts prove deterministic npm installation.' }
    ],
    assumptions: [],
    omissions: [],
    unresolvedDecisions: [],
    publicEnvironmentDecisions: []
  });
}

function publicApiAgentDraft(decisionAttachmentId = 'backend'): string {
  const base = JSON.parse(nextAgentDraft('[npm, run, dev]', '')) as Record<string, unknown>;
  base.yaml = `name: application
type: environment
primary: web

services:
  install:
    type: job
    cwd: .
${nextInstallComment()}
    command: [npm, ci, --no-audit, --no-fund]

  backend:
    type: attach
    check: false
  web:
    type: command
    cwd: .
    command: [npm, run, dev]
    dependsOn: [install]
    env:
      NEXT_PUBLIC_API_URL: { service: backend }
    ports: { http: PORT }
    ready: { type: tcp, port: http }

`;
  base.publicEnvironmentDecisions = [{
    candidateId: 'next-public:NEXT_PUBLIC_API_URL',
    key: 'NEXT_PUBLIC_API_URL',
    decision: 'HTTP_ATTACHMENT',
    reason: 'The browser API origin must be selected explicitly.',
    attachmentId: decisionAttachmentId
  }];
  return JSON.stringify(base);
}

function publicApiAgentDraftWithMixedRecipient(): string {
  const draft = JSON.parse(publicApiAgentDraft()) as Record<string, unknown>;
  draft.yaml = `${draft.yaml}
  monitor:
    type: worker
    cwd: .
    command: [node, monitor.mjs]
    env:
      NEXT_PUBLIC_API_URL: https://different.example
    ready: { type: command, command: [node, monitor-ready.mjs] }
`;
  return JSON.stringify(draft);
}

function nextInstallComment(): string {
  return [
    '    # Installs exactly from package-lock.json in this live worktree.',
    '    # npm may run repository and dependency lifecycle scripts.'
  ].join('\n');
}

function nextCompatibilityComment(): string {
  return [
    "    # The repository's existing development script pins port 8000 and enables",
    '    # HTTPS. This Preview command intentionally uses standard HTTP and',
    "    # Previewhost's dynamically allocated port."
  ].join('\n');
}
