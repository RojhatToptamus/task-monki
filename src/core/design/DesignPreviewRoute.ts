export interface PreviewUrlHost {
  openExternal(url: string): Promise<void>;
}

export interface ResolvedPreviewRoute {
  taskId: string;
  generationId: string;
  routeId: string;
  url: string;
  origin: string;
  allowedOrigins?: string[];
  networkLease?: Pick<
    import('./DesignBrowserProxy').DesignBrowserLease,
    'proxyUrl' | 'close'
  >;
}
