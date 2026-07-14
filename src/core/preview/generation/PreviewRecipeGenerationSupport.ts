export const PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION =
  'task-monki-preview-recipe-generation/v1' as const;

/**
 * Authoring contract supplied to the generator. The strict Preview parser is
 * still the semantic authority; this object is intentionally guidance rather
 * than a second executable schema.
 */
export const PREVIEW_RECIPE_GENERATION_CONTRACT = {
  schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
  recipe: {
    path: '.taskmonki/preview.yaml',
    version: 1,
    maximumBytes: 65_536,
    identifierPattern: '^[a-z][a-z0-9-]{0,47}$',
    environmentKeyPattern: '^[A-Z_][A-Z0-9_]*$',
    commands: 'argv arrays only; never shell command strings',
    paths: 'repository-relative, non-escaping paths only',
    topLevelFields: [
      'version',
      'inputs',
      'attachments',
      'jobs',
      'resources',
      'services',
      'workers',
      'routes',
      'scenarios',
      'defaultScenario',
      'compose'
    ]
  },
  native: {
    service: {
      required: ['command', 'ports', 'ready'],
      optional: ['label', 'cwd', 'needs', 'env', 'critical', 'restart', 'liveness']
    },
    worker: {
      required: ['command', 'ready'],
      optional: ['label', 'cwd', 'needs', 'env', 'ports', 'critical', 'restart', 'liveness', 'overlap']
    },
    job: {
      required: ['command'],
      optional: ['label', 'cwd', 'needs', 'env', 'role', 'retrySafe']
    },
    route: {
      required: ['service', 'port', 'primary'],
      rules: ['at least one route', 'exactly one primary route', 'route targets a critical service port']
    },
    readiness: {
      http: ['type', 'port', 'path', 'timeoutSeconds'],
      tcp: ['type', 'port', 'timeoutSeconds'],
      argv: ['type', 'cwd', 'command', 'timeoutSeconds', 'env']
    },
    privateInputs: {
      declaration: { type: 'private', optional: ['label'] },
      delivery: { type: 'private-input', input: '<input-id>' },
      rule: 'Never place a secret value in YAML; declare identity and exact recipient only.'
    },
    managedResources: {
      types: ['postgres', 'redis'],
      urlReferences: ['postgres-url', 'redis-url'],
      rule: 'A URL recipient must explicitly need the matching resource ready.'
    },
    attachments: {
      types: ['http', 'tcp', 'postgres', 'redis'],
      targets: ['endpoint', 'local'],
      references: [
        'attached-http-origin',
        'attached-tcp-host',
        'attached-tcp-port',
        'attached-postgres-url',
        'attached-redis-url'
      ],
      rule: 'Attachments are non-owned. A check runs only through an explicit needs: ready edge.'
    }
  },
  compose: {
    required: ['files', 'projectDirectory', 'profiles', 'rootServices', 'services'],
    optional: [],
    service: ['ports', 'ready'],
    rules: [
      'Do not mix Compose with native nodes, inputs, attachments, or managed resources.',
      'Only describe Compose files and services proven by repository evidence.',
      'Do not inspect or reproduce env-file or file-secret values.'
    ]
  },
  safety: [
    'Use only commands, paths, ports, scripts, and health endpoints supported by inspected evidence.',
    'Do not invent a readiness endpoint. Prefer a proven TCP readiness check when only port listening is evidenced.',
    'Never emit credentials, tokens, passwords, private keys, connection strings containing credentials, or values from secret-bearing files.',
    'Keep the recipe minimal. Omit optional fields that are not needed or evidenced.',
    'Add short YAML comments only when they explain a non-obvious authority or limitation.'
  ]
} as const;

export const PREVIEW_RECIPE_GENERATION_EXAMPLES = {
  minimalNative: `version: 1

services:
  web:
    command: [node, server.mjs]
    env:
      NODE_ENV: development
    ports:
      http: { env: PORT }
    ready:
      type: http
      port: http
      path: /ready
      timeoutSeconds: 30

routes:
  app:
    service: web
    port: http
    primary: true
`,
  privateInputAndManagedData: `version: 1

inputs:
  api-token:
    type: private
    label: API token

resources:
  database:
    type: postgres
    database: preview_app

services:
  api:
    command: [node, apps/api/server.mjs]
    needs: { database: ready }
    env:
      API_TOKEN: { type: private-input, input: api-token }
      DATABASE_URL: { type: postgres-url, resource: database }
    ports:
      http: { env: PORT }
    ready: { type: tcp, port: http }

routes:
  app: { service: api, port: http, primary: true }
`,
  compose: `version: 1

compose:
  files: [compose.yaml]
  projectDirectory: .
  profiles: []
  rootServices: [web]
  services:
    web:
      ports:
        http: { target: 3000 }
      ready:
        type: tcp
        port: http
        timeoutSeconds: 30

routes:
  app: { service: web, port: http, primary: true }
`
} as const;

export interface PreviewRecipeGenerationInstructionInput {
  evidenceFileName: string;
}

export function buildPreviewRecipeGenerationInstruction(
  input: PreviewRecipeGenerationInstructionInput
): string {
  return [
    `You are generating a Task Monki Preview recipe using support contract ${PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION}.`,
    '',
    `Inspect only the sanitized, bounded repository evidence in ${input.evidenceFileName}.`,
    'The evidence bundle maps relative repository paths to text content. It intentionally excludes likely secret-bearing, binary, generated, dependency/cache, and oversized files.',
    'Do not inspect any other path. Do not run the application, tests, package scripts, containers, Docker, network services, or repository commands.',
    'Do not modify files. Do not commit, push, approve, or start Preview.',
    '',
    'Generate only evidence-backed configuration. Never guess commands, service ports, health paths, Compose services, migration behavior, or external dependencies.',
    'Never reproduce or infer secret values. Private data must use a declared private input and an exact typed recipient.',
    'If the evidence is insufficient for a valid minimal recipe, return insufficient-evidence and explain the unresolved decisions instead of inventing authority.',
    '',
    'Return exactly one JSON object and no markdown fence. It must match:',
    JSON.stringify(
      {
        schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
        status: 'draft | insufficient-evidence',
        yaml: 'complete YAML string when status=draft; null otherwise',
        summary: 'short review summary',
        evidence: [{ path: 'relative/path', finding: 'specific fact supporting the draft' }],
        assumptions: ['explicit non-secret assumption'],
        omissions: ['intentionally unsupported or unevidenced item'],
        unresolvedDecisions: ['decision the user must make before a safe draft is possible']
      },
      null,
      2
    ),
    '',
    'Every evidence path must exist in the evidence bundle. Keep all report entries concise and omit empty speculation.',
    'The YAML must be complete, minimal, readable, and below 64 KiB. Use short comments only for non-obvious fields.',
    '',
    'Current machine-readable authoring contract:',
    JSON.stringify(PREVIEW_RECIPE_GENERATION_CONTRACT, null, 2),
    '',
    'Safe examples (illustrative only; do not copy fields without matching evidence):',
    JSON.stringify(PREVIEW_RECIPE_GENERATION_EXAMPLES, null, 2)
  ].join('\n');
}
