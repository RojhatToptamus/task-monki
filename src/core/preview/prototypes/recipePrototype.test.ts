import { describe, expect, it } from 'vitest';
import { parsePrototypeRecipe } from './recipePrototype';

const RECIPE = `
version: 1
jobs:
  prepare:
    label: Prepare application
    command: [node, scripts/prepare.mjs]
services:
  web:
    label: Start web
    command: [node, server.mjs]
    needs:
      prepare: succeeded
    env:
      NODE_ENV: development
    ports:
      http:
        env: PORT
    ready:
      type: http
      port: http
      path: /health
routes:
  app:
    service: web
    port: http
    primary: true
`;

describe('Phase 0 preview recipe and digest prototype', () => {
  it('produces a stable execution digest across YAML formatting, key order, and labels', () => {
    const first = parsePrototypeRecipe(RECIPE);
    const reformatted = parsePrototypeRecipe(`
routes: { app: { primary: true, port: http, service: web } }
services:
  web:
    ready: { path: /health, port: http, type: http, timeoutSeconds: 30 }
    ports: { http: { env: PORT } }
    env: { NODE_ENV: development }
    needs: { prepare: succeeded }
    command: [node, server.mjs]
    cwd: .
    label: A different display label
jobs:
  prepare:
    cwd: .
    command: [node, scripts/prepare.mjs]
version: 1
`);

    expect(reformatted.executionDigest).toBe(first.executionDigest);
    expect(reformatted.recipeDigest).not.toBe(first.recipeDigest);
  });

  it.each([
    ['command', RECIPE.replace('server.mjs', 'other-server.mjs')],
    ['cwd', RECIPE.replace('command: [node, server.mjs]', 'cwd: apps/web\n    command: [node, server.mjs]')],
    ['environment', RECIPE.replace('NODE_ENV: development', 'NODE_ENV: test')],
    ['readiness', RECIPE.replace('path: /health', 'path: /ready')],
    ['route', RECIPE.replace('port: http\n    primary', 'port: other\n    primary').replace('ports:\n      http:', 'ports:\n      http:\n        env: PORT\n      other:')]
  ])('changes the execution digest for a capability-bearing %s edit', (_label, changed) => {
    expect(parsePrototypeRecipe(changed).executionDigest).not.toBe(
      parsePrototypeRecipe(RECIPE).executionDigest
    );
  });

  it.each([
    ['duplicate keys', `${RECIPE}\nversion: 1\n`],
    ['alias', `version: 1\njobs: &jobs {}\nservices: *jobs\nroutes: {}\n`],
    ['merge key', `version: 1\njobs: {}\nbase: &base { command: [node, a] }\nservices: { web: { <<: *base } }\nroutes: {}\n`],
    ['custom tag', `version: 1\njobs: !custom {}\nservices: {}\nroutes: {}\n`],
    ['non-string key', `version: 1\njobs: { 3: {} }\nservices: {}\nroutes: {}\n`],
    ['unknown field', `${RECIPE}\nprivileged: true\n`]
  ])('rejects unsafe or ambiguous YAML: %s', (_label, source) => {
    expect(() => parsePrototypeRecipe(source)).toThrow();
  });

  it('rejects oversized input before parsing', () => {
    expect(() => parsePrototypeRecipe(`${RECIPE}\n#${'x'.repeat(70_000)}`)).toThrow(
      'exceeds 65536 bytes'
    );
  });

  it('parses data only and rejects JavaScript-specific executable tags', () => {
    expect(() =>
      parsePrototypeRecipe(`
version: 1
jobs: !!js/function >
  function () { return process.env; }
services: {}
routes: {}
`)
    ).toThrow();
  });
});
