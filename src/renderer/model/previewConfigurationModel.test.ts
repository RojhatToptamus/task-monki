import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { PreviewDescription } from 'previewhost';
import {
  configurationDiff,
  configurationOverview,
  describedEntries,
  describedSecrets,
  folderLabel,
  waitsForManagedData,
  formatCommand,
  parseCommand,
  readConfiguration,
  removeEnvironmentBinding,
  renameEnvironmentBinding,
  setEntryField,
  setEnvironmentBinding
} from './previewConfigurationModel';

const file = `# Competitions preview
name: competitions
type: environment
primary: frontend
services:
  frontend:
    type: command
    cwd: .
    dependsOn: [frontend-build, backend]
    command: [npm, run, start]
    readyPath: /
    env:
      NEXT_PUBLIC_API_URL: { service: backend }

  backend-migrate:   # schema first
    type: job
    cwd: ../competitions-backend
    run: once
    dependsOn: [backend-install, database]
    command: [npx, prisma, migrate, deploy]
    env:
      DATABASE_URL: {service: database}
  frontend-build:
    type: job
    cwd: .
    dependsOn:
    - frontend-install
    command: [npm, run, build]
  backend-install:
    type: job
    cwd: ../competitions-backend
    command: [npm, ci]
  frontend-install:
    type: job
    cwd: .
    command: [npm, ci]
  backend:
    type: command
    cwd: ../competitions-backend
    dependsOn: [backend-migrate]
    command: [node, dist/main.js]
    readyPath: /health
    timeoutMs: 120000
    env:
      DATABASE_URL: {service: database}
      JWT_SECRET: {secret: competitions/dev/jwt}   # rotate monthly
      GOOGLE_CLIENT_ID: {secret: competitions/dev/google-client}
      NODE_ENV: development
  database:
    type: postgres
`;

const changedLines = (before: string, after: string) => {
  const left = before.split('\n');
  const right = after.split('\n');
  return right.filter((line, index) => line !== left[index]);
};

