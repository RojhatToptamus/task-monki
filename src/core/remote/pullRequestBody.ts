import type { Task } from '../../shared/contracts';
import type { RemoteProvider } from '../../shared/remoteWork';

/** The description of a task's new draft pull or merge request, for people: the request, the evidence, the agent's summary. */
export function buildPullRequestBody(input: {
  task: Task;
  gitDiffStat?: string;
  agentSummary?: string;
  /** A closing or plain reference to the issue the task was opened from. */
  issueLine?: string;
  /** The platform that receives the body. */
  provider: RemoteProvider;
  /** Bug Replay's block for the task's recorded bug, already bounded and worded. */
  behaviour?: string;
}): string {
  const gitLab = input.provider === 'GITLAB';
  const request = input.task.prompt.trim().slice(0, 1200);
  return [
    `## Summary`,
    '',
    ...(input.issueLine ? [input.issueLine, ''] : []),
    ...(request || !input.issueLine ? [request, ''] : []),
    '## Local evidence',
    '',
    `- Diff stat: ${input.gitDiffStat?.trim().slice(0, 4000) || 'No diff stat captured.'}`,
    '',
    ...(input.behaviour ? [input.behaviour.trim().slice(0, 2000), ''] : []),
    '## Agent summary',
    '',
    input.agentSummary?.trim().slice(0, 8000) || 'No agent final summary captured.',
    '',
    '## Delivery note',
    '',
    gitLab
      ? 'Created by Task Monki as a draft MR. Merge remains a human/GitLab decision.'
      : 'Created by Task Monki as a draft PR. Merge remains a human/GitHub decision.',
    ''
  ].join('\n');
}
