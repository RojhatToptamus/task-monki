// Fixed, credential-free App Server peer for the executed attachment workflow.
// The normal deterministic workflow continues to use ACP. ACP cannot attest
// read-only review, so this peer exercises the production Codex adapter instead.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const root = fs.realpathSync(process.argv[2]);
const logPath = path.join(fs.realpathSync(path.dirname(process.argv[3])), path.basename(process.argv[3]));
const sessions = new Map();
const timers = new Set();
let sequence = 0;
const insideRoot = (candidate) => candidate.startsWith(root + path.sep);
if (!insideRoot(path.resolve(logPath)) || !path.basename(root).startsWith('task-monki-agent-test-')) {
  throw new Error('Review fixture requires its owned temporary root.');
}
const log = (event, detail = {}) => fs.appendFileSync(logPath,
  JSON.stringify({ event, pid: process.pid, ...detail }) + '\n');
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY']) {
  if (process.env[key] !== undefined) throw new Error('Review fixture received credentials.');
}
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (/^(?:node:)?(?:net|http|https|http2|tls|dgram|dns)(?:\/|$)|^undici(?:\/|$)/u.test(request)) {
    throw new Error('Review fixture cannot load network modules.');
  }
  return originalLoad.call(this, request, ...args);
};
globalThis.fetch = () => { throw new Error('Review fixture cannot use fetch.'); };
for (const key of ['WebSocket', 'EventSource']) {
  globalThis[key] = class { constructor() { throw new Error('Review fixture cannot use network clients.'); } };
}
log('started');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const gitRead = (cwd, argv) => execFileSync('git', argv, {
  cwd, encoding: 'utf8', timeout: 3_000,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
}).trim();
const turn = (id, status, items = []) => ({
  id, status, items, itemsView: { type: 'complete' }, error: null,
  startedAt: 1, completedAt: status === 'inProgress' ? null : 2,
  durationMs: status === 'inProgress' ? null : 1
});
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  const params = message.params ?? {};
  const reply = (result) => send({ id: message.id, result });
  log('received', { method: message.method });
  try {
    switch (message.method) {
      case 'initialize':
        reply({ userAgent: 'task-monki-review-fixture', codexHome: root, platformFamily: 'unix', platformOs: process.platform });
        return;
      case 'account/read':
        reply({ account: null, requiresOpenaiAuth: false });
        return;
      case 'model/list':
        reply({ data: [{
          id: 'deterministic-review', model: 'deterministic-review', displayName: 'Deterministic review',
          description: 'Fixed local review fixture', upgrade: null, upgradeInfo: null,
          availabilityNux: null, hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Deterministic' }],
          defaultReasoningEffort: 'low', inputModalities: ['text'], supportsPersonality: false,
          additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: true
        }], nextCursor: null });
        return;
      case 'collaborationMode/list':
        reply({ data: [] });
        return;
      case 'thread/start': {
        const cwd = fs.realpathSync(params.cwd);
        const profileId = params.config?.default_permissions;
        const profile = params.config?.permissions?.[profileId];
        const commonDir = fs.realpathSync(gitRead(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
        if (!insideRoot(cwd) || !insideRoot(commonDir) || params.model !== 'deterministic-review' ||
            profile?.network?.enabled !== false || profile.filesystem?.[cwd] !== 'read' ||
            profile.filesystem?.[commonDir] !== 'read' ||
            Object.values(profile.filesystem).some((access) => access !== 'read') ||
            params.approvalPolicy !== 'never') {
          throw new Error('Review requires the exact read-only checkout and common Git directory, with network and approvals disabled.');
        }
        const id = 'fixture-review-' + (++sequence);
        const thread = {
          id, sessionId: id, forkedFromId: null, parentThreadId: null,
          preview: 'Review attached work', ephemeral: false, modelProvider: 'openai',
          createdAt: 1, updatedAt: 1, status: { type: 'idle' }, path: null, cwd,
          cliVersion: '0.141.0', source: 'appServer', threadSource: null,
          agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: []
        };
        sessions.set(id, thread);
        log('read-only-session', { sessionId: id, cwd, commonDir });
        reply({
          thread, model: 'deterministic-review', modelProvider: 'openai', serviceTier: null,
          cwd, runtimeWorkspaceRoots: [cwd], activePermissionProfile: { id: profileId, extends: null },
          instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: null
        });
        return;
      }
      case 'turn/start': {
        const thread = sessions.get(params.threadId);
        if (!thread || thread.turns.length) throw new Error('Review needs a fresh detached session.');
        const prompt = JSON.stringify(params.input);
        if (!prompt.includes('agent-review/v1')) throw new Error('Expected the production review prompt.');
        const contents = fs.readFileSync(path.join(thread.cwd, 'content.txt'), 'utf8');
        const head = gitRead(thread.cwd, ['rev-parse', 'HEAD']);
        const id = thread.id + '-turn';
        const active = turn(id, 'inProgress');
        thread.turns = [active];
        reply({ turn: active });
        send({ method: 'turn/started', params: { threadId: thread.id, turn: active } });
        log('review-observed', { turnId: id, contents, head });
        // A file outside the checkout makes the external edit deterministic;
        // only real provider protocol notifications can finish the app run.
        const release = path.join(root, 'runtime', id + '.release');
        const deadline = Date.now() + 10_000;
        const timer = setInterval(() => {
          if (!fs.existsSync(release)) {
            if (Date.now() > deadline) throw new Error('Review fixture release deadline expired.');
            return;
          }
          clearInterval(timer);
          timers.delete(timer);
          const item = {
            type: 'agentMessage', id: id + '-result', phase: null, memoryCitation: null,
            text: JSON.stringify({ schemaVersion: 'agent-review/v1', verdict: 'PASSED',
              summary: 'Read attached source at ' + head + ': ' + contents.trim(), findings: [] })
          };
          send({ method: 'item/completed', params: { threadId: thread.id, turnId: id, completedAtMs: Date.now(), item } });
          const completed = turn(id, 'completed', [item]);
          thread.turns = [completed];
          send({ method: 'turn/completed', params: { threadId: thread.id, turn: completed } });
        }, 20);
        timers.add(timer);
        return;
      }
      case 'thread/read':
        if (!sessions.has(params.threadId)) throw new Error('Unknown review thread.');
        reply({ thread: sessions.get(params.threadId) });
        return;
      case 'thread/list':
        reply({ data: [...sessions.values()], nextCursor: null });
        return;
      case 'thread/unsubscribe':
        reply({ status: 'unsubscribed' });
        return;
      case 'thread/delete':
        sessions.delete(params.threadId);
        reply({});
        return;
      default:
        send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method: ' + message.method } });
    }
  } catch (error) {
    log('rejected', { method: message.method, error: error.message });
    send({ id: message.id, error: { code: -32602, message: error.message } });
  }
});
const stop = () => {
  for (const timer of timers) clearInterval(timer);
  input.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
input.on('close', stop);