describe('reading the configuration', () => {
  it('groups entries by kind and orders setup steps by what they wait for, keeping file order otherwise', () => {
    const overview = configurationOverview(readConfiguration(file)!);
    expect(overview.services.map((entry) => entry.id)).toEqual(['frontend', 'backend']);
    expect(overview.databases.map((entry) => entry.id)).toEqual(['database']);
    expect(overview.steps.map((entry) => entry.id)).toEqual(['backend-install', 'backend-migrate', 'frontend-install', 'frontend-build']);
    expect(overview.folders).toEqual([
      { path: '.', entries: ['frontend', 'frontend-build', 'frontend-install'] },
      { path: '../competitions-backend', entries: ['backend-migrate', 'backend-install', 'backend'] }
    ]);
    expect(overview.secrets).toEqual([
      { id: 'competitions/dev/jwt', uses: [{ entry: 'backend', key: 'JWT_SECRET' }] },
      { id: 'competitions/dev/google-client', uses: [{ entry: 'backend', key: 'GOOGLE_CLIENT_ID' }] }
    ]);
    const backend = overview.services[1]!;
    expect(backend.environment.map((binding) => [binding.key, binding.kind, binding.value])).toEqual([
      ['DATABASE_URL', 'service', 'database'],
      ['JWT_SECRET', 'secret', 'competitions/dev/jwt'],
      ['GOOGLE_CLIENT_ID', 'secret', 'competitions/dev/google-client'],
      ['NODE_ENV', 'text', 'development']
    ]);
    expect(backend.other).toEqual([['timeoutMs', 120000]]);
  });

  it('allows a step to run once only when it waits, directly or through others, for a managed database', () => {
    const entries = readConfiguration(file)!;
    const step = (id: string) => entries.find((entry) => entry.id === id)!;
    expect(waitsForManagedData(step('backend-migrate'), entries)).toBe(true);
    expect(waitsForManagedData(step('backend-install'), entries)).toBe(false);
    expect(waitsForManagedData(step('frontend'), entries)).toBe(true);
  });

  it('keeps a dependency cycle visible in file order instead of dropping steps', () => {
    const cycle = 'type: environment\nprimary: a\nservices:\n  a: {type: job, cwd: ., command: [a], dependsOn: [b]}\n  b: {type: job, cwd: ., command: [b], dependsOn: [a]}\n';
    expect(configurationOverview(readConfiguration(cycle)!).steps.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('reads a single-application file as one entry and refuses text that does not parse', () => {
    const [entry] = readConfiguration('name: fixture\ntype: command\ncwd: .\ncommand: [node, server.js]\n')!;
    expect(entry).toMatchObject({ id: 'fixture', path: [], group: 'Services', command: ['node', 'server.js'], other: [] });
    expect(readConfiguration('services: [unclosed')).toBeUndefined();
  });

  it('names folders for the person: the worktree, a folder inside it, or an outside folder by name', () => {
    expect(folderLabel('.')).toEqual({ name: 'Task worktree', root: true, external: false });
    expect(folderLabel('./web/')).toEqual({ name: 'web', root: false, external: false });
    expect(folderLabel('../competitions-backend')).toEqual({ name: 'competitions-backend', root: false, external: true });
    expect(folderLabel('/project', '/project')).toMatchObject({ root: true });
    expect(folderLabel('/project/web', '/project')).toEqual({ name: 'web', root: false, external: false });
    expect(folderLabel('/Users/me/backend', '/project')).toEqual({ name: 'backend', root: false, external: true });
  });

  it('reads a past run from the redacted description without inventing environment values', () => {
    const description = {
      spec: {
        name: 'fixture', type: 'environment', primary: 'web', timeoutMs: 1000,
        services: {
          web: { type: 'command', cwd: '/project', command: ['npm', 'start'], envKeys: ['NODE_ENV'], bindings: { TOKEN: { secret: 'fixture/token' } },
            ready: { type: 'command', command: ['curl', 'localhost'], cwd: '/project/tools', timeoutMs: 1 } },
          migrate: { type: 'job', cwd: '/other/api', command: ['migrate'], run: 'once' }
        }
      },
      envKeys: [], secrets: [{ id: 'fixture/token', selected: true, bindings: [{ service: 'web', key: 'TOKEN' }] }],
      source: 'live-directories-and-dependencies', cleanup: 'owned-apps-and-containers-data-retained'
    } as unknown as PreviewDescription;
    const entries = describedEntries(description);
    expect(entries.map((entry) => entry.id)).toEqual(['web', 'web · readiness', 'migrate']);
    expect(entries[0]!.environment).toEqual([
      { key: 'NODE_ENV', kind: 'text', value: '' },
      { key: 'TOKEN', kind: 'secret', value: 'fixture/token' }
    ]);
    const overview = configurationOverview(entries, describedSecrets(description));
    expect(overview.steps[0]!.run).toBe('once');
    expect(overview.folders.map((folder) => folder.path)).toEqual(['/project', '/project/tools', '/other/api']);
    expect(overview.secrets).toEqual([{ id: 'fixture/token', uses: [{ entry: 'web', key: 'TOKEN' }] }]);
  });
});

describe('commands as one line', () => {
  it.each([
    [['npm', 'run', 'dev']],
    [['node', '-e', 'console.log("hi there")']],
    [['sh', 'path with spaces/run.sh', '--flag=a b', 'tab\there']],
    [['echo', '', '"quoted"', 'a"b']],
    [['printf', 'back\\slash and space']]
  ])('round-trips %j through the editable text', (command) => {
    expect(parseCommand(formatCommand(command))).toEqual({ command });
  });

  it('reads the shared display form back, where JSON quotes only arguments with whitespace', () => {
    expect(parseCommand('node -e "console.log(\\"a b\\")" --port={port}')).toEqual({ command: ['node', '-e', 'console.log("a b")', '--port={port}'] });
  });

  it('refuses text that is not a command instead of guessing', () => {
    expect(parseCommand('node "unclosed')).toEqual({ error: 'Close the quoted argument.' });
    expect(parseCommand('node "a"b')).toEqual({ error: 'Put a space after a quoted argument.' });
    expect(parseCommand('node "bad \\q"')).toMatchObject({ error: expect.stringContaining('JSON escapes') });
    expect(parseCommand('   ')).toEqual({ error: 'Enter a command.' });
  });
});

describe('typed edits', () => {
  it('changes one field and leaves every other line, comment and spacing exactly as written', () => {
    const next = setEntryField(file, ['services', 'backend'], 'command', ['node', 'dist/main.js', '--inspect']);
    expect(changedLines(file, next)).toEqual(['    command: [node, dist/main.js, --inspect]']);
    const folder = setEntryField(file, ['services', 'backend-migrate'], 'cwd', '../api with space');
    expect(changedLines(file, folder)).toEqual(['    cwd: ../api with space']);
    expect(folder).toContain('backend-migrate:   # schema first');
  });

  it('writes dependencies in the list style already used and removes the field when emptied', () => {
    const flow = setEntryField(file, ['services', 'frontend'], 'dependsOn', ['backend']);
    expect(changedLines(file, flow)).toEqual(['    dependsOn: [backend]']);
    const block = setEntryField(file, ['services', 'frontend-build'], 'dependsOn', ['frontend-install', 'backend-install']);
    expect(parse(block).services['frontend-build'].dependsOn).toEqual(['frontend-install', 'backend-install']);
    expect(block).toContain('    dependsOn:\n    - frontend-install\n    - backend-install\n');
    const removed = setEntryField(file, ['services', 'frontend'], 'dependsOn', undefined);
    expect(parse(removed).services.frontend.dependsOn).toBeUndefined();
    expect(file.split('\n').length - removed.split('\n').length).toBe(1);
  });

  it('switches a step between every start and once', () => {
    const next = setEntryField(file, ['services', 'backend-migrate'], 'run', 'always');
    expect(changedLines(file, next)).toEqual(['    run: always']);
    const added = setEntryField(file, ['services', 'backend-install'], 'run', 'once');
    expect(parse(added).services['backend-install'].run).toBe('once');
  });

  it('edits environment bindings by kind, keeps neighbouring comments, and never touches other references', () => {
    const secret = setEnvironmentBinding(file, ['services', 'backend'], 'NODE_ENV', { secret: 'competitions/dev/node-env' });
    expect(changedLines(file, secret)).toEqual(['      NODE_ENV: {secret: competitions/dev/node-env}']);
    expect(secret).toContain('JWT_SECRET: {secret: competitions/dev/jwt}   # rotate monthly');
    const text = setEnvironmentBinding(file, ['services', 'backend'], 'JWT_SECRET', 'literal');
    expect(parse(text).services.backend.env.JWT_SECRET).toBe('literal');
    expect(text).toContain('# rotate monthly');
    const service = setEnvironmentBinding(file, ['services', 'frontend'], 'NEXT_PUBLIC_API_URL', { service: 'database' });
    expect(changedLines(file, service)).toEqual(['      NEXT_PUBLIC_API_URL: {service: database}']);
    const added = setEnvironmentBinding(file, ['services', 'frontend-install'], 'NPM_TOKEN', { secret: 'competitions/dev/npm' });
    expect(parse(added).services['frontend-install'].env).toEqual({ NPM_TOKEN: { secret: 'competitions/dev/npm' } });
    expect(parse(added).services.backend.env.JWT_SECRET).toEqual({ secret: 'competitions/dev/jwt' });
  });

  it('writes new lines in the bracket spacing the file already uses for that kind of collection', () => {
    const padded = 'type: environment\nprimary: web\nservices:\n  web:\n    type: command\n    cwd: .\n    command: [npm, start]\n    env:\n      API: { service: api }\n  api:\n    type: command\n    cwd: .\n    command: [node, api.js]\n';
    const secret = setEnvironmentBinding(padded, ['services', 'web'], 'TOKEN', { secret: 'web/token' });
    expect(secret).toBe(padded.replace('{ service: api }\n', '{ service: api }\n      TOKEN: { secret: web/token }\n'));
    expect(setEntryField(padded, ['services', 'web'], 'dependsOn', ['api'])).toBe(padded.replace('{ service: api }\n', '{ service: api }\n    dependsOn: [api]\n'));
    expect(renameEnvironmentBinding(padded, ['services', 'web'], 'API', 'API_URL')).toBe(padded.replace('API: {', 'API_URL: {'));
  });

  it('keeps the spacing of a neighbouring line the person formatted differently when the edit touches the line above it', () => {
    const spaced = 'name: x\ntype: command\ncwd: .\ncommand: [node, a.js]\nenv:\n  A: b   # first\n  C: {secret: x/c}   # second\n';
    expect(setEnvironmentBinding(spaced, [], 'A', { secret: 'x/a' })).toBe(spaced.replace('A: b   # first', 'A: {secret: x/a} # first'));
  });

  it('renames a binding in place and removes the env map with its last binding', () => {
    const renamed = renameEnvironmentBinding(file, ['services', 'backend'], 'JWT_SECRET', 'AUTH_SECRET');
    expect(changedLines(file, renamed)).toEqual(['      AUTH_SECRET: {secret: competitions/dev/jwt} # rotate monthly']);
    const removed = removeEnvironmentBinding(file, ['services', 'frontend'], 'NEXT_PUBLIC_API_URL');
    expect(parse(removed).services.frontend.env).toBeUndefined();
    expect(removed).toContain('# Competitions preview');
  });

  it('edits a single-application file at the top level', () => {
    const single = '# note\nname: fixture\ntype: command\ncwd: .\ncommand: [node, server.js]\nenv:\n  TOKEN: {secret: fixture/dev/token}\n';
    const next = setEntryField(single, [], 'command', ['node', 'web.js']);
    expect(next).toBe(single.replace('server.js', 'web.js'));
  });

  it('refuses to edit text that does not parse rather than rewriting it', () => {
    expect(() => setEntryField('services: [unclosed', ['services', 'a'], 'cwd', '.')).toThrow('Correct the file in YAML');
  });
});

describe('the changes view', () => {
  it('shows each separate change as its own hunk with context, not one block from the first change to the last', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const after = before.replace('line 2\n', 'line two\n').replace('line 18\n', 'line 18\nline 18b\n');
    const lines = configurationDiff(before, after);
    expect(lines.filter((line) => line.kind === 'hunk').map((line) => line.content)).toEqual(['@@ -1,5 +1,5 @@', '@@ -16,5 +16,6 @@']);
    expect(lines.filter((line) => line.kind !== 'context' && line.kind !== 'hunk')).toEqual([
      { kind: 'deletion', content: '-line 2', oldLine: 2 },
      { kind: 'addition', content: '+line two', newLine: 2 },
      { kind: 'addition', content: '+line 18b', newLine: 19 }
    ]);
    expect(configurationDiff('', 'a: 1\n')).toEqual([{ kind: 'hunk', content: '@@ -1,0 +1,1 @@' }, { kind: 'addition', content: '+a: 1', newLine: 1 }]);
  });

  it('keeps a file-sized rewrite cheap: a valid 36 KB file changed on every line reads as one replacement', () => {
    // 12,000 changed lines on each side would need a 576 MB alignment table.
    const file = (word: string) => `name: app\ntype: static\ndirectory: .\n${Array.from({ length: 12_000 }, (_, index) => `#${word}${index}`).join('\n')}\n`;
    const started = performance.now();
    const lines = configurationDiff(file('a'), file('b'));
    expect(performance.now() - started).toBeLessThan(200);
    expect(lines.filter((line) => line.kind === 'hunk').map((line) => line.content)).toEqual(['@@ -1,12003 +1,12003 @@']);
    expect(lines.filter((line) => line.kind === 'deletion')).toHaveLength(12_000);
    expect(lines.filter((line) => line.kind === 'addition')).toHaveLength(12_000);
  });
});
