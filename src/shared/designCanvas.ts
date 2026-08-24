export interface DesignCanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShowDesignCanvasRequest {
  designId: string;
  taskId: string;
  generationId: string;
  routeId: string;
  requestId: number;
  bounds: DesignCanvasBounds;
}

export interface HideDesignCanvasRequest {
  designId: string;
  requestId: number;
}

export interface RefreshDesignCanvasRequest {
  designId: string;
  generationId: string;
  requestId: number;
}

export interface ApproveDesignCanvasExternalRequest {
  designId: string;
  pendingId: string;
}

/**
 * Narrow Electron-only bridge for the isolated native canvas surface.
 * The renderer sends stored identities and bounds. It never sends a URL.
 */
export interface DesignCanvasApi {
  show(input: ShowDesignCanvasRequest): Promise<void>;
  hide(input: HideDesignCanvasRequest): Promise<void>;
  refresh(input: RefreshDesignCanvasRequest): Promise<void>;
  approveExternal(input: ApproveDesignCanvasExternalRequest): Promise<boolean>;
}
