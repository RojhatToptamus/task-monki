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
import {
  resolveDesignBrowserRuntimePaths,
  resolveDesignBrowserSocketRoot
} from '../core/design/AgentBrowserRuntimePath';
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
  browserOperations: string[];
  checks: string[];
}

interface BrowserExpectations {
  openAtLeast?: number;
  screenshotsAtLeast?: number;
  screenshotsAtMost?: number;
  viewportsAtLeast?: number;
  actions?: string[];
  operations?: string[];
  noBrowser?: boolean;
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
  const keepFailedRoot =
    process.env.TASK_MONKI_DESIGN_AGENT_KEEP_FAILED_ROOT === '1';
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-design-agent-acceptance-')
  );
  let service: TaskManagerService | undefined;
  let store: FileTaskStore | undefined;
  const scenarios: ScenarioResult[] = [];
  let failure: unknown;

  try {
    store = new FileTaskStore(path.join(root, 'store'));
    service = createService(root, store);
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
    if (
      codex.preflight.capabilities.extensions[
        'task-monki.design-browser-verification'
      ]?.maturity !== 'stable'
    ) {
      throw new Error('Codex does not report Design browser verification.');
    }

    const interactive = await createAndWait(service, store, {
      name: 'form-invalid-corrected-success',
      brief: [
        'Create a responsive workshop-interest page for a neighborhood garden.',
        'Include one short email form with a required email field and submit button.',
        'Use client-side validation with a specific invalid-email error and a clear success state.',
        'Keep keyboard access and visible focus. Use no network service, persistence, or fake delay.',
        'During rendered verification, submit an invalid value, use the browser fill action to enter a valid email, click submit, and inspect the success state.',
        'Use realistic local content and one complete visual direction. Do not ask setup questions.'
      ].join(' '),
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedSkills: [
        'browser-verification',
        'interaction-states-review',
        'accessibility-review'
      ],
      browser: {
        openAtLeast: 1,
        actions: ['fill', 'click']
      },
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

    const menu = await createAndWait(service, store, {
      name: 'menu-dialog-keyboard',
      brief: [
        'Create a simple class-information page for a local ceramics studio.',
        'Include a keyboard-accessible Help menu and a modal class-details dialog.',
        'Give both controls visible focus and correct open, close, and Escape behavior.',
        'During rendered verification, use a click to open a control, use the keyboard to open or move through the other control, press Escape, and inspect focus and closing behavior.',
        'Use realistic local content and no network service. Build one complete direction without setup questions.'
      ].join(' '),
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedSkills: [
        'browser-verification',
        'interaction-states-review',
        'accessibility-review'
      ],
      browser: {
        openAtLeast: 1,
        actions: ['click', 'key']
      },
      sourceChecks: [
        ['uses a dialog', /<dialog\b|role=["']dialog/iu],
        ['provides visible keyboard focus', /focus-visible/iu],
        ['implements keyboard behavior', /keydown|Escape/iu]
      ]
    });
    scenarios.push(menu.result);

    const responsive = await createAndWait(service, store, {
      name: 'responsive-wide-narrow',
      brief: [
        'Create a responsive class-listing page for a neighborhood art school.',
        'The wide layout must use its space well, and the narrow layout must remain clear without clipping or horizontal scroll.',
        'During rendered verification, inspect and capture the initial wide layout, set a narrow mobile viewport, and inspect and capture the narrow layout.',
        'Use realistic local content and no network service. Build one complete direction without setup questions.'
      ].join(' '),
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedSkills: ['browser-verification'],
      browser: {
        openAtLeast: 1,
        screenshotsAtLeast: 2,
        viewportsAtLeast: 1
      },
      sourceChecks: [
        ['defines a narrow layout', /@media[\s\S]*(max-width|width\s*<)/iu],
        ['prevents horizontal overflow', /overflow-x|grid-template-columns|flex-wrap/iu]
      ]
    });
    scenarios.push(responsive.result);

    const motion = await createAndWait(service, store, {
      name: 'hover-motion-frames',
      brief: [
        'Create a focused workshop page for a local printmaking studio.',
        'Include one primary workshop card with an exact "See details" button.',
        'Add a meaningful hover transition to the card using movement and opacity without clipping or layout shift. Support reduced motion.',
        'During rendered verification, capture the resting state, use the browser hover action, and capture enough relevant intermediate or settled states across the transition to judge movement, opacity, easing, clipping, and layout stability.',
        'Also set reduced-motion media on the final candidate and inspect the result. A rejected browser operation does not count. Do not use a fixed frame count.',
        'Use realistic local content and no network service. Build one complete direction without setup questions.'
      ].join(' '),
      model,
      reasoningEffort,
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedSkills: ['browser-verification', 'interaction-states-review'],
      browser: {
        openAtLeast: 1,
        screenshotsAtLeast: 2,
        actions: ['hover'],
        operations: ['set_media']
      },
      sourceChecks: [
        ['uses the required details label', /See details/u],
        ['includes a hover transition', /:hover[\s\S]*transition|transition[\s\S]*:hover/iu],
        ['supports reduced motion', /prefers-reduced-motion/iu]
      ]
    });
    scenarios.push(motion.result);

    await addRenderedDefect(motion.detail);
    const correction = await submitAndWait(service, store, motion.detail.design.id, {
      name: 'rendered-defect-fresh-candidate-correction',
      message: [
        'Before editing, open the current exact candidate and inspect it at a normal viewport.',
        'Find and correct the visible rendered defect in the current page. The current source contains one erroneous rule that causes it; remove that root cause instead of adding a compensating override. Do not assume the source alone proves the result.',
        'After the correction, open and visually verify a fresh candidate before you finish.',
        'Preserve the page direction, controls, motion, responsive behavior, and content.'
      ].join(' '),
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedOutcome: 'NO_CHANGE',
      browser: {
        openAtLeast: 2,
        screenshotsAtLeast: 1
      },
      sourceChecks: [
        ['preserves the printmaking context', /printmaking|print studio/iu],
        ['preserves reduced motion', /prefers-reduced-motion/iu]
      ],
      sourceRejectChecks: [
        ['removes the injected rendered defect', /task-monki-rendered-defect/iu]
      ]
    });
    scenarios.push(correction.result);

    const copyOnly = await submitAndWait(service, store, motion.detail.design.id, {
      name: 'copy-only-base-browser-check',
      message: [
        'Change only the short "See details" button label to "Studio details".',
        'The replacement fits the existing control. Preserve all layout, behavior, motion, and other copy.',
        'Use the required base browser check. This copy-only change does not need a screenshot sweep.'
      ].join(' '),
      timeoutMs,
      expectedQuestionRounds: 0,
      browser: { openAtLeast: 1, screenshotsAtMost: 0 },
      sourceChecks: [
        ['uses the new short label', /Studio details/u],
        ['preserves reduced motion', /prefers-reduced-motion/iu]
      ]
    });
    scenarios.push(copyOnly.result);

    const noChange = await submitAndWait(service, store, motion.detail.design.id, {
      name: 'ready-no-change-skips-browser',
      message: 'Keep the current Design exactly as it is. Do not change any source file.',
      timeoutMs,
      expectedQuestionRounds: 0,
      expectedOutcome: 'NO_CHANGE',
      browser: { noBrowser: true },
      sourceChecks: [
        ['keeps the copy-only label', /Studio details/u],
        ['keeps the printmaking context', /printmaking|print studio/iu]
      ]
    });
    scenarios.push(noChange.result);

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
    if (failure && keepFailedRoot) {
      console.error(`[design-agent] Retained failed run at ${root}`);
    } else {
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], 'Acceptance run and cleanup both failed.')
          : error;
      }
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

function createService(root: string, store: FileTaskStore): TaskManagerService {
  const packagedBrowserRoot = optionalText(
    process.env.TASK_MONKI_DESIGN_BROWSER_RUNTIME_ROOT
  );
  const browser = packagedBrowserRoot
    ? {
        executablePath: path.join(packagedBrowserRoot, 'agent-browser'),
        browserExecutablePath: path.join(
          packagedBrowserRoot,
          'chrome',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing'
        )
      }
    : resolveDesignBrowserRuntimePaths({
        isPackaged: false,
        resourcesPath: '',
        appPath: process.cwd()
      });
  return new TaskManagerService(
    store,
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
      designBrowserExecutablePath: browser.executablePath,
      designBrowserChromeExecutablePath: browser.browserExecutablePath,
      designBrowserScratchRoot: path.join(root, 'design-browser-runtime'),
      designBrowserSocketRoot: resolveDesignBrowserSocketRoot(root),
      designBrowserRequireCodeSignature: Boolean(packagedBrowserRoot),
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
  store: FileTaskStore,
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
    sourceRejectChecks?: Array<readonly [string, RegExp]>;
    browser?: BrowserExpectations;
    expectedOutcome?: 'READY' | 'NO_CHANGE';
  }
): Promise<{ detail: DesignDetailSnapshot; source: string; result: ScenarioResult }> {
  console.log(`[design-agent] Start ${input.name}.`);
  const detail = await service.createBlankDesign({
    brief: input.brief,
    creationToken: `${input.name}-${Date.now()}`,
    model: input.model,
    reasoningEffort: input.reasoningEffort
  });
  const result = await waitAndInspect(service, store, detail.design.id, input);
  console.log(`[design-agent] Passed ${input.name}.`);
  return result;
}

async function submitAndWait(
  service: TaskManagerService,
  store: FileTaskStore,
  designId: string,
  input: {
    name: string;
    message: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    expectedSkills?: string[];
    sourceChecks: Array<readonly [string, RegExp]>;
    sourceRejectChecks?: Array<readonly [string, RegExp]>;
    browser?: BrowserExpectations;
    expectedOutcome?: 'READY' | 'NO_CHANGE';
  }
): Promise<{ detail: DesignDetailSnapshot; source: string; result: ScenarioResult }> {
  console.log(`[design-agent] Start ${input.name}.`);
  await service.submitDesignTurn({
    designId,
    clientMessageId: `${input.name}-${Date.now()}`,
    message: input.message,
    referenceIds: []
  });
  const result = await waitAndInspect(service, store, designId, input);
  console.log(`[design-agent] Passed ${input.name}.`);
  return result;
}

async function waitAndInspect(
  service: TaskManagerService,
  store: FileTaskStore,
  designId: string,
  input: {
    name: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    expectedSkills?: string[];
    answerQuestions?: (questions: readonly AgentUserInputQuestion[]) => Record<string, string[]>;
    sourceChecks: Array<readonly [string, RegExp]>;
    sourceRejectChecks?: Array<readonly [string, RegExp]>;
    browser?: BrowserExpectations;
    expectedOutcome?: 'READY' | 'NO_CHANGE';
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
      const expectedOutcome = input.expectedOutcome ?? 'READY';
      if (turn.outcome !== expectedOutcome) {
        throw new Error(
          `${input.name} produced ${turn.outcome}; expected ${expectedOutcome}. ${
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
  const runItems = await store.getAgentItemsForRun(runId);
  assertNoForbiddenToolFlow(input.name, runItems);
  const browserOperations = observedBrowserOperations(runItems);
  assertBrowserExpectations(
    input.name,
    browserOperations,
    input.browser ?? { openAtLeast: 1 }
  );
  const skillsRead = observedSkills(runItems);
  for (const skill of input.expectedSkills ?? []) {
    if (!skillsRead.includes(skill)) {
      throw new Error(`${input.name} did not read the expected ${skill} skill.`);
    }
  }

  const sourceTree = await readSourceTree(requireWorktree(detail));
  assertStandaloneSourceStructure(input.name, sourceTree);
  if (
    /(?:src|href)\s*=\s*["']https?:\/\/|@import\s+(?:url\()?\s*["']?https?:\/\/|url\(\s*["']?https?:\/\//iu.test(
      sourceTree.source
    )
  ) {
    throw new Error(`${input.name} added a remote runtime asset or URL.`);
  }
  const checks: string[] = ['kept the standalone Design source structure'];
  for (const [label, pattern] of input.sourceChecks) {
    if (!pattern.test(sourceTree.source)) {
      throw new Error(`${input.name} failed its source check: ${label}.`);
    }
    checks.push(label);
  }
  for (const [label, pattern] of input.sourceRejectChecks ?? []) {
    if (pattern.test(sourceTree.source)) {
      throw new Error(`${input.name} failed its source check: ${label}.`);
    }
    checks.push(label);
  }
  const previewStatus = await requestActivePreview(detail.currentPreview!);
  checks.push('served the ready revision through managed Preview');

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
      browserOperations,
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
  if (/agent-browser|playwright|puppeteer|capture[^\n]{0,40}canvas/iu.test(toolPayload)) {
    throw new Error(`${name} started a browser flow outside inspect_design.`);
  }
  if (/git\s+(commit|push)|skills\/extraRoots\/set|preview\s+(start|stop|open)/iu.test(toolPayload)) {
    throw new Error(`${name} used a forbidden Git, skill-root, or Preview operation.`);
  }
}

function observedBrowserOperations(items: readonly AgentItemRecord[]): string[] {
  return items.flatMap((item) => {
    if (
      item.type !== 'DYNAMIC_TOOL_CALL' ||
      item.status !== 'COMPLETED' ||
      !isRecord(item.payload)
    ) {
      return [];
    }
    if (item.payload.tool !== 'inspect_design' || !isRecord(item.payload.arguments)) {
      return [];
    }
    const operation = item.payload.arguments.operation;
    if (typeof operation !== 'string') return [];
    if (operation !== 'act') return [operation];
    const action = item.payload.arguments.action;
    return [typeof action === 'string' ? `act:${action}` : 'act'];
  });
}

function assertBrowserExpectations(
  name: string,
  operations: readonly string[],
  expected: BrowserExpectations
): void {
  if (expected.noBrowser) {
    if (operations.length > 0) {
      throw new Error(`${name} used browser verification for a true no-change turn.`);
    }
    return;
  }
  assertOperationCount(name, operations, 'open_candidate', expected.openAtLeast ?? 1);
  if (expected.screenshotsAtLeast !== undefined) {
    assertOperationCount(name, operations, 'screenshot', expected.screenshotsAtLeast);
  }
  if (
    expected.screenshotsAtMost !== undefined &&
    countOperation(operations, 'screenshot') > expected.screenshotsAtMost
  ) {
    throw new Error(
      `${name} took ${countOperation(operations, 'screenshot')} screenshots; expected at most ${expected.screenshotsAtMost}.`
    );
  }
  if (expected.viewportsAtLeast !== undefined) {
    assertOperationCount(name, operations, 'set_viewport', expected.viewportsAtLeast);
  }
  for (const action of expected.actions ?? []) {
    if (!operations.includes(`act:${action}`)) {
      throw new Error(`${name} did not exercise the ${action} browser action.`);
    }
  }
  for (const operation of expected.operations ?? []) {
    if (!operations.includes(operation)) {
      throw new Error(`${name} did not use the ${operation} browser operation.`);
    }
  }
}

function assertOperationCount(
  name: string,
  operations: readonly string[],
  operation: string,
  minimum: number
): void {
  const count = countOperation(operations, operation);
  if (count < minimum) {
    throw new Error(
      `${name} used ${operation} ${count} times; expected at least ${minimum}.`
    );
  }
}

function countOperation(operations: readonly string[], operation: string): number {
  return operations.filter((candidate) => candidate === operation).length;
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
): Promise<{ files: string[]; source: string; contents: Map<string, string> }> {
  const files: string[] = [];
  const chunks: string[] = [];
  const contents = new Map<string, string>();
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
      contents.set(relative, content);
      chunks.push(`\n--- ${relative} ---\n${content}`);
      if (files.length > MAX_SOURCE_FILES || bytes > MAX_SOURCE_BYTES) {
        throw new Error('Design acceptance source exceeds its inspection limit.');
      }
    }
  };
  await visit(root);
  files.sort();
  return { files, source: chunks.join(''), contents };
}

function assertStandaloneSourceStructure(
  name: string,
  sourceTree: { files: readonly string[]; contents: ReadonlyMap<string, string> }
): void {
  for (const required of ['index.html', 'styles.css', 'app.js']) {
    if (!sourceTree.contents.has(required)) {
      throw new Error(`${name} is missing required source file ${required}.`);
    }
  }
  if (!sourceTree.files.some((file) => file.startsWith('assets/'))) {
    throw new Error(`${name} removed the standalone assets directory.`);
  }
  const unexpected = sourceTree.files.filter(
    (file) => !['index.html', 'styles.css', 'app.js'].includes(file) && !file.startsWith('assets/')
  );
  if (unexpected.length > 0) {
    throw new Error(`${name} added unsupported source paths: ${unexpected.join(', ')}.`);
  }

  const index = sourceTree.contents.get('index.html')!;
  if (!/href=["']\.\/styles\.css["']/iu.test(index)) {
    throw new Error(`${name} does not load ./styles.css from index.html.`);
  }
  if (!/<script\b(?=[^>]*\bsrc=["']\.\/app\.js["'])(?=[^>]*\bdefer\b)[^>]*>/iu.test(index)) {
    throw new Error(`${name} does not load ./app.js with defer from index.html.`);
  }
  if (/<style\b|\sstyle\s*=|\son[a-z]+\s*=|<script\b(?![^>]*\bsrc=["']\.\/app\.js["'])/iu.test(index)) {
    throw new Error(`${name} placed CSS or JavaScript inline in index.html.`);
  }
  if (/(?:src|href)\s*=\s*["'](?:\/|\.\.\/|file:)/iu.test(index)) {
    throw new Error(`${name} used an unsafe non-relative project path.`);
  }
}

async function addRenderedDefect(detail: DesignDetailSnapshot): Promise<void> {
  const indexPath = path.join(requireWorktree(detail), 'index.html');
  await fs.appendFile(
    indexPath,
    [
      '',
      '<style id="task-monki-rendered-defect">',
      'body { opacity: 0 !important; }',
      '</style>',
      ''
    ].join('\n'),
    'utf8'
  );
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

function errorLines(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(errorLines)];
  }
  if (error instanceof Error) {
    return [
      error.message,
      ...(error.cause === undefined ? [] : errorLines(error.cause))
    ];
  }
  return [String(error)];
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    for (const line of errorLines(error)) console.error(`[design-agent] ${line}`);
    process.exitCode = 1;
  });
}
