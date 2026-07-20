import type {
  AgentPreflight,
  AgentRuntimeDiagnostic,
  AgentRuntimeReadiness,
  AgentRuntimeReadinessChecks,
  AgentRuntimeReadinessStatus
} from '../../shared/agent';

type StartableStatus = 'DISCOVERED' | 'READY' | 'DEGRADED';

const DEFAULT_SUMMARIES: Record<AgentRuntimeReadinessStatus, string> = {
  NOT_INSTALLED: 'Not installed',
  INCOMPATIBLE: 'Incompatible',
  AUTHENTICATION_REQUIRED: 'Sign in required',
  ACCOUNT_UNSUPPORTED: 'Account unsupported',
  DISCOVERED: 'Available to start',
  INITIALIZING: 'Initializing',
  READY: 'Ready',
  DEGRADED: 'Degraded',
  FAILED: 'Unavailable',
  UNSUPPORTED_SECURITY_POLICY: 'Security policy unsupported',
  DISABLED: 'Disabled'
};

export const UNKNOWN_RUNTIME_CHECKS: AgentRuntimeReadinessChecks = {
  discovery: 'UNKNOWN',
  compatibility: 'UNKNOWN',
  initialization: 'NOT_STARTED',
  authentication: 'UNKNOWN',
  modelCatalog: 'UNKNOWN'
};

export function createRuntimeReadiness(
  status: AgentRuntimeReadinessStatus,
  detail: string,
  options: {
    summary?: string;
    checks?: Partial<AgentRuntimeReadinessChecks>;
    diagnostics?: readonly AgentRuntimeDiagnostic[];
    nextAction?: AgentRuntimeReadiness['nextAction'];
  } = {}
): AgentRuntimeReadiness {
  const common = {
    status,
    summary: options.summary ?? DEFAULT_SUMMARIES[status],
    detail,
    checks: { ...UNKNOWN_RUNTIME_CHECKS, ...options.checks },
    diagnostics: uniqueDiagnostics(options.diagnostics ?? []),
    ...(options.nextAction ? { nextAction: options.nextAction } : {})
  };
  if (isStartableStatus(status)) {
    return { ...common, status, canStart: true };
  }
  return { ...common, status, canStart: false };
}

export function appendRuntimeDiagnostic(
  preflight: AgentPreflight,
  diagnostic: AgentRuntimeDiagnostic,
  status: AgentRuntimeReadinessStatus = preflight.readiness.status
): AgentPreflight {
  const statusChanged = status !== preflight.readiness.status;
  return {
    ...preflight,
    readiness: createRuntimeReadiness(
      status,
      statusChanged ? diagnostic.message : preflight.readiness.detail,
      {
      ...(statusChanged ? {} : { summary: preflight.readiness.summary }),
      checks: preflight.readiness.checks,
      diagnostics: [...preflight.readiness.diagnostics, diagnostic],
      nextAction: preflight.readiness.nextAction
      }
    )
  };
}

export function errorDiagnostic(
  code: string,
  stage: AgentRuntimeDiagnostic['stage'],
  message: string,
  detail?: string
): AgentRuntimeDiagnostic {
  return { code, severity: 'ERROR', stage, message, ...(detail ? { detail } : {}) };
}

export function warningDiagnostic(
  code: string,
  stage: AgentRuntimeDiagnostic['stage'],
  message: string,
  detail?: string
): AgentRuntimeDiagnostic {
  return { code, severity: 'WARNING', stage, message, ...(detail ? { detail } : {}) };
}

export function infoDiagnostic(
  code: string,
  stage: AgentRuntimeDiagnostic['stage'],
  message: string,
  detail?: string
): AgentRuntimeDiagnostic {
  return { code, severity: 'INFO', stage, message, ...(detail ? { detail } : {}) };
}

function uniqueDiagnostics(
  diagnostics: readonly AgentRuntimeDiagnostic[]
): AgentRuntimeDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\u0000${diagnostic.message}\u0000${diagnostic.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isStartableStatus(
  status: AgentRuntimeReadinessStatus
): status is StartableStatus {
  return status === 'DISCOVERED' || status === 'READY' || status === 'DEGRADED';
}
