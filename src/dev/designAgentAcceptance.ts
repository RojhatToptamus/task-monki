import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentItemRecord,
  AgentUserInputQuestion,
  InteractionRequestRecord
} from '../shared/agent';
import type {
  DesignDetailSnapshot,
  PreviewGenerationRecord
} from '../shared/contracts';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { FileTaskStore } from '../core/storage/FileTaskStore';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 250;
const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

interface ScenarioResult {
  name: string;
  designId: string;
  runId: string;
  outcome: string;
  questionRounds: number;
  skillsRead: string[];
  sourceFiles: string[];
  previewStatus: number;
  checks: string[];
}

interface AcceptanceReport {
  status: 'PASSED';
  model?: string;
  reasoningEffort?: string;
  scenarios: ScenarioResult[];
  temporaryRootRemoved: true;
}

async function main(): Promise<void> {
  const timeoutMs = positiveInteger(
    process.env.TASK_MONKI_DESIGN_AGENT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const model = optionalText(process.env.TASK_MONKI_DESIGN_AGENT_MODEL);
  const reasoningEffort = optionalText(
    process.env.TASK_MONKI_DESIGN_AGENT_REASONING_EFFORT
  );
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-design-agent-acceptance-')
  );
  let service: TaskManagerService | undefined;
  const scenarios: ScenarioResult[] = [];
  let failure: unknown;

  try {
    service = createService(root);
    await service.init();
    const capabilities = await service.getAgentRuntimeCatalog();
    const codex = capabilities.runtimes.find(
      (runtime) => runtime.preflight.runtime.id === 'codex'
    );
    if (!codex?.preflight.readiness.canStart) {
      throw new Error(
        `Codex is not ready: ${codex?.preflight.readiness.summary ?? 'runtime missing'}`
      );
    }
    if (
      codex.preflight.capabilities.extensions['task-monki.design-skill-access']
        ?.maturity !== 'stable'
    ) {
      throw new Error('Codex does not report scoped Design skill access.');
    }

    const foundation = await createAndWait(service, {
      name: 'clear-greenfield-page',
      brief: [
        'Create a responsive single-page website for Northstar, a weekly planning studio for freelance architects.',
        'The audience is experienced solo architects who want calmer schedules.',
        'Use one focused route with a hero, a three-step weekly method, one short client example, and a final signup action.',
        'Use the supplied facts only. Northstar offers a weekly planning session and a printable plan.',
        'Use a deliberate navy #13233f and coral #e76f51 system with 6px corners.',
        'Use the exact headline "Plan the week. Keep the evenings." and footer text "Northstar planning studio".',
        'Make it work on desktop and mobile. Build one complete direction without asking setup questions.'
      ].join(' '),
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedSkills: ['aesthetic-direction'],
      sourceChecks: [
        ['keeps the navy system color', /#13233f/iu],
        ['keeps the coral system color', /#e76f51/iu],
        ['uses the required headline', /Plan the week\. Keep the evenings\./u],
        ['uses the required footer', /Northstar planning studio/u]
      ]
    });
    scenarios.push(foundation.result);

    const beforeRefinement = foundation.source;
    const refinement = await submitAndWait(service, foundation.detail.design.id, {
      name: 'focused-visual-refinement-and-existing-system',
      message: [
        'Change only the main signup button label to "Build my week" and make the header more compact.',
        'Preserve the navy #13233f and coral #e76f51 colors, 6px corners, headline, sections, client example, and footer.',
        'Do not redesign unrelated areas.'
      ].join(' '),
      timeoutMs,
      expectedQuestionRounds: 0,
      sourceChecks: [
        ['uses the new action label', /Build my week/u],
        ['preserves the navy system color', /#13233f/iu],
        ['preserves the coral system color', /#e76f51/iu],
        ['preserves the headline', /Plan the week\. Keep the evenings\./u],
        ['preserves the footer', /Northstar planning studio/u]
      ]
    });
    assertRefinementPreserved(beforeRefinement, refinement.source);
    refinement.result.checks.push('preserved the existing system and unrelated content');
    scenarios.push(refinement.result);

    const ambiguous = await createAndWait(service, {
      name: 'ambiguous-product-request',
      brief: 'Design the main product experience for Luma. Decide what it needs.',
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 1,
      expectedSkills: ['discovery-questions'],
      answerQuestions: answerAmbiguousLumaQuestions,
      sourceChecks: [
        ['uses the clarified manuscript context', /manuscript|editor|review inbox/iu],
        ['contains a main interface entry point', /<main\b/iu]
      ]
    });
    scenarios.push(ambiguous.result);

    const options = await createAndWait(service, {
      name: 'explicit-options-request',
      brief: [
        'Create one responsive comparison page with three distinct directions for a public-library event listing.',
        'Use the same realistic event content in all three options.',
        'Vary layout, hierarchy, density, and interaction emphasis, not only color.',
        'Label each direction, state its tradeoff, and recommend one.',
        'This is an explicit options request. Do not ask setup questions.'
      ].join(' '),
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedSkills: ['variations'],
      sourceChecks: [
        ['shows three labeled directions', /(direction|option|variation)[\s\S]*(direction|option|variation)[\s\S]*(direction|option|variation)/iu],
        ['uses library event content', /library|author|workshop|reading/iu]
      ]
    });
    scenarios.push(options.result);

    const interactive = await createAndWait(service, {
      name: 'interactive-form-flow',
      brief: [
        'Create a responsive application flow for applying to a neighborhood garden plot.',
        'Include name, email, household size, experience level, and plot preference.',
        'Use client-side validation with specific field errors, a review step, back navigation, and a clear success state.',
        'Keep keyboard access and visible focus. Use no network service or fake delay.',
        'Use realistic local content and one complete visual direction. Do not ask setup questions.'
      ].join(' '),
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedSkills: [
        'prototype',
        'interaction-states-review',
        'accessibility-review'
      ],
      sourceChecks: [
        ['uses a semantic form', /<form\b/iu],
        ['uses associated labels', /<label\b[^>]*for=/iu],
        ['implements client-side behavior', /addEventListener|onsubmit/iu],
        ['provides visible keyboard focus', /focus-visible/iu],
        ['provides accessible status or error links', /aria-live|aria-describedby/iu],
        ['does not add browser persistence', /^(?![\s\S]*(localStorage|sessionStorage))[\s\S]*$/iu]
      ]
    });
    scenarios.push(interactive.result);

  } catch (error) {
    failure = error;
  } finally {
    if (service) {
      try {
        await service.shutdown();
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], 'Acceptance run and shutdown both failed.')
          : error;
      }
    }
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Acceptance run and cleanup both failed.')
        : error;
    }
  }

  if (failure) throw failure;
  const report: AcceptanceReport = {
    status: 'PASSED',
    model,
    reasoningEffort,
    scenarios,
    temporaryRootRemoved: true
  };
  console.log(`[design-agent] ${JSON.stringify(report, null, 2)}`);
}

function createService(root: string): TaskManagerService {
  return new TaskManagerService(
    new FileTaskStore(path.join(root, 'store')),
    root,
    undefined,
    {
      agentCwd: root,
      worktreeRoot: path.join(root, 'normal-worktrees'),
      previewEnabled: true,
      previewReconcile: false,
      previewRoot: path.join(root, 'preview-runtime'),
      previewLauncherPath: path.resolve(
        'src/core/preview/runtime/native-preview-launcher.mjs'
      ),
      managedDesignStaticServerPath: path.resolve(
        'src/core/preview/runtime/managed-design-static-server.mjs'
      ),
      designRepositoryRoot: path.join(root, 'design-repositories'),
      designWorktreeRoot: path.join(root, 'design-worktrees'),
      designDraftRoot: path.join(root, 'design-drafts'),
      designSkillRoot: path.resolve('resources/design-skills'),
      designCanvasFence: {
        async begin() {
          return {
            async commit() {},
            async rollback() {}
          };
        }
      }
    }
  );
}

async function createAndWait(
  service: TaskManagerService,
  input: {
    name: string;
    brief: string;
    model?: string;
    reasoningEffort?: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    expectedSkills?: string[];
    answerQuestions?: (questions: readonly AgentUserInputQuestion[]) => Record<string, string[]>;
    sourceChecks: Array<readonly [string, RegExp]>;
  }
): Promise<{ detail: DesignDetailSnapshot; source: string; result: ScenarioResult }> {
  console.log(`[design-agent] Start ${input.name}.`);
  const detail = await service.createBlankDesign({
    brief: input.brief,
    creationToken: `${input.name}-${Date.now()}`,
    model: input.model,
    reasoningEffort: input.reasoningEffort
  });
  const result = await waitAndInspect(service, detail.design.id, input);
  console.log(`[design-agent] Passed ${input.name}.`);
  return result;
}

async function submitAndWait(
  service: TaskManagerService,
  designId: string,
  input: {
    name: string;
    message: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    expectedSkills?: string[];
    sourceChecks: Array<readonly [string, RegExp]>;
  }
): Promise<{ detail: DesignDetailSnapshot; source: string; result: ScenarioResult }> {
  console.log(`[design-agent] Start ${input.name}.`);
  await service.submitDesignTurn({
    designId,
    clientMessageId: `${input.name}-${Date.now()}`,
    message: input.message
  });
  const result = await waitAndInspect(service, designId, input);
  console.log(`[design-agent] Passed ${input.name}.`);
  return result;
}

async function waitAndInspect(
  service: TaskManagerService,
  designId: string,
  input: {
    name: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    expectedSkills?: string[];
    answerQuestions?: (questions: readonly AgentUserInputQuestion[]) => Record<string, string[]>;
    sourceChecks: Array<readonly [string, RegExp]>;
  }
): Promise<{ detail: DesignDetailSnapshot; source: string; result: ScenarioResult }> {
  const deadline = Date.now() + input.timeoutMs;
  const answered = new Set<string>();
  let observedRunId: string | undefined;
  let detail = await service.getDesign(designId);

  for (;;) {
    const pending = detail.interactions.filter(
      (interaction) => interaction.type === 'USER_INPUT' && interaction.status === 'PENDING'
    );
    for (const interaction of pending) {
      if (!input.answerQuestions) {
        throw new Error(`${input.name} asked an unexpected setup question.`);
      }
      if (answered.size > 0) {
        throw new Error(`${input.name} asked more than one question round.`);
      }
      const questions = userInputQuestions(interaction);
      await service.respondToInteraction({
        taskId: designId,
        runId: interaction.runId,
        interactionRequestId: interaction.id,
        decision: {
          interactionType: 'USER_INPUT',
          action: 'ANSWER',
          answers: input.answerQuestions(questions)
        }
      });
      answered.add(interaction.id);
    }

    if (detail.currentRun?.id) {
      if (observedRunId && observedRunId !== detail.currentRun.id) {
        throw new Error(`${input.name} started a hidden replacement Design turn.`);
      }
      observedRunId = detail.currentRun.id;
    }
    const turn = detail.turns.at(-1);
    if (turn?.outcome) {
      if (turn.outcome !== 'READY') {
        throw new Error(
          `${input.name} did not produce a ready revision: ${turn.outcome} ${
            turn.failureReason ?? ''
          }`
        );
      }
      if (detail.canvas.state !== 'READY' || !detail.currentPreview) {
        throw new Error(`${input.name} settled without a ready managed Preview.`);
      }
      break;
    }
    if (Date.now() >= deadline) {
      if (detail.currentRun?.id) {
        await service.cancelRun({ runId: detail.currentRun.id }).catch(() => undefined);
      }
      throw new Error(`${input.name} exceeded its ${input.timeoutMs}ms deadline.`);
    }
    await delay(POLL_MS);
    detail = await service.getDesign(designId);
  }

  detail = await service.getDesign(designId);
  const snapshot = await service.listTasks();
  const questionRounds = snapshot.interactionRequests.filter(
    (interaction) => interaction.taskId === designId && interaction.type === 'USER_INPUT'
  ).length;
  if (questionRounds !== input.expectedQuestionRounds) {
    throw new Error(
      `${input.name} produced ${questionRounds} question rounds; expected ${input.expectedQuestionRounds}.`
    );
  }
  const taskRuns = snapshot.runs.filter((run) => run.taskId === designId);
  const designTurnCount = detail.turns.length;
  if (
    taskRuns.length !== designTurnCount ||
    taskRuns.some((run) => run.mode !== 'DESIGN') ||
    snapshot.agentSubagentObservations.some((observation) => observation.taskId === designId)
  ) {
    throw new Error(`${input.name} started a reviewer, hidden turn, or subagent.`);
  }
  const turn = detail.turns.at(-1)!;
  if (!turn.outcome) throw new Error(`${input.name} did not settle its Design turn.`);
  const runId = turn.runId;
  if (!runId || runId !== observedRunId) {
    throw new Error(`${input.name} did not resume and finish its observed Design turn.`);
  }
  const runItems = snapshot.agentItems.filter((item) => item.runId === runId);
  assertNoForbiddenToolFlow(input.name, runItems);
  const skillsRead = observedSkills(runItems);
  for (const skill of input.expectedSkills ?? []) {
    if (!skillsRead.includes(skill)) {
      throw new Error(`${input.name} did not read the expected ${skill} skill.`);
    }
  }

  const sourceTree = await readSourceTree(requireWorktree(detail));
  if (
    /(?:src|href)\s*=\s*["']https?:\/\/|@import\s+(?:url\()?\s*["']?https?:\/\/|url\(\s*["']?https?:\/\//iu.test(
      sourceTree.source
    )
  ) {
    throw new Error(`${input.name} added a remote runtime asset or URL.`);
  }
  const checks: string[] = [];
  for (const [label, pattern] of input.sourceChecks) {
    if (!pattern.test(sourceTree.source)) {
      throw new Error(`${input.name} failed its source check: ${label}.`);
    }
    checks.push(label);
  }
  const previewStatus = await requestActivePreview(detail.currentPreview!);
  checks.push('served the ready revision through managed Preview');
  const finalMessage = detail.conversation.at(-1)?.assistantMessage ?? '';
  if (/visually verified|pixel[- ]perfect|rendered exactly as expected/iu.test(finalMessage)) {
    throw new Error(`${input.name} made an unsupported rendered-output claim.`);
  }

  return {
    detail,
    source: sourceTree.source,
    result: {
      name: input.name,
      designId,
      runId,
      outcome: turn.outcome,
      questionRounds,
      skillsRead,
      sourceFiles: sourceTree.files,
      previewStatus,
      checks
    }
  };
}

