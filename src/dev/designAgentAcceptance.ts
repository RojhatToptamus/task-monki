import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentItemRecord,
  AgentModel,
  AgentUserInputQuestion,
  InteractionRequestRecord
} from '../shared/agent';
import type {
  DesignDetailSnapshot,
  PreviewGenerationRecord
} from '../shared/contracts';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { isTaskMonkiInspectDesignToolCall } from '../core/agent/acp/AcpRuntimeAdapter';
import { OPENCODE_DESIGN_TOOL_NAME } from '../core/agent/opencode/OpenCodeProtocol';
import {
  resolveDesignBrowserRuntimePaths,
  resolveDesignBrowserSocketRoot
} from '../core/design/AgentBrowserRuntimePath';
import { INSPECT_DESIGN_TOOL_NAME } from '../core/design/DesignClientToolContract';
import { SqliteTaskStore } from '../core/storage/SqliteTaskStore';
import { ApplicationPersistence } from '../core/storage/sqlite/ApplicationPersistence';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 250;
const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const FOCUSED_SCENARIOS = [
  'structured-question',
  'form-invalid-corrected-success',
  'menu-dialog-keyboard',
  'responsive-wide-narrow',
  'theme-errors-interaction',
  'hover-motion-frames'
] as const;
const VISUAL_FACT_ASSET = 'assets/visual-check.png';
const VISUAL_FACT = 'TM-7Q4';
const VISUAL_FACT_PNG_BASE64 =
  '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';

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
  mediaSchemes?: Array<'light' | 'dark'>;
  reducedMotion?: boolean;
  disclosureEnterToggle?: true;
  actions?: string[];
  operations?: string[];
  noBrowser?: boolean;
}

interface AcceptanceReport {
  status: 'PASSED';
  runtimeId: string;
  runtimeVersion?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  scenarios: ScenarioResult[];
  temporaryRootRemoved: true;
}

type FocusedScenario = (typeof FOCUSED_SCENARIOS)[number];

export function resolveDesignAgentCandidateModel(
  models: readonly AgentModel[],
  input: {
    runtimeId: string;
    model: string;
    modelProvider?: string;
  }
): { selectedModel?: AgentModel; modelProvider?: string } {
  const matches = models.filter(
    (candidate) =>
      candidate.model === input.model &&
      (!input.modelProvider || candidate.modelProvider === input.modelProvider)
  );
  if (!input.modelProvider && matches.length > 1) {
    throw new Error(
      `${input.runtimeId} exposes ${input.model} through more than one provider. Set TASK_MONKI_DESIGN_AGENT_MODEL_PROVIDER.`
    );
  }
  const selectedModel = matches[0];
  return {
    selectedModel,
    modelProvider: selectedModel?.modelProvider ?? input.modelProvider
  };
}

export function parseFocusedDesignAgentScenario(
  value: string | undefined
): FocusedScenario | undefined {
  const scenario = optionalText(value);
  if (!scenario) return undefined;
  if ((FOCUSED_SCENARIOS as readonly string[]).includes(scenario)) {
    return scenario as FocusedScenario;
  }
  throw new Error(
    `Unknown Design agent scenario: ${scenario}. Expected ${FOCUSED_SCENARIOS.join(', ')}.`
  );
}

