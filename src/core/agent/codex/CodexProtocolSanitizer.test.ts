import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_ATTACHMENT_PROMPT_MARKER } from './CodexAttachmentDelivery';
import { CodexProtocolSanitizer } from './CodexProtocolSanitizer';

describe('Codex protocol attachment redaction', () => {
  it('removes inline bytes and managed paths without changing correlation fields', () => {
    const sanitizer = new CodexProtocolSanitizer();
    const managedPath = path.join(
      path.parse(process.cwd()).root,
      'task-monki',
      'attachments',
      'tasks',
      'task-1',
      'secret.txt'
    );
    const raw = JSON.stringify({
      method: 'turn/start',
      id: 7,
      params: {
        threadId: 'thread-1',
        input: [
          {
            type: 'text',
            text: `Do the task.${CODEX_ATTACHMENT_PROMPT_MARKER}secret attachment bytes`,
            text_elements: []
          },
          { type: 'localImage', path: managedPath }
        ],
        config: {
          permissions: {
            profile: { filesystem: { [managedPath]: 'read' } }
          }
        }
      }
    });

    const safe = sanitizer.sanitizeRaw(raw, 'OUTBOUND');

    expect(safe).toContain('turn/start');
    expect(safe).toContain('thread-1');
    expect(safe).toContain('attachment input omitted');
    expect(safe).not.toContain('secret attachment bytes');
    expect(safe).not.toContain(managedPath);
    expect(safe).not.toContain(JSON.stringify(managedPath).slice(1, -1));
    expect(safe).not.toContain('secret.txt');
  });

  it('removes a provider echo of a managed attachment path', () => {
    const sanitizer = new CodexProtocolSanitizer();
    const managedPath = '/private/data/attachments/tasks/task-1/reference.png';

    expect(
      sanitizer.sanitizeRaw(
        JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', delta: `Opened ${managedPath}` }
        }),
        'INBOUND'
      )
    ).not.toContain(managedPath);
  });

  it('keeps MCP denial evidence without journaling transport details', () => {
    const sanitizer = new CodexProtocolSanitizer();
    const raw = JSON.stringify({
      method: 'thread/start',
      params: {
        config: {
          'mcp_servers.local': {
            enabled: false,
            command: '/private/tools/secret-mcp',
            args: ['--token', 'secret-argument'],
            cwd: '/private/project'
          },
          'mcp_servers.remote': {
            enabled: false,
            url: 'https://user:secret@example.test/rpc?token=query-secret'
          }
        }
      }
    });

    const safe = sanitizer.sanitizeRaw(raw, 'OUTBOUND');

    expect(safe).toContain('mcp_servers.local');
    expect(safe).toContain('MCP transport omitted');
    expect(safe).toContain('"enabled":false');
    for (const secret of [
      '/private/tools/secret-mcp',
      'secret-argument',
      '/private/project',
      'user:secret',
      'query-secret'
    ]) {
      expect(safe).not.toContain(secret);
      expect(safe).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
  });
});
