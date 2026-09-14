import { DISCOURSE_LIMITS } from '../../shared/discourse';
import type {
  DiscourseAgentJobRecord, DiscourseResponseWaveRecord,
  DiscourseTeamComparison
} from '../../shared/discourse';

export function isAdaptiveTeam(wave: DiscourseResponseWaveRecord): boolean {
  return wave.policy === 'TEAM' && wave.policyVersion === 2;
}

export function discourseDeadline(wave: DiscourseResponseWaveRecord): number | undefined {
  return (wave.policy === 'CHAT' || isAdaptiveTeam(wave)) && wave.startedAt
    ? Date.parse(wave.startedAt) + DISCOURSE_LIMITS.maxChatDurationMs : undefined;
}

export function discourseTimeExpired(wave: DiscourseResponseWaveRecord, now: string): boolean {
  const deadline = discourseDeadline(wave);
  return deadline !== undefined && Date.parse(now) >= deadline;
}

export function teamComparison(job: DiscourseAgentJobRecord | undefined): DiscourseTeamComparison | undefined {
  return job?.result?.kind === 'CONTRIBUTION' && job.result.team?.kind === 'COMPARISON'
    ? job.result.team : undefined;
}

export function outputMessageId(job: DiscourseAgentJobRecord): string[] {
  return job.result && 'outputMessageId' in job.result && job.result.outputMessageId
    ? [job.result.outputMessageId] : [];
}