async function main(): Promise<void> {
  const timeoutMs = positiveInteger(
    process.env.TASK_MONKI_DESIGN_AGENT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const runtimeId =
    optionalText(process.env.TASK_MONKI_DESIGN_AGENT_RUNTIME_ID) ?? 'codex';
  const model = optionalText(process.env.TASK_MONKI_DESIGN_AGENT_MODEL);
  if (!model) {
    throw new Error(
      'TASK_MONKI_DESIGN_AGENT_MODEL is required for exact Design qualification.'
    );
  }
  const requestedModelProvider = optionalText(
    process.env.TASK_MONKI_DESIGN_AGENT_MODEL_PROVIDER
  );
  const reasoningEffort = optionalText(
    process.env.TASK_MONKI_DESIGN_AGENT_REASONING_EFFORT
  );
  const focusedScenario = parseFocusedDesignAgentScenario(
    process.env.TASK_MONKI_DESIGN_AGENT_SCENARIO
  );
  const keepFailedRoot =
    process.env.TASK_MONKI_DESIGN_AGENT_KEEP_FAILED_ROOT === '1';
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-design-agent-acceptance-')
  );
  let service: TaskManagerService | undefined;
  let store: SqliteTaskStore | undefined;
  let persistence: ApplicationPersistence | undefined;
  const scenarios: ScenarioResult[] = [];
  let runtimeVersion: string | undefined;
  let modelProvider: string | undefined;
  let failure: unknown;

  try {
    persistence = await ApplicationPersistence.open({
      profileRoot: path.join(root, 'profile'),
      appVersion: 'design-agent-acceptance'
    });
    store = persistence.tasks;
    service = createService(root, persistence, runtimeId);
    await service.init();
    let capabilities = await service.getAgentRuntimeCatalog();
    let runtime = capabilities.runtimes.find(
      (candidate) => candidate.preflight.runtime.id === runtimeId
    );
    const matchesRequestedModel = (candidate: AgentModel) =>
      candidate.model === model &&
      (!requestedModelProvider || candidate.modelProvider === requestedModelProvider);
    const modelCatalogNeedsActivation = Boolean(
      runtime?.preflight.capabilities.modelCatalog.activation === 'EXPLICIT' &&
        runtime.preflight.readiness.checks.modelCatalog !== 'AVAILABLE'
    );
    if (
      modelCatalogNeedsActivation ||
      (model && !runtime?.models.some(matchesRequestedModel))
    ) {
      await service.discoverAgentRuntimeModels(runtimeId);
      capabilities = await service.getAgentRuntimeCatalog();
      runtime = capabilities.runtimes.find(
        (candidate) => candidate.preflight.runtime.id === runtimeId
      );
    }
    if (!runtime?.preflight.readiness.canStart) {
      throw new Error(
        `${runtimeId} is not ready: ${runtime?.preflight.readiness.summary ?? 'runtime missing'}`
      );
    }
    runtimeVersion = runtime.preflight.runtimeVersion;
    const selection = model
      ? resolveDesignAgentCandidateModel(runtime.models, {
          runtimeId,
          model,
          modelProvider: requestedModelProvider
        })
      : { modelProvider: requestedModelProvider };
    modelProvider = selection.modelProvider;
    if (
      runtime.preflight.capabilities.extensions['task-monki.design-skill-access']
        ?.maturity !== 'stable'
    ) {
      throw new Error(`${runtimeId} does not report scoped Design skill access.`);
    }
    if (
      runtime.preflight.capabilities.extensions[
        'task-monki.design-browser-verification'
      ]?.maturity !== 'stable'
    ) {
      throw new Error(`${runtimeId} does not report Design browser verification.`);
    }
    if (!focusedScenario || focusedScenario === 'structured-question') {
      const question = await createAndWait(service, store, {
        name: 'structured-question',
        runtimeId,
        modelProvider,
        brief: [
          'Create a farmers market website, but do not choose its product scope yet.',
          'Ask one structured question that lets me choose between a public shopper guide and an internal vendor operations page.',
          'After I answer, continue the same turn and build the selected direction.',
          'Keep structure in index.html, CSS in styles.css, and JavaScript in app.js.',
          'Use realistic local content and no network service.'
        ].join(' '),
        model,
        reasoningEffort,
        timeoutMs,
        expectedQuestionRounds: 1,
        answerQuestions: (questions) =>
          Object.fromEntries(
            questions.map((item) => [item.id, ['Decide for me']])
          ),
        browser: { openAtLeast: 1 },
        sourceChecks: [
          ['builds a market page', /farmer|vendor|market/iu],
          ['includes a clear primary flow', /browse|visit|apply|manage|schedule|inventory/iu]
        ]
      });
      scenarios.push(question.result);
    }
    if (!focusedScenario || focusedScenario === 'form-invalid-corrected-success') {
      const interactive = await createAndWait(service, store, {
        name: 'form-invalid-corrected-success',
        runtimeId,
        modelProvider,
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
        requiredSkills: ['browser-verification'],
        browser: {
          openAtLeast: 1,
          actions: ['fill', 'click']
        },
        sourceChecks: [
          ['uses a semantic form', /<form\b/iu],
          ['uses associated labels', /<label\b[^>]*for=/iu],
          ['implements client-side behavior', /addEventListener|onsubmit/iu],
          ['provides visible keyboard focus', /:focus(?:-visible)?/iu],
          ['provides accessible status or error links', /aria-live|aria-describedby/iu],
          [
            'does not add browser persistence',
            /^(?![\s\S]*(localStorage|sessionStorage))[\s\S]*$/iu
          ]
        ]
      });
      scenarios.push(interactive.result);
    }

    if (!focusedScenario || focusedScenario === 'menu-dialog-keyboard') {
      const menu = await createAndWait(service, store, {
        name: 'menu-dialog-keyboard',
        runtimeId,
        modelProvider,
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
        requiredSkills: ['browser-verification'],
        browser: {
          openAtLeast: 1,
          actions: ['click', 'key']
        },
        sourceChecks: [
          ['uses a dialog', /<dialog\b|role=["']dialog/iu],
          ['provides visible keyboard focus', /:focus(?:-visible)?/iu],
          ['implements keyboard behavior', /keydown|Escape/iu]
        ]
      });
      scenarios.push(menu.result);
    }

    if (!focusedScenario || focusedScenario === 'responsive-wide-narrow') {
      const responsive = await createAndWait(service, store, {
        name: 'responsive-wide-narrow',
        runtimeId,
        modelProvider,
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
        requiredSkills: ['browser-verification'],
        browser: {
          openAtLeast: 1,
          screenshotsAtLeast: 2,
          viewportsAtLeast: 1
        },
        sourceChecks: [
          ['defines a narrow layout', /@media[\s\S]*(max-width|width\s*<)/iu],
          [
            'prevents horizontal overflow',
            /overflow-x|grid-template-columns|flex-wrap/iu
          ]
        ]
      });
      scenarios.push(responsive.result);
    }

    if (!focusedScenario || focusedScenario === 'theme-errors-interaction') {
      const stateful = await createAndWait(service, store, {
        name: 'theme-accessibility-interaction-state',
        runtimeId,
        modelProvider,
        brief: [
          'Create a compact settings page for a neighborhood workshop.',
          'Include one disclosure control that changes visible content and keeps aria-expanded accurate.',
          'Provide intentional light and dark color schemes, visible keyboard focus, and reduced-motion support.',
          'During rendered verification, set light media and capture it. Set dark media and capture it.',
          'Use the browser focus action on the disclosure, then use the key action with Enter to exercise it.',
          'Inspect one reduced-motion state and run the bounded accessibility audit.',
          'Use realistic local content and no network service. Build one complete direction without setup questions.'
        ].join(' '),
        model,
        reasoningEffort,
        timeoutMs,
        expectedQuestionRounds: 0,
        requiredSkills: [
          'browser-verification',
          'interaction-states-review',
          'accessibility-review'
        ],
        browser: {
          openAtLeast: 1,
          screenshotsAtLeast: 2,
          mediaSchemes: ['light', 'dark'],
          reducedMotion: true,
          disclosureEnterToggle: true,
          operations: ['accessibility']
        },
        sourceChecks: [
          ['supports dark media', /prefers-color-scheme\s*:\s*dark/iu],
          ['tracks disclosure state', /aria-expanded/iu],
          ['provides visible keyboard focus', /:focus(?:-visible)?/iu],
          ['supports reduced motion', /prefers-reduced-motion/iu]
        ]
      });
      scenarios.push(stateful.result);

      await addBrowserEvidenceDefects(stateful.detail);
      const recovered = await submitAndWait(service, store, stateful.detail.design.id, {
        name: 'missing-asset-client-error-recovery',
        message: [
          'Open the current exact candidate before changing source.',
          'Use its rendered snapshot, console, and runtime errors to find the broken local asset and client error.',
          'Remove both root causes. Preserve the light and dark themes, keyboard focus, reduced motion, and disclosure behavior.',
          'After the correction, open and verify a fresh candidate. Exercise the disclosure again and use one screenshot if visual judgment helps.'
        ].join(' '),
        timeoutMs,
        expectedQuestionRounds: 0,
        acceptedOutcomes: ['READY', 'NO_CHANGE'],
        browser: {
          openAtLeast: 2,
          screenshotsAtLeast: 1
        },
        sourceChecks: [
          ['preserves dark media', /prefers-color-scheme\s*:\s*dark/iu],
          ['preserves disclosure state', /aria-expanded/iu]
        ],
        sourceRejectChecks: [
          ['removes the missing local asset', /task-monki-missing-asset/iu],
          ['removes the client error', /task-monki-client-error/iu]
        ]
      });
      scenarios.push(recovered.result);
    }

    if (!focusedScenario || focusedScenario === 'hover-motion-frames') {
      const motion = await createAndWait(service, store, {
        name: 'hover-motion-frames',
        runtimeId,
        modelProvider,
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
        requiredSkills: ['browser-verification'],
        browser: {
          openAtLeast: 1,
          screenshotsAtLeast: 2,
          actions: ['hover'],
          operations: ['set_media']
        },
        sourceChecks: [
          ['uses the required details label', /See details/u],
          [
            'includes a hover transition',
            /:hover[\s\S]*transition|transition[\s\S]*:hover/iu
          ],
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
        acceptedOutcomes: ['READY', 'NO_CHANGE'],
        browser: {
          openAtLeast: 2,
          screenshotsAtLeast: 1
        },
        sourceChecks: [
          ['preserves reduced motion', /prefers-reduced-motion/iu]
        ],
        sourceRejectChecks: [
          ['removes the injected rendered defect', /task-monki-rendered-defect/iu]
        ]
      });
      scenarios.push(correction.result);

      await addVisualFactCandidate(correction.detail);
      const visualFact = await submitAndWait(
        service,
        store,
        correction.detail.design.id,
        {
          name: 'inspect-design-image-result-consumed',
          message: [
            'Open the current exact candidate and take a screenshot.',
            'The navy visual-check image contains a short code that is not present in the HTML, CSS, or JavaScript.',
            'Use the inspect_design image result to read that code.',
            'Replace only the text "Waiting for visual code" with the exact code from the image.',
            'Do not inspect the PNG through a file, shell, or image tool.'
          ].join(' '),
          timeoutMs,
          expectedQuestionRounds: 0,
          browser: { openAtLeast: 1, screenshotsAtLeast: 1 },
          forbiddenAssetToolAccess: VISUAL_FACT_ASSET,
          sourceChecks: [
            [
              'uses the unique fact from the inspect_design image result',
              new RegExp(
                `id=["']verification-answer["'][^>]*>\\s*${VISUAL_FACT}\\s*<`,
                'iu'
              )
            ]
          ]
        }
      );
      scenarios.push(visualFact.result);

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
          ['keeps reduced-motion support', /prefers-reduced-motion/iu]
        ]
      });
      scenarios.push(noChange.result);

      scenarios.push(
        await cancelAndVerifyLastReady(
          service,
          store,
          motion.detail.design.id,
          timeoutMs
        )
      );
    }
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
    if (persistence) {
      try {
        await persistence.close();
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], 'Acceptance run and persistence shutdown both failed.')
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
    runtimeId,
    runtimeVersion,
    model,
    modelProvider,
    reasoningEffort,
    scenarios,
    temporaryRootRemoved: true
  };
  console.log(`[design-agent] ${JSON.stringify(report, null, 2)}`);
}