function userInputQuestions(interaction: InteractionRequestRecord): AgentUserInputQuestion[] {
  const request = interaction.request as { questions?: unknown };
  if (!Array.isArray(request.questions) || request.questions.length === 0) {
    throw new Error('Design question round has no questions.');
  }
  return request.questions as AgentUserInputQuestion[];
}

function answerAmbiguousLumaQuestions(
  questions: readonly AgentUserInputQuestion[]
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const text = `${question.header} ${question.question}`.toLowerCase();
    answers[question.id] = [
      text.includes('audience') || text.includes('user')
        ? 'Independent book editors who manage several manuscripts.'
        : text.includes('goal') || text.includes('purpose') || text.includes('task')
          ? 'Make the review inbox the main screen and help editors find the next manuscript action.'
          : text.includes('brand') || text.includes('style') || text.includes('tone')
            ? 'No existing brand. Use a calm, precise, editorial product tone without a warm-cream house style.'
            : text.includes('scope') || text.includes('screen') || text.includes('format')
              ? 'Build one responsive desktop-first review inbox with useful mobile behavior.'
              : 'Luma is a web app for tracking manuscript reviews. Choose one complete direction.'
    ];
  }
  return answers;
}

function observedSkills(items: readonly AgentItemRecord[]): string[] {
  const matches = new Set<string>();
  for (const item of items) {
    if (!['COMMAND_EXECUTION', 'MCP_TOOL_CALL', 'DYNAMIC_TOOL_CALL'].includes(item.type)) {
      continue;
    }
    const payload = JSON.stringify(item.payload);
    for (const match of payload.matchAll(
      /design-skills[\\/]([a-z][a-z0-9-]*)[\\/]SKILL\.md/giu
    )) {
      if (match[1]) matches.add(match[1]);
    }
  }
  return [...matches].sort();
}

