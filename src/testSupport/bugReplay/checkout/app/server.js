'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { couponFor } = require('./lib/pricing');

const storePath = path.join(__dirname, 'data', 'store.json');
const publicDir = path.join(__dirname, 'public');

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, 'utf8'));
}

function writeStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function send(response, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    ...headers
  });
  response.end(text);
}

function readJson(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function session(request) {
  const match = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(request.headers.cookie || '');
  return match ? match[1] : undefined;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const sid = session(request);
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const headers = sid ? {} : { 'set-cookie': `sid=${crypto.randomBytes(8).toString('hex')}; Path=/; HttpOnly` };
    send(response, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), headers);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/app.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write('retry: 60000\n\n');
    const timer = setInterval(() => response.write(`data: ${Date.now()}\n\n`), 1500);
    request.on('close', () => clearInterval(timer));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/products') {
    send(response, 200, readStore().products);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/coupons/apply') {
    const body = await readJson(request);
    const coupon = couponFor(body.code);
    if (!coupon) {
      send(response, 404, { error: 'Unknown coupon' });
      return;
    }
    send(response, 200, { code: String(body.code).toUpperCase(), discount: coupon.amount });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/orders') {
    const body = await readJson(request);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      // Waits for an order that never comes.
      return;
    }
    const store = readStore();
    const order = { id: store.orders.length + 1, sid, items: body.items, coupon: body.coupon || null, total: body.total };
    store.orders.push(order);
    writeStore(store);
    send(response, 201, { id: order.id, total: order.total });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/orders/last') {
    const order = readStore().orders.filter((candidate) => candidate.sid && candidate.sid === sid).pop();
    if (!order) {
      send(response, 404, { error: 'No orders' });
      return;
    }
    send(response, 200, { id: order.id, total: order.total });
    return;
  }
  send(response, 404, { error: 'Not found' });
});

server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`Checkout listening on ${server.address().port}`);
});
