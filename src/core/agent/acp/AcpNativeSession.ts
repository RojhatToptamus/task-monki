import type {
  AcpSessionConfigOption,
  AcpSessionModelState,
  AcpSessionModeState
} from './AcpProtocol';

/** Exact ACP session selections owned by the provider adapter. */
export interface AcpNativeSessionState {
  sessionId: string;
  modes: AcpSessionModeState | null;
  models: AcpSessionModelState | null;
  configOptions: AcpSessionConfigOption[];
}