function assertNoForbiddenToolFlow(name: string, items: readonly AgentItemRecord[]): void {
  const toolPayload = items
    .filter((item) =>
      ['COMMAND_EXECUTION', 'MCP_TOOL_CALL', 'DYNAMIC_TOOL_CALL', 'WEB_SEARCH'].includes(
        item.type
      )
    )
    .map(toolInvocationText)
    .join('\n');
  if (/screenshot|capture[^\n]{0,40}canvas/iu.test(toolPayload)) {
    throw new Error(`${name} started a screenshot flow.`);
  }
  if (/git\s+(commit|push)|skills\/extraRoots\/set|preview\s+(start|stop|open)/iu.test(toolPayload)) {
    throw new Error(`${name} used a forbidden Git, skill-root, or Preview operation.`);
  }
}

function toolInvocationText(item: AgentItemRecord): string {
  const payload = isRecord(item.payload) ? item.payload : {};
  switch (item.type) {
    case 'COMMAND_EXECUTION':
      return typeof payload.command === 'string' ? payload.command : '';
    case 'MCP_TOOL_CALL':
    case 'DYNAMIC_TOOL_CALL':
      return JSON.stringify({
        server: payload.server,
        tool: payload.tool,
        name: payload.name,
        arguments: payload.arguments,
        input: payload.input
      });
    case 'WEB_SEARCH':
      return JSON.stringify({ query: payload.query });
    default:
      return '';
  }
}

