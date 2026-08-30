import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentModel } from '../../../shared/agent';
import type { AgentTurnAttachment } from '../AgentAttachmentDelivery';
import type { AcpInitializeResponse } from './AcpProtocol';
import {
  journalSafeAcpMessage,
  prepareAcpAttachmentDelivery,
  sanitizeAcpAttachmentContent
} from './AcpAttachmentDelivery';
import {
  CLAUDE_AGENT_ACP_PROFILE,
  CURSOR_ACP_PROFILE,
  GROK_ACP_PROFILE
} from './AcpRuntimeProfiles';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('ACP attachment delivery', () => {
  it('removes Design MCP credentials and managed paths from protocol journals', () => {
    const safe = journalSafeAcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: {
        cwd: '/worktree',
        mcpServers: [{
          name: 'task-monki-design-tools',
          command: '/packaged/Task Monki',
          args: ['/packaged/design-tool-mcp-server.mjs'],
          env: [
            {
              name: 'TASK_MONKI_DESIGN_TOOL_SESSION_CREDENTIAL',
              value: 'session-secret'
            },
            {
              name: 'TASK_MONKI_DESIGN_TOOL_CREDENTIAL_FILE',
              value: '/managed/design-tool-credentials/grant/turn-grant'
            }
          ]
        }]
      }
    });

    expect(JSON.stringify(safe)).not.toContain('session-secret');
    expect(JSON.stringify(safe)).not.toContain('/managed/design-tool-credentials');
    expect(JSON.stringify(safe)).toContain('[REDACTED TASK MONKI DESIGN TOOL VALUE]');
  });

  it('maps verified Grok text to an opaque embedded resource without a path', async () => {
    const attachment = await managedAttachment('notes.txt', 'private reference');
    const result = await prepareAcpAttachmentDelivery({
      profile: GROK_ACP_PROFILE,
      initialize: initialize({ embeddedContext: true }),
      model: model(['text']),
      prompt: 'Use the reference.',
      attachments: [attachment]
    });

    expect(result.prompt).toEqual([
      { type: 'text', text: 'Use the reference.' },
      {
        type: 'resource',
        resource: {
          uri: `task-monki-attachment:${attachment.attachmentId}`,
          mimeType: 'text/plain',
          text: expect.stringContaining('private reference')
        }
      }
    ]);
    expect(JSON.stringify(result.prompt)).not.toContain(attachment.path);
    expect(result.submissionCandidates).toEqual([
      expect.objectContaining({
        attachmentId: attachment.attachmentId,
        transport: 'embedded-resource'
      })
    ]);
  });

  it('maps Cursor text to a marked block and removes it from echoed payloads', async () => {
    const attachment = await managedAttachment('context.txt', 'do not retain this');
    const result = await prepareAcpAttachmentDelivery({
      profile: CURSOR_ACP_PROFILE,
      initialize: initialize({}),
      model: model(['text']),
      prompt: 'Read this.',
      attachments: [attachment]
    });
    const block = result.prompt[1] as { type: 'text'; text: string };
    expect(block.text).toContain('[TASK_MONKI_ATTACHMENT_BEGIN]');
    expect(block.text).toContain('do not retain this');
    expect(result.submissionCandidates[0]?.transport).toBe('text-block');

    const sanitized = sanitizeAcpAttachmentContent({
      method: 'session/update',
      params: { update: { content: block } }
    });
    expect(JSON.stringify(sanitized)).not.toContain('do not retain this');
    expect(JSON.stringify(sanitized)).toContain(
      '[REDACTED TASK MONKI ATTACHMENT CONTENT]'
    );
  });

  it('maps a qualified image to native base64 and sanitizes structured echoes', async () => {
    const attachment = await managedAttachment(
      'screen.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'image',
      'image/png'
    );
    const cursorModel: AgentModel = {
      ...model(['text', 'image']),
      model: 'composer-2.5',
      displayName: 'Composer 2.5'
    };
    const result = await prepareAcpAttachmentDelivery({
      profile: CURSOR_ACP_PROFILE,
      initialize: initialize({ image: true }),
      runtimeVersion: '2026.08.25-3e8eec8',
      model: cursorModel,
      prompt: 'Inspect this.',
      attachments: [attachment]
    });
    expect(result.prompt[1]).toEqual({
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png'
    });
    expect(result.submissionCandidates[0]?.transport).toBe('native-image');
    expect(
      JSON.stringify(sanitizeAcpAttachmentContent(result.prompt[1]))
    ).not.toContain(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));

    const webp = await managedAttachment(
      'screen.webp',
      Buffer.from('RIFFtestWEBP'),
      'image',
      'image/webp'
    );
    await expect(
      prepareAcpAttachmentDelivery({
        profile: CURSOR_ACP_PROFILE,
        initialize: initialize({ image: true }),
        runtimeVersion: '2026.08.25-3e8eec8',
        model: cursorModel,
        prompt: 'Inspect this.',
        attachments: [webp]
      })
    ).rejects.toThrow('not image/webp');
  });

  it('removes inspect_design image bytes from nested ACP tool results', () => {
    const sanitized = sanitizeAcpAttachmentContent({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          title: 'inspect_design',
          content: [{
            type: 'content',
            content: { type: 'image', data: 'transient-screenshot', mimeType: 'image/png' }
          }]
        }
      }
    });

    expect(JSON.stringify(sanitized)).not.toContain('transient-screenshot');
    expect(JSON.stringify(sanitized)).toContain(
      '[REDACTED TASK MONKI ATTACHMENT CONTENT]'
    );
  });

  it('rejects embedded text before reading bytes when the agent did not negotiate it', async () => {
    const attachment = await managedAttachment('notes.txt', 'content');
    await expect(
      prepareAcpAttachmentDelivery({
        profile: GROK_ACP_PROFILE,
        initialize: initialize({ embeddedContext: false }),
        model: model(['text']),
        prompt: 'Use it.',
        attachments: [attachment]
      })
    ).rejects.toThrow('did not negotiate ACP embedded context');
  });

  it('uses the exact Grok image exception and rejects unqualified formats and models', async () => {
    const image = await managedAttachment(
      'screen.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'image',
      'image/png'
    );
    const grokModel: AgentModel = {
      ...model(['text', 'image']),
      runtimeId: 'grok-acp',
      modelProvider: 'xai',
      model: 'grok-4.6',
      displayName: 'Grok 4.6'
    };
    const result = await prepareAcpAttachmentDelivery({
      profile: GROK_ACP_PROFILE,
      initialize: initialize({ image: false }),
      runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
      model: grokModel,
      prompt: 'Inspect it.',
      attachments: [image]
    });
    expect(result.prompt[1]).toEqual({
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png'
    });

    const webp = await managedAttachment(
      'screen.webp',
      Buffer.from('RIFFtestWEBP'),
      'image',
      'image/webp'
    );
    await expect(
      prepareAcpAttachmentDelivery({
        profile: GROK_ACP_PROFILE,
        initialize: initialize({ image: false }),
        runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
        model: grokModel,
        prompt: 'Inspect it.',
        attachments: [webp]
      })
    ).rejects.toThrow('not image/webp');
    await expect(
      prepareAcpAttachmentDelivery({
        profile: GROK_ACP_PROFILE,
        initialize: initialize({ image: false }),
        runtimeVersion: 'grok 1.0.13 (5e9a58528b76) [stable]',
        model: { ...grokModel, model: 'grok-4.5', displayName: 'Grok 4.5' },
        prompt: 'Inspect it.',
        attachments: [image]
      })
    ).rejects.toThrow('no verified compatibility exception');
  });

  it('keeps Claude attachments disabled without packaged qualification', async () => {
    const text = await managedAttachment('notes.txt', 'content');
    await expect(
      prepareAcpAttachmentDelivery({
        profile: CLAUDE_AGENT_ACP_PROFILE,
        initialize: initialize({ embeddedContext: true }),
        model: model(['text']),
        prompt: 'Read it.',
        attachments: [text]
      })
    ).rejects.toThrow('content-use qualification');
  });
});

async function managedAttachment(
  displayName: string,
  content: string | Buffer,
  kind: AgentTurnAttachment['kind'] = 'text',
  mediaType = 'text/plain'
): Promise<AgentTurnAttachment> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-attachment-'));
  temporaryDirectories.push(directory);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const filePath = path.join(directory, displayName);
  await fs.writeFile(filePath, bytes, { mode: 0o400 });
  await fs.chmod(filePath, 0o400);
  return {
    attachmentId: `attachment-${temporaryDirectories.length}`,
    ordinal: 0,
    displayName,
    kind,
    mediaType,
    byteCount: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    path: filePath,
    verifiedAt: new Date(0).toISOString()
  };
}

function initialize(
  promptCapabilities: NonNullable<
    AcpInitializeResponse['agentCapabilities']['promptCapabilities']
  >
): AcpInitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities },
    authMethods: []
  };
}

function model(inputModalities: string[]): AgentModel {
  return {
    id: 'cursor-agent-acp:cursor/model-1',
    runtimeId: 'cursor-agent-acp',
    modelProvider: 'cursor',
    model: 'model-1',
    displayName: 'Model 1',
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities,
    isDefault: true
  };
}
