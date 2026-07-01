import type {
  ExternalToolId,
  ExternalToolProbeResult,
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
