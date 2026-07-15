import { randomUUID } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {
  DEFAULT_DEV_API_PORT,
  DEFAULT_DEV_RENDERER_PORT,
  DEV_API_TOKEN_HEADER,
  consumeDevApiToken,
  devRendererOrigin,
  isAllowedDevRendererRequest,
  parseDevPort
} from './src/dev/devApiSecurity';
import {
  rendererContentSecurityPolicy,
  VITE_REACT_REFRESH_PREAMBLE_SOURCE
} from './src/shared/rendererSecurity';

export default defineConfig(() => {
  const apiPort = parseDevPort(
    process.env.TASK_MANAGER_API_PORT,
    DEFAULT_DEV_API_PORT,
    'TASK_MANAGER_API_PORT'
  );
  const rendererPort = parseDevPort(
    process.env.TASK_MANAGER_RENDERER_PORT,
    DEFAULT_DEV_RENDERER_PORT,
    'TASK_MANAGER_RENDERER_PORT'
  );
  const rendererOrigin = devRendererOrigin(rendererPort);

  return {
    base: './',
    plugins: [devApiOriginGuard(rendererOrigin), react()],
    build: {
      outDir: 'dist-renderer',
      emptyOutDir: true
    },
    server: {
      host: '127.0.0.1',
      port: rendererPort,
      strictPort: true,
      cors: false,
      allowedHosts: ['127.0.0.1'],
      headers: {
        'Content-Security-Policy': rendererContentSecurityPolicy({
          developmentWebSocketOrigin: rendererOrigin.replace(/^http:/u, 'ws:'),
          developmentScriptSources: [VITE_REACT_REFRESH_PREAMBLE_SOURCE]
        }),
        'X-Frame-Options': 'DENY'
      },
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest) => {
              proxyRequest.setHeader(DEV_API_TOKEN_HEADER, devProxyToken(apiPort) ?? '');
            });
            proxy.on('proxyRes', (proxyResponse, _request, response) => {
              const closeInterruptedResponse = () => {
                if (!response.writableEnded) {
                  response.destroy();
                }
              };
              proxyResponse.once('aborted', closeInterruptedResponse);
              proxyResponse.once('error', closeInterruptedResponse);
            });
            proxy.on('error', (_error, _request, response) => {
              if ('writeHead' in response && !response.headersSent) {
                sendDevApiProxyError(response);
                return;
              }
              response.destroy();
            });
          }
        }
      }
    },
    test: {
      environment: 'node',
      // The suite exercises many fsync-heavy stores, Git subprocesses, and real
      // stdio provider fixtures. Bounding file workers keeps those integration
      // tests deterministic on developer machines instead of letting unrelated
      // files exhaust I/O and trip Vitest's short unit-test timeout.
      minWorkers: 1,
      maxWorkers: 1,
      testTimeout: 10_000,
      include: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'scripts/**/*.{test,spec}.mjs'
      ]
    }
  };
});

interface DevProxyTokenGlobal {
  __taskMonkiDevApiTokens?: Map<number, string>;
}

function devProxyToken(apiPort: number): string | undefined {
  const state = globalThis as typeof globalThis & DevProxyTokenGlobal;
  const tokens = (state.__taskMonkiDevApiTokens ??= new Map());
  const fresh = consumeDevApiToken(apiPort);
  if (fresh) tokens.set(apiPort, fresh);
  return tokens.get(apiPort);
}

function devApiOriginGuard(expectedOrigin: string): Plugin {
  return {
    name: 'task-monki-dev-api-origin-guard',
    configureServer(server) {
      server.middlewares.use('/api', (request, response, next) => {
        if (isAllowedDevRendererRequest(request.headers, expectedOrigin)) {
          next();
          return;
        }

        const requestId = randomUUID();
        response.writeHead(403, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'x-request-id': requestId
        });
        response.end(
          JSON.stringify({
            error: {
              code: 'INVALID_ORIGIN',
              message: 'Cross-site requests are not allowed.',
              retryable: false,
              requestId
            }
          })
        );
      });
    }
  };
}

function sendDevApiProxyError(response: import('node:http').ServerResponse): void {
  const requestId = randomUUID();
  response.writeHead(502, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-request-id': requestId
  });
  response.end(
    JSON.stringify({
      error: {
        code: 'DEV_API_UNAVAILABLE',
        message: 'The development API is unavailable.',
        retryable: true,
        requestId
      }
    })
  );
}
