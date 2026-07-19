import type { CodexExternalToolSettings } from '../../../shared/agent';
import { ProcessSupervisor, type SupervisedProcess } from '../../process/ProcessSupervisor';
import {
  codexExternalToolConfigOverrides,
  resolveCodexExternalToolConfigOverrides
} from './CodexToolConfig';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type CodexEphemeralRunErrorCode =
  | 'TIMED_OUT'
  | 'CANCELED'
  | 'TERMINATION_UNCONFIRMED'
  | 'PROCESS_FAILED'
  | 'NO_FINAL_MESSAGE';

export class CodexEphemeralRunError extends Error {
  constructor(
    readonly code: CodexEphemeralRunErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CodexEphemeralRunError';
  }
}

export interface CodexEphemeralReadOnlyRunRequest {
  cwd: string;
  instruction: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  codexExecutable?: string;
  toolSettings?: CodexExternalToolSettings;
  failClosedMcpDiscovery?: boolean;
}

export interface CodexEphemeralReadOnlyRun {
  result: Promise<string>;
  cancel(): Promise<void>;
}

export function buildCodexEphemeralReadOnlyCommand(input: {
  cwd: string;
  model: string;
  reasoningEffort: string;
  configOverrides?: readonly string[];
  executable?: string;
}): { executable: string; argv: string[] } {
  if (!input.cwd.trim()) throw new Error('Working directory is required.');
  if (!input.model.trim()) throw new Error('Model is required.');
  const executable = input.executable ?? 'codex';
  const configOverrides = input.configOverrides ?? codexExternalToolConfigOverrides();
  return {
    executable,
    argv: [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      input.cwd,
      '--model',
      input.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
      ...configOverrides.flatMap((override) => ['-c', override]),
      '-'
    ]
  };
}

export async function startCodexEphemeralReadOnlyRun(
  input: CodexEphemeralReadOnlyRunRequest
): Promise<CodexEphemeralReadOnlyRun> {
  const executable = input.codexExecutable ?? 'codex';
  const configOverrides = await resolveCodexExternalToolConfigOverrides({
    executable,
    cwd: input.cwd,
    settings: input.toolSettings,
    failClosedMcpDiscovery: input.failClosedMcpDiscovery
  });
  const command = buildCodexEphemeralReadOnlyCommand({
    cwd: input.cwd,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    configOverrides,
    executable
  });
  const process = new ProcessSupervisor().start({
    executable: command.executable,
    argv: command.argv,
    cwd: input.cwd,
    stdin: input.instruction
  });
  return superviseCodexEphemeralProcess(process, input.timeoutMs);
}

export function superviseCodexEphemeralProcess(
  process: SupervisedProcess,
  timeoutMs: number
): CodexEphemeralReadOnlyRun {
  let canceled = false;
  let timedOut = false;
  let settled = false;
  let stdout = '';
  let stderr = '';
  let timer: NodeJS.Timeout | undefined;
  let cancellationWork: Promise<void> | undefined;

  const cancelProcess = () => {
    cancellationWork ??= process.cancel();
    return cancellationWork;
  };

  const result = new Promise<string>((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void cancelProcess().catch(() => {
        finish(() => reject(
          new CodexEphemeralRunError(
            'TERMINATION_UNCONFIRMED',
            'The timed-out agent process could not be stopped.'
          )
        ));
      });
    }, timeoutMs);
    process.events.on('stdout', (chunk) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'));
    });
    process.events.on('stderr', (chunk) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'));
    });
    process.events.once('error', () => {
      finish(() => reject(
        new CodexEphemeralRunError('PROCESS_FAILED', 'The agent process could not start.')
      ));
    });
    process.events.once('close', ({ exitCode }) => {
      finish(() => {
        if (timedOut) {
          reject(new CodexEphemeralRunError('TIMED_OUT', 'The agent generation timed out.'));
          return;
        }
        if (canceled) {
          reject(new CodexEphemeralRunError('CANCELED', 'The agent generation was canceled.'));
          return;
        }
        if (exitCode !== 0) {
          reject(
            new CodexEphemeralRunError(
              'PROCESS_FAILED',
              stderr.trim()
                ? 'The agent process failed before producing a draft.'
                : 'The agent process did not complete successfully.'
            )
          );
          return;
        }
        const message = extractFinalAgentMessage(stdout);
        if (!message) {
          reject(
            new CodexEphemeralRunError('NO_FINAL_MESSAGE', 'The agent returned no final draft.')
          );
          return;
        }
        resolve(message);
      });
    });
  });

  return {
    result,
    cancel: async () => {
      if (!settled && !timedOut) canceled = true;
      if (!settled || cancellationWork) await cancelProcess();
    }
  };
}

function extractFinalAgentMessage(stdout: string): string | undefined {
  let finalMessage: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        item?: { type?: unknown; text?: unknown };
      };
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        finalMessage = event.item.text;
      }
    } catch {
      // Ignore non-protocol output. A valid final agent message is still required.
    }
  }
  return finalMessage;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_OUTPUT_BYTES);
}
