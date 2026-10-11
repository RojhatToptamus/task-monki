/**
 * The command a provider asked to run, without its login-shell wrapper. The
 * approval surfaces show this text verbatim — whitespace and line breaks are
 * part of what the user approves — unlike the compact activity labels.
 */
export function displayApprovalCommand(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  const match = command.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return match?.[2] ?? command;
}

/** Whether a command's working directory is the task worktree or inside it. */
export function isWithinWorktree(cwd: string, worktreePath: string | undefined): boolean {
  if (!worktreePath) return false;
  const root = worktreePath.replace(/\/+$/, '');
  return cwd === root || cwd.startsWith(`${root}/`);
}
