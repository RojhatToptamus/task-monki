import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexEphemeralRunError } from '../../agent/codex/CodexEphemeralReadOnlyRunner';
import {
  PreviewRecipeGenerationService,
  validatePreviewRecipeDraft
} from './PreviewRecipeGenerationService';
import { PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION } from './PreviewRecipeGenerationSupport';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('PreviewRecipeGenerationService', () => {
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
      worktreePath: root,
      model: 'gpt-test'
    });

    expect(generated.status).toBe('READY');
    expect(generated.draft?.validation).toEqual({ status: 'VALID' });
    expect(evidenceBundle).toContain('package.json');
    expect(evidenceBundle).not.toContain('.env.local');
    await expect(fs.access(path.join(root, '.taskmonki', 'preview.yaml'))).rejects.toThrow();

    await service.writeAcceptedRecipe({
      taskId: 'task-1',
      draftId: generated.draft!.id,
      yaml: generated.draft!.yaml,
      worktreePath: root
    });

    expect(await fs.readFile(path.join(root, '.taskmonki', 'preview.yaml'), 'utf8')).toBe(
      generated.draft!.yaml
    );
    expect(await fs.readdir(path.join(root, '.taskmonki'))).toEqual(['preview.yaml']);
    expect(service.completeAcceptance('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
  });

  it('never overwrites a manual recipe that appears while a draft is reviewed', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(agentDraft()),
      cancel: async () => {}
    }));
    const generated = await service.generate({ taskId: 'task-1', worktreePath: root });
    await fs.mkdir(path.join(root, '.taskmonki'));
    await fs.writeFile(path.join(root, '.taskmonki', 'preview.yaml'), 'manual\n', 'utf8');

    await expect(
      service.writeAcceptedRecipe({
        taskId: 'task-1',
        draftId: generated.draft!.id,
        yaml: generated.draft!.yaml,
        worktreePath: root
      })
    ).rejects.toThrow('appeared while this draft was under review');
    expect(await fs.readFile(path.join(root, '.taskmonki', 'preview.yaml'), 'utf8')).toBe(
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
    await expect(fs.access(path.join(root, '.taskmonki', 'preview.yaml'))).rejects.toThrow();

    const regenerated = await service.generate({ taskId: 'task-1', worktreePath: root });
    expect(regenerated.status).toBe('READY');
    expect(regenerated.draft!.id).not.toBe(first.draft!.id);
    await expect(fs.access(path.join(root, '.taskmonki', 'preview.yaml'))).rejects.toThrow();

    await expect(service.discard('task-1')).resolves.toEqual({
      taskId: 'task-1',
      status: 'EMPTY'
    });
    await expect(fs.access(path.join(root, '.taskmonki', 'preview.yaml'))).rejects.toThrow();
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
    await expect(fs.access(path.join(root, '.taskmonki', 'preview.yaml'))).rejects.toThrow();
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
      expect(instruction).toContain('exactly one generic finite job');
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
    expect(result.draft?.yaml).toContain('type: attached-http-origin');
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
    const service = new PreviewRecipeGenerationService(async () => ({
      result: Promise.resolve(
        publicApiAgentDraft().replace(
          'target: { type: local }',
          'target: { type: endpoint, scheme: https, host: api.staging.example, port: 443, basePath: / }'
        )
      ),
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
    const edited = generated.draft!.yaml.replace('    needs: { install: succeeded }\n', '');

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
    await expect(fs.access(path.join(root, '.taskmonki', 'preview.yaml'))).rejects.toThrow();
  });

  it('rejects literal secret-like environment delivery before acceptance', () => {
    expect(validatePreviewRecipeDraft(`version: 1
services:
  web:
    command: [node, server.mjs]
    env: { API_TOKEN: plaintext-canary }
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }
routes:
  app: { service: web, port: http, primary: true }
`)).toEqual({
      status: 'INVALID',
      issues: [{
        code: 'SECRET_LITERAL',
        message: 'Secret-like environment keys must use a private input reference, never a literal value.'
      }]
    });

    expect(validatePreviewRecipeDraft(`version: 1
# token = "hardcoded-token-canary"
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }
routes:
  app: { service: web, port: http, primary: true }
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
    let canceled = false;
    const result = new Promise<string>((_resolve, reject) => {
      rejectResult = reject;
    });
    const service = new PreviewRecipeGenerationService(async () => {
      signalStarted();
      return {
        result,
        cancel: async () => {
          canceled = true;
          rejectResult(new CodexEphemeralRunError('CANCELED', 'canceled'));
        }
      };
    });

    const generation = service.generate({ taskId: 'task-1', worktreePath: root });
    await started;
    await service.shutdown();

    expect(canceled).toBe(true);
    expect((await generation).status).toBe('EMPTY');
    expect(service.get('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
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
  await fs.writeFile(path.join(root, 'server.mjs'), 'console.log("server")\n', 'utf8');
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
    yaml: `version: 1

services:
  web:
    command: [node, server.mjs]
    ports:
      http: { env: PORT }
    # No health endpoint was evidenced, so readiness checks only the listener.
    ready: { type: tcp, port: http }

routes:
  app: { service: web, port: http, primary: true }
`,
    summary: 'Runs the proven Node entry point behind one stable route.',
    evidence: [
      { path: 'package.json', finding: 'The dev script runs node server.mjs.' },
      { path: 'server.mjs', finding: 'The repository contains the declared entry point.' }
    ],
    assumptions: ['The application reads the generated PORT environment variable.'],
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
    ? `jobs:
  install:
${options.includeInstallComment === false ? '' : `${nextInstallComment()}\n`}    command: [npm, ci, --no-audit, --no-fund]
`
    : '';
  const installNeed = includeInstall && options.includeInstallNeed !== false
    ? '    needs: { install: succeeded }\n'
    : '';
  return JSON.stringify({
    schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
    status: 'draft',
    yaml: `version: 1
${install}
services:
  web:
${comment}${comment ? '\n' : ''}    command: ${command}
${installNeed}    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }
routes:
  app: { service: web, port: http, primary: true }
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
  base.yaml = `version: 1

jobs:
  install:
${nextInstallComment()}
    command: [npm, ci, --no-audit, --no-fund]

attachments:
  backend:
    type: http
    target: { type: local }

services:
  web:
    command: [npm, run, dev]
    needs: { install: succeeded }
    env:
      NEXT_PUBLIC_API_URL: { type: attached-http-origin, attachment: backend }
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }

routes:
  app: { service: web, port: http, primary: true }
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
  draft.yaml = (draft.yaml as string).replace(
    '\nroutes:',
    `
workers:
  monitor:
    command: [node, monitor.mjs]
    env:
      NEXT_PUBLIC_API_URL: https://different.example
    ready: { type: argv, command: [node, monitor-ready.mjs] }

routes:`
  );
  return JSON.stringify(draft);
}

function nextInstallComment(): string {
  return [
    '    # Installs exactly from package-lock.json inside this captured Preview generation.',
    '    # npm may run repository and dependency lifecycle scripts.'
  ].join('\n');
}

function nextCompatibilityComment(): string {
  return [
    "    # The repository's existing development script pins port 8000 and enables",
    '    # HTTPS. This Preview command intentionally uses standard HTTP and Task',
    "    # Monki's dynamically allocated port."
  ].join('\n');
}