function createService(
  root: string,
  persistence: ApplicationPersistence,
  defaultRuntimeId: string
): TaskManagerService {
  const packagedResourcesRoot = optionalText(
    process.env.TASK_MONKI_DESIGN_PACKAGED_RESOURCES_ROOT
  );
  const packagedRuntime = optionalText(
    process.env.TASK_MONKI_DESIGN_PACKAGED_RUNTIME
  );
  if (Boolean(packagedResourcesRoot) !== Boolean(packagedRuntime)) {
    throw new Error(
      'Packaged Design qualification requires both the Resources root and packaged runtime.'
    );
  }
  const packagedBrowserRoot =
    optionalText(process.env.TASK_MONKI_DESIGN_BROWSER_RUNTIME_ROOT) ??
    (packagedResourcesRoot
      ? path.join(packagedResourcesRoot, 'design-browser-runtime')
      : undefined);
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
    persistence.tasks,
    root,
    undefined,
    {
      agentCwd: root,
      defaultAgentRuntimeId: defaultRuntimeId,
      appSettingsStore: persistence.settings,
      agentRuntimeStore: persistence.agentRuntime,
      taskRuntimeAccess: persistence.taskRuntime,
      discourseStore: persistence.discourse,
      discourseWorkspaceRoot: path.join(root, 'discourse-workspaces'),
      worktreeRoot: path.join(root, 'normal-worktrees'),
      previewEnabled: true,
      previewReconcile: false,
      allowCandidateDesignModels: true,
      previewRoot: path.join(root, 'preview-runtime'),
      previewLauncherPath: packagedResourcesRoot
        ? path.join(packagedResourcesRoot, 'native-preview-launcher.mjs')
        : path.resolve('src/core/preview/runtime/native-preview-launcher.mjs'),
      managedDesignStaticServerPath: packagedResourcesRoot
        ? path.join(packagedResourcesRoot, 'managed-design-static-server.mjs')
        : path.resolve('src/core/preview/runtime/managed-design-static-server.mjs'),
      designRepositoryRoot: persistence.paths.designRepositoryRoot,
      designWorktreeRoot: persistence.paths.designWorktreeRoot,
      designDraftStore: persistence.designDrafts,
      designSkillRoot: packagedResourcesRoot
        ? path.join(packagedResourcesRoot, 'design-skills')
        : path.resolve('resources/design-skills'),
      designBrowserExecutablePath: browser.executablePath,
      designBrowserChromeExecutablePath: browser.browserExecutablePath,
      designBrowserScratchRoot: path.join(root, 'design-browser-runtime'),
      designBrowserSocketRoot: resolveDesignBrowserSocketRoot(root),
      designBrowserRequireCodeSignature: Boolean(packagedBrowserRoot),
      ...(packagedResourcesRoot && packagedRuntime
        ? {
            designToolMcpExecutablePath: packagedRuntime,
            designToolMcpServerPath: path.join(
              packagedResourcesRoot,
              'design-tool-mcp-server.mjs'
            )
          }
        : {}),
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
  store: SqliteTaskStore,
  input: {
    name: string;
    brief: string;
    runtimeId: string;
    modelProvider?: string;
    model?: string;
    reasoningEffort?: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    requiredSkills?: string[];
    answerQuestions?: (questions: readonly AgentUserInputQuestion[]) => Record<string, string[]>;
    sourceChecks: Array<readonly [string, RegExp]>;
    sourceRejectChecks?: Array<readonly [string, RegExp]>;
    browser?: BrowserExpectations;
    expectedOutcome?: 'READY' | 'NO_CHANGE';
    acceptedOutcomes?: readonly ('READY' | 'NO_CHANGE')[];
    forbiddenAssetToolAccess?: string;
  }
): Promise<{ detail: DesignDetailSnapshot; source: string; result: ScenarioResult }> {
  console.log(`[design-agent] Start ${input.name}.`);
  const detail = await service.createBlankDesign({
    brief: input.brief,
    creationToken: `${input.name}-${Date.now()}`,
    runtimeId: input.runtimeId,
    model: input.model,
    modelProvider: input.modelProvider,
    reasoningEffort: input.reasoningEffort
  });
  const result = await waitAndInspect(service, store, detail.design.id, input);
  console.log(`[design-agent] Passed ${input.name}.`);
  return result;
}

async function submitAndWait(
  service: TaskManagerService,
  store: SqliteTaskStore,
  designId: string,
  input: {
    name: string;
    message: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    requiredSkills?: string[];
    sourceChecks: Array<readonly [string, RegExp]>;
    sourceRejectChecks?: Array<readonly [string, RegExp]>;
    browser?: BrowserExpectations;
    expectedOutcome?: 'READY' | 'NO_CHANGE';
    acceptedOutcomes?: readonly ('READY' | 'NO_CHANGE')[];
    forbiddenAssetToolAccess?: string;
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

async function cancelAndVerifyLastReady(
  service: TaskManagerService,
  store: SqliteTaskStore,
  designId: string,
  timeoutMs: number
): Promise<ScenarioResult> {
  const name = 'cancellation-preserves-last-ready';
  console.log(`[design-agent] Start ${name}.`);
  const baseline = await service.getDesign(designId);
  if (baseline.canvas.state !== 'READY' || !baseline.currentPreview) {
    throw new Error(`${name} requires an existing Ready Design.`);
  }
  const baselineRevisionId = baseline.design.latestRevision?.id;
  const baselinePreviewId = baseline.currentPreview.id;
  const submitted = await service.submitDesignTurn({
    designId,
    clientMessageId: `${name}-${Date.now()}`,
    message: [
      'Open the current exact candidate.',
      'Before editing, call inspect_design with operation "act", action "wait", and milliseconds 2000.',
      'After that wait, add a new alternate workshop section with an interactive disclosure and verify it.'
    ].join(' '),
    referenceIds: []
  });
  const turn = submitted.turns.at(-1);
  if (!turn?.runId || turn.outcome) {
    throw new Error(`${name} did not start an active provider turn.`);
  }
  const admissionDeadline = Date.now() + timeoutMs;
  let admittedWait = false;
  while (!admittedWait) {
    const items = await store.getAgentItemsForRun(turn.runId);
    admittedWait = items.some((item) =>
      isInFlightInspectDesignWait(baseline.task.runtimeId, item)
    );
    if (admittedWait) break;
    const current = await service.getDesign(designId);
    const currentTurn = current.turns.find((candidate) => candidate.id === turn.id);
    if (currentTurn?.outcome) {
      throw new Error(
        `${name} settled before inspect_design admitted the required wait operation.`
      );
    }
    if (Date.now() >= admissionDeadline) {
      if (current.currentRun?.id) {
        await service.cancelRun({ runId: current.currentRun.id }).catch(() => undefined);
      }
      throw new Error(
        `${name} did not admit the required inspect_design wait operation within ${timeoutMs}ms.`
      );
    }
    await delay(POLL_MS);
  }
  await service.cancelDesignTurn({ designId, turnId: turn.id });

  const deadline = Date.now() + timeoutMs;
  let settled = await service.getDesign(designId);
  while (settled.turns.find((candidate) => candidate.id === turn.id)?.outcome !== 'CANCELED') {
    if (Date.now() >= deadline) {
      throw new Error(`${name} exceeded its ${timeoutMs}ms deadline.`);
    }
    await delay(POLL_MS);
    settled = await service.getDesign(designId);
  }
  if (
    settled.canvas.state !== 'READY' ||
    settled.design.latestRevision?.id !== baselineRevisionId ||
    settled.currentPreview?.id !== baselinePreviewId
  ) {
    throw new Error(`${name} replaced or removed the last Ready canvas.`);
  }
  console.log(`[design-agent] Passed ${name}.`);
  return {
    name,
    designId,
    runId: turn.runId,
    outcome: 'CANCELED',
    questionRounds: 0,
    skillsRead: [],
    sourceFiles: [],
    previewStatus: await requestActivePreview(settled.currentPreview),
    browserOperations: [],
    checks: [
      'cancels while an inspect_design operation is active',
      'keeps the same Ready revision and Preview after cancellation'
    ]
  };
}

async function waitAndInspect(
  service: TaskManagerService,
  store: SqliteTaskStore,
  designId: string,
  input: {
    name: string;
    timeoutMs: number;
    expectedQuestionRounds: number;
    requiredSkills?: string[];
    answerQuestions?: (questions: readonly AgentUserInputQuestion[]) => Record<string, string[]>;
    sourceChecks: Array<readonly [string, RegExp]>;
    sourceRejectChecks?: Array<readonly [string, RegExp]>;
    browser?: BrowserExpectations;
    expectedOutcome?: 'READY' | 'NO_CHANGE';
    acceptedOutcomes?: readonly ('READY' | 'NO_CHANGE')[];
    forbiddenAssetToolAccess?: string;
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
      const acceptedOutcomes = input.acceptedOutcomes ?? [input.expectedOutcome ?? 'READY'];
      if (!acceptedOutcomes.some((outcome) => outcome === turn.outcome)) {
        throw new Error(
          `${input.name} produced ${turn.outcome}; expected ${acceptedOutcomes.join(' or ')}. ${
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
  if (input.forbiddenAssetToolAccess) {
    assertNoDirectAssetInspection(
      input.name,
      detail.task.runtimeId,
      runItems,
      input.forbiddenAssetToolAccess
    );
  }
  const browserOperations = observedBrowserOperations(detail.task.runtimeId, runItems);
  assertBrowserExpectations(
    input.name,
    browserOperations,
    input.browser ?? { openAtLeast: 1 }
  );
  if (input.browser?.disclosureEnterToggle) {
    assertDisclosureEnterToggle(input.name, detail.task.runtimeId, runItems);
  }
  const skillsRead = observedSkills(runItems);
  for (const skill of input.requiredSkills ?? []) {
    if (!skillsRead.includes(skill)) {
      throw new Error(`${input.name} did not read the required ${skill} skill.`);
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
    if (!['OTHER', 'COMMAND_EXECUTION', 'MCP_TOOL_CALL', 'DYNAMIC_TOOL_CALL'].includes(item.type)) {
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
      ['OTHER', 'COMMAND_EXECUTION', 'MCP_TOOL_CALL', 'DYNAMIC_TOOL_CALL', 'WEB_SEARCH'].includes(
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

export function assertNoDirectAssetInspection(
  name: string,
  runtimeId: string,
  items: readonly AgentItemRecord[],
  assetPath: string
): void {
  const directAccess = items.find((item) => {
    if (
      ['MCP_TOOL_CALL', 'DYNAMIC_TOOL_CALL'].includes(item.type) &&
      isInspectDesignToolCall(runtimeId, item)
    ) {
      return false;
    }
    return toolInvocationText(item).includes(assetPath);
  });
  if (directAccess) {
    throw new Error(
      `${name} inspected ${assetPath} outside the inspect_design image result.`
    );
  }
}

export function observedBrowserOperations(
  runtimeId: string,
  items: readonly AgentItemRecord[]
): string[] {
  return items.flatMap((item) => {
    if (
      !['DYNAMIC_TOOL_CALL', 'MCP_TOOL_CALL'].includes(item.type) ||
      item.status !== 'COMPLETED' ||
      !isInspectDesignToolCall(runtimeId, item)
    ) {
      return [];
    }
    const payload = item.payload as Record<string, unknown>;
    const argumentsValue = inspectDesignArguments(payload);
    if (!argumentsValue) return [];
    const operation = argumentsValue.operation;
    if (typeof operation !== 'string') return [];
    if (operation === 'set_media') {
      const colorScheme = argumentsValue.colorScheme;
      const reducedMotion = argumentsValue.reducedMotion;
      return [
        colorScheme === 'light' || colorScheme === 'dark'
          ? `set_media:${colorScheme}:${reducedMotion === true ? 'reduced' : 'standard'}`
          : operation
      ];
    }
    if (operation !== 'act') return [operation];
    const action = argumentsValue.action;
    return [typeof action === 'string' ? `act:${action}` : 'act'];
  });
}

export function assertDisclosureEnterToggle(
  name: string,
  runtimeId: string,
  items: readonly AgentItemRecord[]
): void {
  const actions = items.flatMap((item) => {
    if (
      !['DYNAMIC_TOOL_CALL', 'MCP_TOOL_CALL'].includes(item.type) ||
      item.status !== 'COMPLETED' ||
      !isInspectDesignToolCall(runtimeId, item)
    ) {
      return [];
    }
    const payload = item.payload as Record<string, unknown>;
    const input = inspectDesignArguments(payload);
    if (input?.operation !== 'act' || typeof input.action !== 'string') return [];
    return [{ input, output: inspectDesignResultText(runtimeId, payload) }];
  });
  for (let index = 0; index < actions.length - 1; index += 1) {
    const focus = actions[index]!;
    const enter = actions[index + 1]!;
    if (
      focus.input.action !== 'focus' ||
      typeof focus.input.ref !== 'string' ||
      enter.input.action !== 'key' ||
      enter.input.value !== 'Enter'
    ) {
      continue;
    }
    const before = expandedStateForRef(focus.output, focus.input.ref);
    const after = expandedStateForRef(enter.output, focus.input.ref);
    if (before !== undefined && after !== undefined && before !== after) return;
  }
  throw new Error(
    `${name} did not prove that Enter changed the focused disclosure state.`
  );
}

export function isInFlightInspectDesignWait(
  runtimeId: string,
  item: AgentItemRecord
): boolean {
  // Some ACP agents omit the status on the initial tool-call event. A later
  // result adds rawOutput, so an UNKNOWN item is in flight only without output.
  if (
    !['DYNAMIC_TOOL_CALL', 'MCP_TOOL_CALL'].includes(item.type) ||
    !['STARTED', 'IN_PROGRESS', 'UNKNOWN'].includes(item.status) ||
    !isInspectDesignToolCall(runtimeId, item)
  ) {
    return false;
  }
  const payload = item.payload as Record<string, unknown>;
  if (
    'rawOutput' in payload ||
    payload.status === 'completed' ||
    payload.status === 'failed'
  ) {
    return false;
  }
  const argumentsValue = inspectDesignArguments(payload);
  return (
    argumentsValue?.operation === 'act' &&
    argumentsValue.action === 'wait' &&
    argumentsValue.milliseconds === 2_000
  );
}

function isInspectDesignToolCall(
  runtimeId: string,
  item: AgentItemRecord
): boolean {
  if (!isRecord(item.payload)) return false;
  if (item.type === 'DYNAMIC_TOOL_CALL') {
    return (
      runtimeId === 'codex' &&
      item.payload.type === 'dynamicToolCall' &&
      item.payload.tool === INSPECT_DESIGN_TOOL_NAME
    );
  }
  if (item.type !== 'MCP_TOOL_CALL') return false;
  if (
    runtimeId === 'opencode' &&
    item.payload.tool === OPENCODE_DESIGN_TOOL_NAME
  ) {
    return true;
  }
  return isTaskMonkiInspectDesignToolCall(runtimeId, {
    title: typeof item.payload.title === 'string' ? item.payload.title : undefined,
    rawInput: item.payload.rawInput,
    _meta: isRecord(item.payload._meta) ? item.payload._meta : undefined
  });
}

function inspectDesignArguments(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const state = isRecord(payload.state) ? payload.state : undefined;
  for (const value of [
    payload.arguments,
    payload.input,
    payload.rawInput,
    state?.input
  ]) {
    if (!isRecord(value)) continue;
    if (isRecord(value.args)) return value.args;
    if (isRecord(value.tool_input)) return value.tool_input;
    return value;
  }
  return undefined;
}

function inspectDesignResultText(
  runtimeId: string,
  payload: Record<string, unknown>
): string {
  const state = isRecord(payload.state) ? payload.state : undefined;
  const value =
    runtimeId === 'codex'
      ? payload.contentItems
      : runtimeId === 'opencode'
        ? state?.output
        : payload.rawOutput;
  return nestedStrings(value).join('\n');
}

function nestedStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStrings);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(nestedStrings);
}

function expandedStateForRef(output: string, ref: string): boolean | undefined {
  const snapshotRef = ref.startsWith('@') ? ref.slice(1) : ref;
  const refToken = new RegExp(
    `(?:^|[^A-Za-z0-9_-])ref=${escapeRegExp(snapshotRef)}(?=$|[^A-Za-z0-9_-])`,
    'u'
  );
  const line = output
    .split('\n')
    .find((candidate) => refToken.test(candidate) && /\bexpanded=(?:true|false)\b/u.test(candidate));
  if (!line) return undefined;
  return /\bexpanded=true\b/u.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
  for (const colorScheme of expected.mediaSchemes ?? []) {
    if (countOperation(operations, `set_media:${colorScheme}`) === 0) {
      throw new Error(`${name} did not inspect ${colorScheme} media.`);
    }
  }
  if (
    expected.reducedMotion !== undefined &&
    !operations.some((operation) =>
      operation.endsWith(expected.reducedMotion ? ':reduced' : ':standard')
    )
  ) {
    throw new Error(
      `${name} did not inspect ${expected.reducedMotion ? 'reduced-motion' : 'standard-motion'} media.`
    );
  }
  for (const action of expected.actions ?? []) {
    if (!operations.includes(`act:${action}`)) {
      throw new Error(`${name} did not exercise the ${action} browser action.`);
    }
  }
  for (const operation of expected.operations ?? []) {
    if (countOperation(operations, operation) === 0) {
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
  return operations.filter(
    (candidate) => candidate === operation || candidate.startsWith(`${operation}:`)
  ).length;
}

function toolInvocationText(item: AgentItemRecord): string {
  const payload = isRecord(item.payload) ? item.payload : {};
  const state = isRecord(payload.state) ? payload.state : undefined;
  return JSON.stringify({
    server: payload.server,
    tool: payload.tool,
    name: payload.name,
    title: payload.title,
    command: payload.command,
    query: payload.query,
    arguments: payload.arguments,
    input: payload.input,
    rawInput: payload.rawInput,
    state: state
      ? {
          title: state.title,
          input: state.input,
          arguments: state.arguments
        }
      : undefined
  });
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
      'body { min-width: 1800px !important; }',
      '</style>',
      ''
    ].join('\n'),
    'utf8'
  );
}

async function addBrowserEvidenceDefects(
  detail: DesignDetailSnapshot
): Promise<void> {
  const worktree = requireWorktree(detail);
  const indexPath = path.join(worktree, 'index.html');
  const appPath = path.join(worktree, 'app.js');
  const index = await fs.readFile(indexPath, 'utf8');
  if (!index.includes('</body>')) {
    throw new Error('Design acceptance cannot add its browser defects without </body>.');
  }
  await fs.writeFile(
    indexPath,
    index.replace(
      '</body>',
      [
        '  <img src="./assets/task-monki-missing-asset.png" alt="Missing test asset">',
        '</body>'
      ].join('\n')
    ),
    'utf8'
  );
  await fs.appendFile(
    appPath,
    '\nthrow new Error("task-monki-client-error");\n',
    'utf8'
  );
}

async function addVisualFactCandidate(
  detail: DesignDetailSnapshot
): Promise<void> {
  const worktree = requireWorktree(detail);
  const indexPath = path.join(worktree, 'index.html');
  const stylesPath = path.join(worktree, 'styles.css');
  const index = await fs.readFile(indexPath, 'utf8');
  if (!index.includes('</body>')) {
    throw new Error('Design acceptance cannot add its visual fact without </body>.');
  }
  await fs.mkdir(path.join(worktree, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(worktree, VISUAL_FACT_ASSET),
    Buffer.from(VISUAL_FACT_PNG_BASE64, 'base64')
  );
  await fs.writeFile(
    indexPath,
    index.replace(
      '</body>',
      [
        '  <section class="visual-check" aria-label="Visual verification">',
        '    <img src="./assets/visual-check.png" alt="A short code on a navy card">',
        '    <h2 id="verification-answer">Waiting for visual code</h2>',
        '  </section>',
        '</body>'
      ].join('\n')
    ),
    'utf8'
  );
  await fs.appendFile(
    stylesPath,
    [
      '',
      '.visual-check {',
      '  display: grid;',
      '  gap: 1rem;',
      '  justify-items: center;',
      '  margin: 3rem auto;',
      '}',
      '',
      '.visual-check img {',
      '  display: block;',
      '  width: min(100%, 26.25rem);',
      '  height: auto;',
      '}',
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
