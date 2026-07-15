import type {
  AgentRuntimeDiagnostic,
  AgentRuntimeState
} from '../../shared/contracts';

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
    label: readiness.summary,
    detail: readiness.detail,
    tone,
    optionSuffix: readiness.status === 'READY'
      ? ''
      : ` (${readiness.summary.toLocaleLowerCase()})`,
    nextAction: readiness.nextAction?.label,
    diagnostics: readiness.diagnostics,
    warnings: readiness.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'WARNING'
    )
  };
}
