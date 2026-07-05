import type {
  ExternalToolId,
  ExternalToolProbeResult,
  ExternalToolStatusReport,
  TestExternalToolRequest
} from '../../shared/contracts';

export type ExecutablePathMode = 'auto' | 'custom';

export function buildExecutableTestRequest(
  tool: ExternalToolId,
  mode: ExecutablePathMode,
  draftPath: string
): TestExternalToolRequest {
  return {
    tool,
    executablePath: mode === 'custom' ? draftPath.trim() || null : null
  };
}

export function selectExecutableDisplayStatus(
  savedStatus: ExternalToolProbeResult | undefined,
  testResult: ExternalToolProbeResult | undefined
): ExternalToolProbeResult | undefined {
  return testResult ?? savedStatus;
}

export function areRequiredExternalToolsReady(
  status: ExternalToolStatusReport | undefined
): boolean {
  return status?.tools.git.status === 'ok' && status.tools.codex.status === 'ok';
}

export function shouldShowExecutablePathControls(
  status: ExternalToolProbeResult | undefined,
  configuredPath: string | null
): boolean {
  return Boolean(configuredPath?.trim()) || status?.status === 'error';
}
