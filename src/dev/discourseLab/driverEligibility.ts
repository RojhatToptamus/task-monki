import { stableJson } from './ledger';
import type {
  LabBoundaryProbeInput,
  LabDriverPreflight,
  LabTextDriver
} from './textDriver';

export type LabSemanticDriverPolicy =
  | 'PROVIDER_ENFORCED'
  | 'H1_DEVELOPMENT_HARNESS_VERIFIED';

/**
 * A semantic lab run may trust only a fresh, exact driver attestation. Static
 * capability flags are useful for planning, but are not an execution gate by
 * themselves.
 */
export async function attestSemanticLabDriver(
  driver: LabTextDriver,
  requested: LabBoundaryProbeInput,
  limits: {
    maximumCallMs: number;
    experimentDeadlineMs: number;
  },
  policy: LabSemanticDriverPolicy = 'PROVIDER_ENFORCED'
): Promise<LabDriverPreflight> {
  const remainingExperimentMs = limits.experimentDeadlineMs - Date.now();
  const timeoutMs = Math.min(limits.maximumCallMs, remainingExperimentMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Semantic Discourse Lab driver preflight timed out before it started.');
  }
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(
        `Semantic Discourse Lab driver preflight timed out after ${timeoutMs} ms.`
      );
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  let report: LabDriverPreflight;
  try {
    report = await Promise.race([
      Promise.resolve().then(() => driver.preflight({
        ...requested,
        signal: controller.signal,
        maximumCallMs: timeoutMs,
        experimentDeadlineMs: limits.experimentDeadlineMs
      })),
      timeout
    ]);
  } catch (error) {
    if (!timedOut && Date.now() >= limits.experimentDeadlineMs) {
      controller.abort(error);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const problems: string[] = [];
  if (report.driverId !== driver.id) problems.push('driverId');
  if (!report.ready) problems.push('ready');
  if (report.requiresAuthentication) problems.push('authentication');
  if (stableJson(report.capabilities) !== stableJson(driver.capabilities)) {
    problems.push('capability-report');
  }
  if (policy === 'PROVIDER_ENFORCED') {
    if (!report.capabilities.textOnlyProviderEnforced) {
      problems.push('provider-enforced-text-only');
    }
    if (!report.capabilities.hardOutputTokenLimit) {
      problems.push('provider-output-token-limit');
    }
  } else {
    if (!report.capabilities.harnessVerifiedTextIsolation) {
      problems.push('harness-verified-text-isolation');
    }
    if (!report.capabilities.streamingOutputTokenInterrupt) {
      problems.push('streaming-output-token-interrupt');
    }
    if (!report.capabilities.providerReportedTokenUsage) {
      problems.push('provider-reported-token-usage');
    }
  }
  if (!report.capabilities.hardCallTimeLimit) problems.push('hard-call-time-limit');

  const boundary = report.boundary;
  if (boundary.status !== 'ATTESTED') problems.push('boundary-status');
  if (boundary.failure) problems.push('boundary-failure');
  if (boundary.requestedModel !== requested.model) problems.push('requested-model');
  if (boundary.observedModel !== requested.model) problems.push('observed-model');
  if (
    normalizeOptional(boundary.requestedReasoningEffort) !==
    normalizeOptional(requested.reasoningEffort)
  ) {
    problems.push('requested-reasoning-effort');
  }
  if (
    normalizeOptional(boundary.observedReasoningEffort) !==
    normalizeOptional(requested.reasoningEffort)
  ) {
    problems.push('observed-reasoning-effort');
  }
  if (
    normalizeOptional(boundary.requestedServiceTier) !==
    normalizeOptional(requested.serviceTier)
  ) {
    problems.push('requested-service-tier');
  }
  if (
    normalizeOptional(boundary.observedServiceTier) !==
    normalizeOptional(requested.serviceTier)
  ) {
    problems.push('observed-service-tier');
  }
  if (boundary.instructionSources.length > 0) problems.push('inherited-instructions');
  if (boundary.mcpStartupEvents.length > 0) problems.push('mcp-context');
  if (boundary.mismatchFields.length > 0) problems.push('boundary-mismatches');

  const selectedModel = report.models.find(
    (candidate) => candidate.id === requested.model || candidate.model === requested.model
  );
  if (!selectedModel) {
    problems.push('model-catalog');
  } else if (
    requested.reasoningEffort &&
    !selectedModel.supportedReasoningEfforts.includes(requested.reasoningEffort)
  ) {
    problems.push('reasoning-effort-catalog');
  }

  if (problems.length > 0) {
    throw new Error(
      `Semantic Discourse Lab driver attestation failed: ${[...new Set(problems)].join(', ')}.`
    );
  }
  return structuredClone(report);
}

function normalizeOptional(value: string | null | undefined): string | null {
  return value ?? null;
}
