import type { RunRecord } from '../../shared/contracts';

/** A run's reply: its final message, or the final artifact when the message was not kept. */
export async function runReplyText(
  run: Pick<RunRecord, 'finalMessage' | 'finalArtifactId'>,
  readArtifact: (artifactId: string) => Promise<string>
): Promise<string> {
  const message = run.finalMessage?.trim();
  if (message) return message;
  return run.finalArtifactId ? (await readArtifact(run.finalArtifactId).catch(() => '')).trim() : '';
}
