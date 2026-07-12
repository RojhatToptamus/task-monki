// @vitejs/plugin-react injects this exact inline module in development. A hash
// keeps Fast Refresh working without granting all inline scripts permission.
// rendererSecurity.test.ts deliberately fails if the installed plugin changes
// its preamble, forcing an explicit security review on dependency upgrades.
export const VITE_REACT_REFRESH_PREAMBLE_SOURCE =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

export function rendererContentSecurityPolicy(options: {
  developmentWebSocketOrigin?: string;
  developmentScriptSources?: readonly string[];
} = {}): string {
  const connectSources = ["'self'"];
  const scriptSources = ["'self'"];
  if (options.developmentWebSocketOrigin) {
    connectSources.push(options.developmentWebSocketOrigin);
  }
  for (const source of options.developmentScriptSources ?? []) {
    if (!/^'sha256-[A-Za-z0-9+/]{43}='$/.test(source)) {
      throw new Error('Development script sources must be SHA-256 CSP hashes.');
    }
    scriptSources.push(source);
  }
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}
