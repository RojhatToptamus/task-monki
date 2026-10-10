import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPreviewSpec } from 'previewhost';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PreviewRecipeGenerationService,
  validatePreviewRecipeDraft,
  type PreviewRecipeProposal
} from './PreviewRecipeGenerationService';

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

  it.each([
    'name: !!str application\ntype: static\ndirectory: .\n',
    '%YAML 1.1\n---\nname: application\ntype: static\ndirectory: .\n'
  ])('rejects YAML that the runtime loader cannot start and names the reason', async (yaml) => {
    const root = await previewWorktree();
    const file = path.join(root, 'preview.yaml');
    await fs.writeFile(file, yaml);
    await expect(loadPreviewSpec(file)).rejects.toThrow();
    expect(validatePreviewRecipeDraft(yaml)).toMatchObject({
      status: 'INVALID', issues: [{ code: 'INVALID_RECIPE', message: expect.stringContaining('The YAML does not match the Preview contract: ') }]
    });
  });

  it('tells the author which field the Preview contract rejected', () => {
    const validation = validatePreviewRecipeDraft('name: application\ntype: command\ncwd: .\ncommand: node server.mjs\n');
    expect(validation.status).toBe('INVALID');
    if (validation.status === 'INVALID') expect(validation.issues[0]!.message).toMatch(/command/);
  });

  it('rejects literal secret-like environment delivery wherever a command runs', () => {
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
      // The message names the service and key so the author can fix it, and never repeats the value.
      issues: [{ code: 'SECRET_LITERAL', message: 'Use a secret reference for web API_TOKEN: secret-like environment keys never take a literal value.' }]
    });
    expect(validatePreviewRecipeDraft(`name: application
type: environment
primary: web
services:
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    ports: { http: PORT }
    ready: { type: tcp, port: http }
    liveness:
      probe: { type: command, command: [node, probe.mjs], env: { DATABASE_PASSWORD: plaintext-canary } }
      intervalMs: 5000
      failureThreshold: 3
`)).toMatchObject({ status: 'INVALID', issues: [{ code: 'SECRET_LITERAL' }] });
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
`)).toMatchObject({ status: 'INVALID', issues: [{ code: 'SECRET_LITERAL' }] });
  });

  it('rejects runtime identities in portable project YAML', () => {
    expect(validatePreviewRecipeDraft('name: tm-9551c62b-2f45-45b7-9563-e714183e2a0f\ntype: static\ndirectory: .\n')).toMatchObject({ status: 'INVALID' });
  });

  it('keeps a valid proposal transient until exact acceptance', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService();
    const result = await service.propose(proposal(root));
    expect(result.status).toBe('READY');
    if (result.status !== 'READY') return;
    expect(result.draft).toMatchObject({
      taskId: 'task-1',
      fileName: 'preview.yaml',
      replacesExistingFile: false,
      validation: { status: 'VALID' },
      report: { summary: 'Runs the Node entry point behind one route.', notes: ['No health endpoint was evidenced.'] }
    });
    expect(service.get('task-1')).toEqual({ taskId: 'task-1', status: 'READY', draft: result.draft });
    expect(service.reviewedFile('task-1', result.draft.id)).toBeUndefined();
    expect(service.validate('task-1', result.draft.id, result.draft.yaml)).toEqual({ status: 'VALID' });
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();

    expect(await service.writeAcceptedRecipe({ taskId: 'task-1', draftId: result.draft.id, yaml: result.draft.yaml, worktreePath: root })).toBe('preview.yaml');
    expect(await fs.readFile(path.join(root, 'preview.yaml'), 'utf8')).toBe(result.draft.yaml);
    expect(service.completeAcceptance('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
    expect(() => service.validate('task-1', result.draft.id, result.draft.yaml)).toThrow('no longer current');
  });

  it('returns the exact problems of a rejected proposal and keeps the previous draft', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService();
    const first = await service.propose(proposal(root));
    expect(first.status).toBe('READY');
    const rejected = await service.propose({ ...proposal(root), yaml: 'name: application\ntype: static\n' });
    expect(rejected).toMatchObject({ status: 'INVALID', issues: [{ code: 'INVALID_RECIPE', message: expect.stringContaining('directory') }] });
    expect(service.get('task-1').draft?.id).toBe(first.status === 'READY' ? first.draft.id : undefined);
  });

  it('rejects secret-like text in the summary or notes', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService();
    await expect(service.propose({ ...proposal(root), notes: ['Set token: "plaintext-canary-value" in the environment.'] })).resolves.toMatchObject({
      status: 'INVALID', issues: [{ code: 'SECRET_LITERAL' }]
    });
  });

  it('never overwrites a manual recipe that appears while a draft is reviewed', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService();
    const result = await service.propose(proposal(root));
    if (result.status !== 'READY') throw new Error(result.status);
    await fs.writeFile(path.join(root, 'preview.yaml'), 'manual\n', 'utf8');
    await expect(service.writeAcceptedRecipe({ taskId: 'task-1', draftId: result.draft.id, yaml: result.draft.yaml, worktreePath: root })).rejects.toThrow('already exists');
    expect(await fs.readFile(path.join(root, 'preview.yaml'), 'utf8')).toBe('manual\n');
  });

  it('replaces an existing file only from the reviewed bytes and never across worktrees', async () => {
    const root = await previewWorktree();
    const original = 'name: application\ntype: command\ncwd: .\ncommand: [node, missing.cjs]\n';
    await fs.writeFile(path.join(root, 'preview.yml'), original);
    const service = new PreviewRecipeGenerationService();
    const result = await service.propose({ ...proposal(root), taskId: 'repair' });
    if (result.status !== 'READY') throw new Error(result.status);
    expect(result.draft).toMatchObject({ fileName: 'preview.yml', replacesExistingFile: true });
    expect(service.reviewedFile('repair', result.draft.id)).toEqual({ name: 'preview.yml', text: original });
    const save = { taskId: 'repair', draftId: result.draft.id, yaml: result.draft.yaml, worktreePath: root };
    await expect(service.writeAcceptedRecipe({ ...save, worktreePath: await previewWorktree() })).rejects.toThrow('worktree changed');
    await fs.appendFile(path.join(root, 'preview.yml'), '# user edit\n');
    await expect(service.writeAcceptedRecipe(save)).rejects.toThrow('changed');
    expect(await fs.readFile(path.join(root, 'preview.yml'), 'utf8')).toContain('# user edit');
    const fresh = await service.propose({ ...proposal(root), taskId: 'repair' });
    if (fresh.status !== 'READY') throw new Error(fresh.status);
    expect(fresh.draft.id).not.toBe(result.draft.id);
    expect(() => service.validate('repair', result.draft.id, result.draft.yaml)).toThrow('no longer current');
    expect(await service.writeAcceptedRecipe({ ...save, draftId: fresh.draft.id, yaml: fresh.draft.yaml })).toBe('preview.yml');
    expect(await fs.readFile(path.join(root, 'preview.yml'), 'utf8')).toBe(fresh.draft.yaml);
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();
  });

  it('holds Next.js proposals to the trusted compatible command and lockfile installation job', async () => {
    const root = await nextWorktree();
    const service = new PreviewRecipeGenerationService();
    const propose = (yaml: string) => service.propose({ taskId: 'task-next', worktreePath: root, yaml, summary: 'Runs Next.js.', notes: [] });

    const script = await propose(nextYaml('[npm, run, dev]', ''));
    expect(script).toMatchObject({ status: 'INVALID', issues: [{ code: 'INCOMPATIBLE_COMMAND', message: expect.stringContaining('./node_modules/.bin/next, dev, --turbopack, --hostname, 127.0.0.1') }] });

    const fixedPort = await propose(nextYaml('[./node_modules/.bin/next, dev, -p, "3000"]', ''));
    expect(fixedPort).toMatchObject({ status: 'INVALID', issues: [{ code: 'INCOMPATIBLE_COMMAND' }] });

    const noInstall = await propose(nextYaml(COMPATIBLE_NEXT_COMMAND, nextCompatibilityComment(), { includeInstall: false }));
    expect(noInstall).toMatchObject({ status: 'INVALID', issues: [{ code: 'DEPENDENCY_PREPARATION_REQUIRED', message: expect.stringContaining('npm, ci, --no-audit, --no-fund') }] });

    const noComment = await propose(nextYaml(COMPATIBLE_NEXT_COMMAND, ''));
    expect(noComment).toMatchObject({ status: 'INVALID', issues: [{ code: 'INCOMPATIBLE_COMMAND', message: expect.stringContaining('Keep this comment') }] });

    const accepted = await propose(nextYaml(COMPATIBLE_NEXT_COMMAND, nextCompatibilityComment()));
    expect(accepted.status).toBe('READY');
    if (accepted.status !== 'READY') return;
    const edited = accepted.draft.yaml.replace('    dependsOn: [install]\n', '');
    expect(service.validate('task-next', accepted.draft.id, edited)).toMatchObject({ status: 'INVALID', issues: [{ code: 'DEPENDENCY_PREPARATION_REQUIRED' }] });
    await expect(service.writeAcceptedRecipe({ taskId: 'task-next', draftId: accepted.draft.id, yaml: edited, worktreePath: root })).rejects.toThrow('dependsOn');
    await expect(fs.access(path.join(root, 'preview.yaml'))).rejects.toThrow();
  });

  it('accepts the standard Next.js script when it already consumes the allocated port', async () => {
    const root = await nextWorktree('next dev --turbopack', '15.5.2');
    const service = new PreviewRecipeGenerationService();
    await expect(service.propose({ taskId: 'task-next', worktreePath: root, yaml: nextYaml('[npm, run, dev]', ''), summary: 'Runs Next.js.', notes: [] }))
      .resolves.toMatchObject({ status: 'READY' });
  });

  it('rejects implicit package acquisition even when the command is otherwise valid YAML', async () => {
    const root = await nextWorktree();
    const service = new PreviewRecipeGenerationService();
    await expect(service.propose({
      taskId: 'task-next', worktreePath: root, summary: 'Runs Next.js.', notes: [],
      yaml: nextYaml('[npm, exec, --offline, --, next, dev, --turbopack, --hostname, 127.0.0.1]', nextCompatibilityComment())
    })).resolves.toMatchObject({ status: 'INVALID', issues: [{ message: expect.stringContaining('implicit npm exec') }] });
  });

  it('forgets drafts on discard, task removal, and shutdown', async () => {
    const root = await previewWorktree();
    const service = new PreviewRecipeGenerationService();
    const first = await service.propose(proposal(root));
    expect(service.discard('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
    if (first.status === 'READY') expect(() => service.reviewedFile('task-1', first.draft.id)).toThrow('no longer current');
    await service.propose(proposal(root));
    service.clearTask('task-1');
    expect(service.get('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
    await service.propose(proposal(root));
    service.shutdown();
    expect(service.get('task-1')).toEqual({ taskId: 'task-1', status: 'EMPTY' });
  });
});

async function previewWorktree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-proposal-test-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }), 'utf8');
  await fs.writeFile(path.join(root, 'server.mjs'), 'import http from "node:http"; http.createServer().listen(Number(process.env.PORT));\n', 'utf8');
  await fs.writeFile(path.join(root, '.env.local'), 'API_TOKEN=plaintext-canary\n', 'utf8');
  return root;
}

async function nextWorktree(script = 'next dev --turbopack --experimental-https -p 8000', version = '^16.1.6'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-next-proposal-test-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: version }, scripts: { dev: script } }), 'utf8');
  const lockedVersion = version.startsWith('^16') || version.startsWith('~16') ? '16.2.3'
    : version.startsWith('^15') || version.startsWith('~15') ? '15.5.2' : version.replace(/^[~^]/, '');
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'preview-next-fixture', lockfileVersion: 3,
    packages: { '': { dependencies: { next: version } }, 'node_modules/next': { version: lockedVersion } }
  }), 'utf8');
  return root;
}

function proposal(worktreePath: string): PreviewRecipeProposal {
  return {
    taskId: 'task-1',
    worktreePath,
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
    summary: 'Runs the Node entry point behind one route.',
    notes: ['No health endpoint was evidenced.']
  };
}

const COMPATIBLE_NEXT_COMMAND = '[./node_modules/.bin/next, dev, --turbopack, --hostname, 127.0.0.1]';

function nextYaml(command: string, comment: string, options: { includeInstall?: boolean } = {}): string {
  const install = options.includeInstall === false ? '' : `  install:
    type: job
    cwd: .
${nextInstallComment()}
    command: [npm, ci, --no-audit, --no-fund]
`;
  const dependsOn = options.includeInstall === false ? '' : '    dependsOn: [install]\n';
  return `name: application
type: environment
primary: web
services:
${install}
  web:
    type: command
    cwd: .
${comment}${comment ? '\n' : ''}    command: ${command}
${dependsOn}    ports: { http: PORT }
    ready: { type: tcp, port: http }
`;
}

function nextInstallComment(): string {
  return [
    '    # Installs exactly from package-lock.json in this live worktree.',
    '    # npm may run repository and dependency lifecycle scripts.',
    '    # Reinstallation changes this live folder and can interrupt a serving app.'
  ].join('\n');
}

function nextCompatibilityComment(): string {
  return [
    "    # The repository's existing development script pins port 8000 and enables",
    '    # HTTPS. This Preview command intentionally uses standard HTTP and',
    "    # Previewhost's dynamically allocated port."
  ].join('\n');
}
