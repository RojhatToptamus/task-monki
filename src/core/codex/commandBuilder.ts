export interface CodexCommandRequest {
  repositoryPath: string;
  sandboxMode?: 'read-only' | 'workspace-write';
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
}

export interface CodexCommand {
  executable: string;
  argv: string[];
}

export function buildCodexExecCommand({
  repositoryPath,
  sandboxMode = 'read-only',
  approvalPolicy = 'never'
}: CodexCommandRequest): CodexCommand {
  if (!repositoryPath.trim()) {
    throw new Error('Repository path is required.');
  }

  return {
    executable: 'codex',
    argv: [
      '--ask-for-approval',
      approvalPolicy,
      'exec',
      '--json',
      '--sandbox',
      sandboxMode,
      '--cd',
      repositoryPath,
      '-'
    ]
  };
}
