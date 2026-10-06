import { previewSpecSchema } from 'previewhost';
import { PREVIEW_FRAMEWORK_CAPABILITIES_VERSION } from './PreviewFrameworkCapabilities';

export const PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION = 'task-monki-preview-recipe-generation/v5' as const;
// The runtime producer supplies this schema; Task Monki does not maintain a second recipe language.
export const PREVIEW_RECIPE_GENERATION_CONTRACT = previewSpecSchema.toJSONSchema();

export const PREVIEW_RECIPE_GENERATION_EXAMPLES = {
  native: `name: application
type: environment
primary: web
services:
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    readyPath: /ready
`,
  data: `name: application
type: environment
primary: api
services:
  database:
    type: postgres
  migrate:
    type: job
    cwd: .
    command: [node, migrate.mjs]
    env:
      DATABASE_URL: {service: database}
  api:
    type: command
    cwd: .
    command: [node, server.mjs]
    dependsOn: [migrate]
    readyPath: /ready
    env:
      DATABASE_URL: {service: database}
      API_TOKEN: {secret: application/dev/api}
`,
  dependency: `name: frontend
type: environment
primary: web
services:
  backend:
    type: attach
    check: false
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    env:
      API_URL: {service: backend}
`,
  compose: `name: application
type: compose
cwd: .
files: [compose.yaml]
rootServices: [web]
services:
  - id: web
    ports:
      http: {target: 3000}
    ready: {type: tcp, port: http}
primary: {service: web, port: http}
`
} as const;

export interface PreviewRecipeGenerationInstructionInput {
  evidenceFileName: string;
  clarification?: string;
  questions?: readonly string[];
}