async function readSourceTree(
  root: string
): Promise<{ files: string[]; source: string }> {
  const files: string[] = [];
  const chunks: string[] = [];
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const content = await fs.readFile(absolute, 'utf8');
      bytes += Buffer.byteLength(content, 'utf8');
      files.push(relative);
      chunks.push(`\n--- ${relative} ---\n${content}`);
      if (files.length > MAX_SOURCE_FILES || bytes > MAX_SOURCE_BYTES) {
        throw new Error('Design acceptance source exceeds its inspection limit.');
      }
    }
  };
  await visit(root);
  files.sort();
  return { files, source: chunks.join('') };
}

function assertRefinementPreserved(before: string, after: string): void {
  for (const value of [
    '#13233f',
    '#e76f51',
    'Plan the week. Keep the evenings.',
    'Northstar planning studio'
  ]) {
    if (!before.toLowerCase().includes(value.toLowerCase())) {
      throw new Error(`The foundation source did not contain ${value}.`);
    }
    if (!after.toLowerCase().includes(value.toLowerCase())) {
      throw new Error(`The focused refinement removed ${value}.`);
    }
  }
}

function requireWorktree(detail: DesignDetailSnapshot): string {
  if (!detail.currentWorktree) throw new Error('Design worktree is missing.');
  return detail.currentWorktree.worktreePath;
}

function requestActivePreview(generation: PreviewGenerationRecord): Promise<number> {
  const route = generation.routes.find((candidate) => candidate.state === 'ATTACHED');
  if (!route) throw new Error('Ready Design Preview route is missing.');
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port: route.gatewayPort,
        path: '/',
        headers: { host: route.hostname },
        timeout: 5_000
      },
      (response) => {
        response.resume();
        response.once('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Managed Preview returned ${response.statusCode}.`));
            return;
          }
          resolve(response.statusCode);
        });
      }
    );
    request.once('timeout', () => request.destroy(new Error('Managed Preview timed out.')));
    request.once('error', reject);
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('TASK_MONKI_DESIGN_AGENT_TIMEOUT_MS must be a positive integer.');
  }
  return parsed;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(
      `[design-agent] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
