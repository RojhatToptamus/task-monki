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
});
