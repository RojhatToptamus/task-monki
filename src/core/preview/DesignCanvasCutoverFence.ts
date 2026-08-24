export interface DesignCanvasRouteIdentity {
  taskId: string;
  generationId: string;
  routeId: string;
}

export interface BeginDesignCanvasCutoverInput {
  designId: string;
  candidate: DesignCanvasRouteIdentity;
  replaced?: DesignCanvasRouteIdentity;
}

export interface DesignCanvasCutoverLease {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DesignCanvasCutoverFence {
  begin(input: BeginDesignCanvasCutoverInput): Promise<DesignCanvasCutoverLease>;
}