export function buildPreviewRecipeGenerationInstruction(
  input: PreviewRecipeGenerationInstructionInput
): string {
  return [
    'Do not send a progress message. Your entire response must be the final JSON object.',
    '',
    `You are generating a Task Monki Preview recipe using support contract ${PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION}.`,
    '',
    `Inspect only the sanitized, bounded repository evidence in ${input.evidenceFileName}.`,
    'The evidence bundle maps relative repository paths to safe text content and may include narrowly derived lockfile facts without exposing full lockfile contents. It intentionally excludes likely secret-bearing, binary, generated, dependency/cache, and oversized file contents.',
    'Do not inspect any other path. Do not run the application, tests, package scripts, containers, Docker, network services, or repository commands.',
    'Do not modify files. Do not commit, push, approve, or start Preview.',
    '',
    ...(input.clarification ? [
      `User clarification: ${JSON.stringify({ questions: input.questions ?? [], answer: input.clarification })}`,
      'Treat this clarification as user decisions, not repository evidence or execution approval.',
      'Verify proposed commands against the supplied source when available. Report any conflict instead of silently overriding the evidence.',
      ''
    ] : []),
    'Generate only evidence-backed configuration. Never guess commands, service ports, health paths, Compose services, migration behavior, or external dependencies.',
    'Native commands receive an allocated PORT and HOST=127.0.0.1. A ports entry maps a named port to another environment key.',
    'Arguments can use literal {port} or {port:NAME} placeholders. There is no implicit shell or $PORT expansion.',
    'Use the exact evidenced environment key or command-line flag that controls the listener. Disable automatic port fallback.',
    'Use frameworkCapabilities portBinding and compatiblePreviewCommand when available. Otherwise inspect source for the port and host behavior.',
    'HTTP readiness accepts response headers with status 200–399. It does not follow redirects or inspect response bodies.',
    'Choose an evidenced readiness path. For database-backed services, prefer an endpoint that checks the required tables.',
    'Workers require an evidenced readiness probe: HTTP, TCP, or a finite command. A worker cannot be the primary HTTP service.',
    'Never reproduce or infer secret values. Credentials must use {secret: project-specific-reference} on their exact environment recipient; never invent a secret value.',
    'Do not use fromEnv. This application does not supply owner inputs. Use evidenced nonsecret literals or supported service and secret references.',
    'Treat publicEnvironment as trusted derived metadata, never as raw env-file content. Do not infer any omitted value.',
    'Return exactly one publicEnvironmentDecision for every publicEnvironment candidate, including when status is insufficient-evidence.',
    'Include attachmentId only for HTTP_ATTACHMENT. Omit the field for SOURCE_DEFAULT and OMIT.',
    'A browser-facing API origin affects functional Preview behavior even when the frontend can boot without it.',
    'When source and tracked template targets conflict, use a type: attach service without a url, requiring owner selection rather than silently choosing either endpoint.',
    'Do not model NEXT_PUBLIC values as secrets. Do not add attachment readiness unless startup gating and its check are evidenced.',
    `Treat frameworkCapabilities using schema ${PREVIEW_FRAMEWORK_CAPABILITIES_VERSION} as trusted, versioned Task Monki capability evidence.`,
    'When compatiblePreviewCommand is present, use that exact argv command unless separate repository evidence proves another compatible command. Do not report the listed port, protocol, or hostname conflicts as unresolved.',
    'When dependencyPreparation is present, emit exactly one type: job service using its exact cwd and installCommand. Every service or worker using compatiblePreviewCommand must include that job ID in dependsOn.',
    'Copy dependencyPreparation yamlCommentLines exactly above that install command. npm ci may run repository and dependency lifecycle scripts; do not duplicate standard lifecycle scripts as separate jobs.',
    'Never use npm exec, npx, pnpm dlx, or yarn dlx to acquire a missing runtime package implicitly. Add a custom package script job only when repository evidence proves that exact script is required.',
    'When yamlCommentLines are present, copy those lines exactly immediately before the service command so the Preview-only deviation is visible during review.',
    'If a framework analysis has no compatiblePreviewCommand, honor its limitation and do not invent a rewrite.',
    'Inspect all relevant bundle contents before declaring evidence insufficient. Do not ask for facts already present in the bundle.',
    'If a valid minimal recipe still needs user decisions, return insufficient-evidence with at most three focused questions in unresolvedDecisions.',
    'Each question must identify the missing fact and the relevant evidence. Ask only for nonsecret decisions, never credential values.',
    '',
    'Your response must contain exactly one JSON object. Do not include markdown, commentary, planning, progress, or any other text.',
    'Include every required top-level field and array. Use an empty array when a report list has no items. Do not add unknown fields.',
    'Every report string must be nonempty, single-line, and at most 1200 UTF-8 bytes. evidence, assumptions, and omissions can each contain at most 40 items. unresolvedDecisions can contain at most three questions.',
    'A draft requires a complete YAML string and at least one evidence item. insufficient-evidence requires yaml: null and at least one unresolvedDecisions item.',
    'The JSON object must match:',
    JSON.stringify(
      {
        schemaVersion: PREVIEW_RECIPE_GENERATION_SUPPORT_VERSION,
        status: 'draft | insufficient-evidence',
        yaml: 'complete YAML string when status=draft; null otherwise',
        summary: 'short review summary',
        evidence: [{ path: 'relative/path', finding: 'specific fact supporting the draft' }],
        assumptions: ['explicit non-secret assumption'],
        omissions: ['intentionally unsupported or unevidenced item'],
        unresolvedDecisions: ['decision the user must make before a safe draft is possible'],
        publicEnvironmentDecisions: [{
          candidateId: 'exact candidate id from publicEnvironment',
          key: 'exact candidate key',
          decision: 'HTTP_ATTACHMENT | SOURCE_DEFAULT | OMIT',
          reason: 'bounded evidence-backed reason',
          attachmentId: 'required only for HTTP_ATTACHMENT'
        }]
      },
      null,
      2
    ),
    '',
    'Every evidence path must exactly match files[].path, frameworkCapabilities.analyses[].dependencyPreparation.lockfilePath, or publicEnvironment.templates[].path in the evidence bundle.',
    'Do not cite repository-evidence.json, frameworkCapabilities, publicEnvironment, or another metadata container name as an evidence path.',
    'Keep all report entries concise and omit empty speculation.',
    'The YAML must be complete, minimal, readable, and below 64 KiB. Use short comments only for non-obvious fields.',
    'Use one YAML 1.2 object without duplicate keys, aliases, merge keys, or tags.',
    '',
    'Return YAML for root preview.yaml. The user reviews it, and Task Monki saves it only after acceptance.',
    'Use a simple project name. Task Monki supplies the worktree identity at execution.',
    'File cwd and directory fields can be relative to preview.yaml. Use evidenced worktree folders, not guessed sibling repositories or external paths.',
    'An unresolved public API origin uses a service with type: attach, check: false, and no url. Bind its consumers with {service: attachment-id}. The owner selects the real endpoint in Configuration. Add check: true only with an evidenced readiness path.',
    'Use type: environment for multiple services, jobs, workers, or databases. All nodes live in services. primary names an HTTP command, static, or attached service. Additional HTTP named ports use routes; private TCP ports do not.',
    'Current machine-readable authoring contract (generated from the installed Previewhost parser):',
    JSON.stringify(PREVIEW_RECIPE_GENERATION_CONTRACT, null, 2),
    '',
    'Safe examples (illustrative only; do not copy fields without matching evidence):',
    JSON.stringify(PREVIEW_RECIPE_GENERATION_EXAMPLES, null, 2)
  ].join('\n');
}
