import { createHash } from 'node:crypto';

export function previewComposeProjectName(taskId: string): string {
  return `taskmonki_${createHash('sha256').update(taskId).digest('hex').slice(0, 20)}`;
}
