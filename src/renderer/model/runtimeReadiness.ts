import type {
  AgentRuntimeDiagnostic,
  AgentRuntimeState
} from '../../shared/contracts';
import {
  projectAgentExecutionSupport,
  type AgentExecutionOperation,
  type AgentExecutionSupportContext
} from '../../shared/agentExecutionSupport';

export type RuntimeReadinessTone = 'ok' | 'warning' | 'error' | 'muted';

export interface RuntimeReadinessView {
  canStart: boolean;
  label: string;
  detail: string;
  tone: RuntimeReadinessTone;
  optionSuffix: string;
  nextAction?: string;
  diagnostics: AgentRuntimeDiagnostic[];
  /** Concise, actionable diagnostics suitable for primary workflow surfaces. */
  warnings: AgentRuntimeDiagnostic[];
}

export type ConfiguredRuntimeExecutionSelection =
  | { runtime: AgentRuntimeState; unavailableReason?: never }
  | { runtime?: never; unavailableReason: string };

/** Selects only the configured runtime. Workflow changes never cause provider fallback. */
export function selectConfiguredRuntimeForOperation(
  runtimes: AgentRuntimeState[],
  runtimeId: string | undefined,
  operation: AgentExecutionOperation,
  context: AgentExecutionSupportContext = {}
): ConfiguredRuntimeExecutionSelection {
  const runtime = runtimeId
    ? runtimes.find((candidate) => candidate.preflight.runtime.id === runtimeId)
    : undefined;
  if (!runtime) {
    return { unavailableReason: 'The configured agent connection is not available.' };
  }
  const unavailableReason = runtimeExecutionUnavailableReason(
    runtime,
    operation,
    context
  );
  return unavailableReason ? { unavailableReason } : { runtime };
}

export function runtimeExecutionUnavailableReason(
  runtime: AgentRuntimeState | undefined,
  operation: AgentExecutionOperation,
  context: AgentExecutionSupportContext = {}
): string | undefined {
  if (!runtime) return 'The configured agent connection is not available.';
  if (!runtime.preflight.readiness.canStart) {
    return runtime.preflight.readiness.detail;
  }
  const support = projectAgentExecutionSupport(
    runtime.preflight.capabilities,
    operation,
    context
  );
  return support.supported ? undefined : support.reason;
}

/**
 * One renderer projection for runtime health. UI code consumes typed status;
 * it never infers availability by parsing provider error strings.
 */
export function runtimeReadinessView(
  runtime: AgentRuntimeState | undefined
): RuntimeReadinessView {
  if (!runtime) {
    return {
      canStart: false,
      label: 'Not checked',
      detail: 'Runtime status has not been loaded.',
      tone: 'muted',
      optionSuffix: ' (not checked)',
      diagnostics: [],
      warnings: []
    };
  }

  const { readiness } = runtime.preflight;
  const label = readiness.status === 'DISABLED' ? 'Unavailable' : readiness.summary;
  const tone: RuntimeReadinessTone =
    readiness.status === 'READY'
      ? 'ok'
      : readiness.status === 'DISCOVERED' || readiness.status === 'INITIALIZING'
        ? 'muted'
        : readiness.status === 'DEGRADED'
          ? 'warning'
          : 'error';
  return {
    canStart: readiness.canStart,
    label,
    detail: readiness.detail,
    tone,
    optionSuffix: readiness.status === 'READY'
      ? ''
      : ` (${label.toLocaleLowerCase()})`,
    nextAction: readiness.nextAction?.label,
    diagnostics: readiness.diagnostics,
    warnings: readiness.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'WARNING'
    )
  };
}
