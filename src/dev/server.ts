import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import type { AppUpdateEvent } from '../shared/contracts';

const port = Number(process.env.TASK_MANAGER_API_PORT ?? 3099);
const defaultRepositoryPath = process.env.TASK_MANAGER_REPO_PATH ?? process.cwd();
const storeDir =
  process.env.TASK_MANAGER_STORE_DIR ?? path.join(os.tmpdir(), 'task-manager-phase1-dev-store');

const service = new TaskManagerService(new FileTaskStore(storeDir), defaultRepositoryPath);
const clients = new Set<http.ServerResponse>();

function sendEvent(response: http.ServerResponse, event: AppUpdateEvent): void {
  response.write(`event: update\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

async function route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/defaultRepositoryPath') {
      sendJson(response, 200, await service.getDefaultRepositoryPath());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      sendJson(response, 200, await service.listTasks());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/repository/validate') {
      const body = (await readJson(request)) as { path: string };
      sendJson(response, 200, await service.validateRepository(body.path));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      sendJson(response, 200, await service.createTask((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/start') {
      sendJson(response, 200, await service.startRun((await readJson(request)) as never));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/runs/cancel') {
      await service.cancelRun((await readJson(request)) as never);
      sendJson(response, 200, {});
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/artifact/read') {
      const text = await service.readArtifact((await readJson(request)) as never);
      sendJson(response, 200, text);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unknown server error.'
    });
  }
}

service.events.on((event) => {
  for (const client of clients) {
    sendEvent(client, event);
  }
});

service.init().then(() => {
  http.createServer((request, response) => void route(request, response)).listen(port, '127.0.0.1', () => {
    console.log(`Task Manager dev API listening on http://127.0.0.1:${port}`);
    console.log(`Store: ${storeDir}`);
    console.log(`Default repository: ${defaultRepositoryPath}`);
  });
});
