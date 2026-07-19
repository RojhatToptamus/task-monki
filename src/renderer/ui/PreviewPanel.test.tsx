import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createInitialProjection,
  type PreviewGenerationRecord,
  type PreviewNodeAttemptRecord,
  type PreviewPlanRecord,
  type Task,
  type WorktreeRecord
} from '../../shared/contracts';
import {
  PreviewOverviewCard,
  PreviewRecipeGenerationModal,
  PreviewWorkspace,
  type PreviewPanelProps
} from './PreviewPanel';

describe('Preview surfaces', () => {
  it('renders exact public-target recipients instead of surfacing configuration as a global error', () => {
    const props = previewProps({ includePlan: false });
    const html = renderToStaticMarkup(
      <PreviewWorkspace
        {...props}
        resolution={{
          status: 'CONFIGURATION_REQUIRED',
          reason: 'Local preview bindings are required for: backend.',
          selectedScenarioId: 'frontend',
          requirements: [{
            attachmentId: 'backend',
            label: 'Competitions API',
            attachmentType: 'http',
            allowedTargetTypes: ['endpoint', 'task-preview-route'],
            usages: [{
              kind: 'ENVIRONMENT',
              recipient: 'PROCESS',
              nodeKind: 'SERVICE',
              nodeId: 'web',
              environmentKeys: ['NEXT_PUBLIC_API_URL']
            }]
          }]
        }}
      />
    );

    expect(html).toContain('Public targets');
    expect(html).toContain('Competitions API');
    expect(html).toContain('NEXT_PUBLIC_API_URL');
    expect(html).toContain('Another task’s Preview route');
  });

  it('keeps Overview compact and routes approval through the detailed workspace', () => {
    const html = renderToStaticMarkup(
      <PreviewOverviewCard {...previewProps()} onShowDetails={() => {}} />
    );

    expect(html).toContain('Approval required');
    expect(html).toContain('1 application node · 1 setup job · 1 route');
    expect(html).toContain('Review &amp; approve');
    expect(html).toContain('Details');
    expect(html).not.toContain('Currentness');
    expect(html).not.toContain('No attached route');
    expect(html).not.toContain('Review execution plan');
    expect(html).not.toContain('Private inputs');
    expect(html).not.toContain('View logs');
    expect(html).not.toContain('Stop Preview');
    expect(html).not.toContain('Reset database');
    expect(html).not.toContain('node&quot; &quot;server.mjs');
  });

  it('shows only status, explanation, and action before the recipe is checked', () => {
    const html = renderToStaticMarkup(
      <PreviewWorkspace {...previewProps({ includePlan: false })} />
    );

    expect(html).toContain('Not checked');
    expect(html).toContain('Check preview');
    expect(html).not.toContain('id="preview-plan-authority"');
    expect(html).not.toContain('id="preview-application"');
    expect(html).not.toContain('id="preview-routes"');
    expect(html).not.toContain('id="preview-data"');
    expect(html).not.toContain('Technical details');
    expect(html).not.toContain('Data scenario');
  });

  it('offers agent generation and manual authoring after a missing recipe is confirmed', () => {
    const html = renderToStaticMarkup(
      <PreviewWorkspace
        {...previewProps({ includePlan: false })}
        resolution={{
          status: 'UNAVAILABLE',
          reasonCode: 'RECIPE_MISSING',
          reason: 'No .taskmonki/preview.yaml exists in the task worktree.'
        }}
      />
    );

    expect(html).toContain('Preview setup');
    expect(html).toContain('Generate with agent');
    expect(html).toContain('Write manually');
    expect(html).toContain('.taskmonki/preview.yaml');
    expect(html).toContain('Approval and Start remain separate actions');
    expect(html).not.toContain('Approve plan');
    expect(html).not.toContain('Start preview');
  });

  it('renders the complete generated YAML and generation report before acceptance', () => {
    const yaml = `version: 1
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }
routes:
  app: { service: web, port: http, primary: true }
`;
    const html = renderToStaticMarkup(
      <PreviewRecipeGenerationModal
        taskId="task-1"
        state={{
          taskId: 'task-1',
          status: 'READY',
          draft: {
            id: 'draft-1',
            taskId: 'task-1',
            yaml,
            validation: { status: 'VALID' },
            generatedAt: '2026-07-14T10:00:00.000Z',
            report: {
              summary: 'Runs the proven server entry point.',
              evidence: [{ path: 'package.json', finding: 'The dev script runs server.mjs.' }],
              assumptions: ['The server reads PORT.'],
              omissions: ['No HTTP health path was evidenced.'],
              unresolvedDecisions: [],
              publicEnvironmentDecisions: []
            }
          }
        }}
        onClose={() => {}}
        onRegenerate={async () => {}}
        onValidate={async () => ({ status: 'VALID' })}
        onAccept={async () => ({ recipePath: '.taskmonki/preview.yaml' })}
        onDiscard={async () => {}}
      />
    );

    expect(html).toContain('Review Preview configuration');
    expect(html).toContain('Complete YAML');
    expect(html).toContain('command: [node, server.mjs]');
    expect(html).toContain('package.json — The dev script runs server.mjs.');
    expect(html).toContain('Assumptions');
    expect(html).toContain('Omissions');
    expect(html).toContain('Regenerate');
    expect(html).toContain('Discard');
    expect(html).toContain('Accept &amp; save recipe');
  });

  it('keeps the review modal open on a visible generation progress state', () => {
    const html = renderToStaticMarkup(
      <PreviewRecipeGenerationModal
        taskId="task-1"
        state={{
          taskId: 'task-1',
          status: 'GENERATING',
          stage: 'GENERATING_DRAFT',
          startedAt: '2026-07-14T10:00:00.000Z'
        }}
        onClose={() => {}}
        onRegenerate={async () => {}}
        onValidate={async () => ({ status: 'VALID' })}
        onAccept={async () => ({ recipePath: '.taskmonki/preview.yaml' })}
        onDiscard={async () => {}}
      />
    );

    expect(html).toContain('Agent is drafting the recipe');
    expect(html).toContain('Reading only the bounded evidence bundle');
    expect(html).toContain('Close');
    expect(html).toContain('Discard');
    expect(html).toContain('disabled=""');
  });

  it('routes private-input checks through Preview before allowing Overview to start', () => {
    const unchecked = renderToStaticMarkup(
      <PreviewOverviewCard
        {...previewProps({ approved: true })}
        executionReadiness={undefined}
        onShowDetails={() => {}}
      />
    );
    expect(unchecked).toContain('Inputs unchecked');
    expect(unchecked).toContain('Required private inputs must be checked before startup.');
    expect(unchecked).toContain('Check inputs');
    expect(unchecked).not.toContain('Start preview');

    const blocked = renderToStaticMarkup(
      <PreviewOverviewCard
        {...previewProps({ approved: true })}
        executionReadiness={{
          status: 'BLOCKED',
          blockers: [{ kind: 'PRIVATE_INPUT_MISSING', inputId: 'api-token' }]
        }}
        onShowDetails={() => {}}
      />
    );
    expect(blocked).toContain('Configuration required');
    expect(blocked).toContain('Configure inputs');
    expect(blocked).toContain('api-token is missing');
    expect(blocked).not.toContain('Start preview');
  });

  it('makes approval the focus and keeps exact authority behind disclosure', () => {
    const html = renderToStaticMarkup(<PreviewWorkspace {...previewProps()} />);

    expect(html).toContain('Execution plan');
    expect(html).toContain('Approve plan');
    expect(html).toContain('Application');
    expect(html).toContain('Setup jobs');
    expect(html).toContain('Routes');
    expect(html).toContain('Data and dependencies');
    expect(html).toContain('Private inputs');
    expect(html).toContain('Runtime authority');
    expect(html).toContain('Advisories');
    expect(html).toContain('Cleanup contract');
    expect(html).toContain('Exact commands, recipients, readiness, and cleanup');
    expect(html).toContain('accounts.internal:443');
    expect(html).not.toContain('id="preview-application"');
    expect(html).not.toContain('id="preview-routes"');
    expect(html).not.toContain('id="preview-data"');
    expect(html).not.toContain('Not run');
    expect(html).not.toContain('Not created');
    expect(html).not.toContain('plaintext-canary');
  });

  it('keeps ready-to-start free of empty runtime sections', () => {
    const html = renderToStaticMarkup(<PreviewWorkspace {...previewProps({ approved: true })} />);

    expect(html).toContain('Ready to start');
    expect(html).toContain('Start preview');
    expect(html).toContain('Approved plan details');
    expect(html).toContain('Private inputs');
    expect(html).not.toContain('id="preview-application"');
    expect(html).not.toContain('id="preview-routes"');
    expect(html).not.toContain('id="preview-data"');
    expect(html).not.toContain('Technical details');
    expect(html).not.toContain('Not run');
    expect(html).not.toContain('Not created');
  });

  it('turns safe private-input blockers into a configuration workspace', () => {
    const html = renderToStaticMarkup(
      <PreviewWorkspace
        {...previewProps({ approved: true })}
        executionReadiness={{
          status: 'BLOCKED',
          blockers: [{ kind: 'PRIVATE_INPUT_MISSING', inputId: 'api-token' }]
        }}
      />
    );

    expect(html).toContain('Configuration required');
    expect(html).toContain('Configure inputs');
    expect(html).toContain('Blocking start');
    expect(html).toContain('<code>api-token</code> missing — required');
    expect(html).toContain('private · missing — required by web');
    expect(html).toContain('Set value…');
    expect(html).toContain('Checks once at startup');
    expect(html).toContain('Ownership');
    expect(html).toContain('accounts — checked or used, never managed');
    expect(html).not.toContain('type="password"');
  });

  it('shows the startup pipeline without implying queued nodes have run', () => {
    const generation = generationFixture({ state: 'RUNNING_GRAPH', routingState: 'CANDIDATE' });
    const html = renderToStaticMarkup(<PreviewWorkspace {...previewProps({
      approved: true,
      generation,
      attempts: [attemptFixture(generation.id, 'RUNNING')]
    })} />);

    expect(html).toContain('Starting');
    expect(html).toContain('Cancel start');
    expect(html).toContain('id="preview-application"');
    expect(html).toContain('web');
    expect(html).toContain('prepare');
    expect(html).toContain('Queued');
    expect(html).not.toContain('Not run');
    expect(html).not.toContain('id="preview-routes"');
    expect((html.match(/Starting/g) ?? [])).toHaveLength(1);
  });

  it('separates the active generation from its candidate during replacement', () => {
    const base = previewProps({ approved: true, generation: activeGeneration() });
    const candidate: PreviewGenerationRecord = {
      ...activeGeneration(),
      id: 'candidate-generation',
      state: 'WAITING_READY',
      routingState: 'CANDIDATE',
      replacesGenerationId: 'active-generation',
      routes: [],
      workspacePath: '/preview/candidate',
      createdAt: '2026-07-13T10:01:00.000Z',
      updatedAt: '2026-07-13T10:01:00.000Z',
      readyAt: undefined
    };
    const html = renderToStaticMarkup(
      <PreviewWorkspace {...base} generations={[candidate, activeGeneration()]} />
    );

    expect(html).toContain('Replacing');
    expect(html).toContain('Active');
    expect(html).toContain('Candidate');
    expect(html).toContain('Waiting ready');
    expect(html).toContain('Open current');
    expect(html).toContain('Cancel replace');
    expect(html).toContain('Routes stay on the active generation until readiness');
  });

  it('explains failed replacement readiness without exposing raw failure text', () => {
    const active = activeGeneration();
    const failed = generationFixture({
      id: 'failed-candidate',
      state: 'FAILED',
      routingState: 'CANDIDATE',
      replacesGenerationId: active.id,
      failureReason: 'curl http://internal-token@127.0.0.1/ready'
    });
    const failedAttempt = {
      ...attemptFixture(failed.id, 'FAILED'),
      readiness: {
        status: 'FAILED' as const,
        lastError: 'internal-token',
        observedAt: '2026-07-13T10:00:02.000Z'
      }
    };
    const html = renderToStaticMarkup(<PreviewWorkspace {...previewProps({
      approved: true,
      attempts: [failedAttempt]
    })} generations={[failed, active]} />);

    expect(html).toContain('Replacement failed');
    expect(html).toContain('web did not pass its readiness check');
    expect(html).toContain('is still serving; stable routes never moved');
    expect(html).not.toContain('curl http');
    expect(html).not.toContain('internal-token');
  });

  it('keeps failure copy safe, concise, and free of empty sections', () => {
    const generation = generationFixture({
      state: 'FAILED',
      failureReason: 'docker run --label io.taskmonki.preview.store=internal-secret'
    });
    const html = renderToStaticMarkup(<PreviewWorkspace {...previewProps({
      approved: true,
      generation,
      attempts: [attemptFixture(generation.id, 'FAILED')]
    })} />);

    expect(html).toContain('web failed during preview startup');
    expect(html).toContain('Try again');
    expect(html).toContain('View logs');
    expect(html).not.toContain('docker run');
    expect(html).not.toContain('io.taskmonki.preview.store');
    expect(html).not.toContain('internal-secret');
    expect(html).not.toContain('id="preview-routes"');
    expect(html).not.toContain('id="preview-data"');
    expect((html.match(/web failed during preview startup/g) ?? [])).toHaveLength(1);
  });

  it('keeps destructive and attached-resource actions out of the normal running surface', () => {
    const html = renderToStaticMarkup(
      <PreviewWorkspace
        {...previewProps({
          approved: true,
          generation: activeGeneration(),
          attempts: [attemptFixture('active-generation', 'RUNNING')]
        })}
        runtimeResources={[{
          id: 'runtime-web',
          taskId: 'task-1',
          generationId: 'active-generation',
          logicalNodeId: 'web',
          state: 'RUNNING',
          ownershipMarkerDigest: 'ownership',
          adapterKind: 'NATIVE_PROCESS',
          updatedAt: '2026-07-13T10:00:01.000Z'
        }]}
      />
    );

    expect(html).toContain('Open preview');
    expect(html).toContain('tm-ac6194662119229bf44ff8f080aedb3d.localhost');
    expect(html).toContain('Preview options');
    expect(html).toContain('Replace…');
    expect(html).toContain('Runtime ownership · 1');
    expect(html).toContain('Verified native process group');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('Stop Preview &amp; Delete Data');
    expect(html).not.toContain('Reset accounts');
    expect(html).not.toContain('plaintext-canary');
  });

  it('keeps recovery and cleanup errors singular and safe', () => {
    const recoveryHtml = renderToStaticMarkup(<PreviewWorkspace {...previewProps({
      approved: true,
      generation: generationFixture({
        state: 'RECOVERY_REQUIRED',
        failureReason: 'docker inspect --format internal-label-canary'
      })
    })} />);
    expect(recoveryHtml).toContain('Recovery required');
    expect(recoveryHtml).toContain('Preview options');
    expect(recoveryHtml).not.toContain('docker inspect');
    expect(recoveryHtml).not.toContain('internal-label-canary');
    expect(recoveryHtml).not.toContain('id="preview-application"');
    expect(recoveryHtml).not.toContain('id="preview-routes"');
    expect(recoveryHtml).not.toContain('id="preview-data"');

    const cleanupHtml = renderToStaticMarkup(<PreviewWorkspace {...previewProps({
      approved: true,
      generation: generationFixture({
        state: 'CLEANUP_INCOMPLETE',
        cleanupReason: 'raw ownership marker internal-cleanup-canary'
      })
    })} />);
    expect(cleanupHtml).toContain('Cleanup incomplete');
    expect(cleanupHtml).toContain('Retry cleanup');
    expect(cleanupHtml).not.toContain('raw ownership marker');
    expect(cleanupHtml).not.toContain('internal-cleanup-canary');
    expect((cleanupHtml.match(/Task Monki could not verify exact cleanup/g) ?? []))
      .toHaveLength(1);
  });

  it('presents Compose approval without native-only warnings or empty runtime rows', () => {
    const props = previewProps();
    const plan: PreviewPlanRecord = {
      ...props.plans[0],
      executionPlan: {
        version: 1,
        adapter: 'COMPOSE',
        compose: {
          files: ['compose.yaml'],
          projectDirectory: '.',
          profiles: [],
          rootServices: ['web'],
          services: [{ id: 'web', ports: { http: { target: 80, protocol: 'tcp' } } }],
          inspection: {
            composeVersion: '5.2.0',
            supportsNoEnvResolution: true,
            trustDigest: 'trust',
            configDigest: 'config',
            hostInputs: [{ kind: 'COMPOSE_FILE', path: 'compose.yaml' }],
            services: [{
              id: 'web', image: 'nginx:1.27-alpine', dependsOn: [], exposedPorts: [80],
              environmentKeys: [], secretSources: [],
              namedVolumes: [{ source: 'cache-data', target: '/data', readOnly: false }],
              networks: ['default']
            }],
            volumes: [{ name: 'cache-data', external: false }],
            networks: [{ name: 'default', external: false }]
          }
        },
        jobs: [], resources: [], services: [], workers: [],
        routes: [{ id: 'app', service: 'web', port: 'http', primary: true }],
        scenarios: [{ id: 'default', jobs: [], resources: [] }],
        selectedScenarioId: 'default'
      },
      warnings: [
        'Native preview commands run with the current user privileges.',
        'Compose networks remain task-scoped.'
      ]
    };

    const html = renderToStaticMarkup(
      <PreviewWorkspace {...props} plans={[plan]} />
    );

    expect(html).toContain('Execution plan');
    expect(html).toContain('Docker Compose');
    expect(html).toContain('cache-data');
    expect(html).toContain('Compose networks remain task-scoped.');
    expect(html).not.toContain('Native preview commands run');
    expect(html).not.toContain('id="preview-application"');
    expect(html).not.toContain('id="preview-data"');
    expect(html).not.toContain('Not created');
  });
});

function previewProps(options: {
  approved?: boolean;
  generation?: PreviewGenerationRecord;
  attempts?: PreviewPanelProps['attempts'];
  includePlan?: boolean;
} = {}): PreviewPanelProps {
  const plan = previewPlan();
  return {
    task: taskFixture(),
    worktree: worktreeFixture(),
    plans: options.includePlan === false ? [] : [plan],
    approvals: options.approved ? [{
      id: 'approval-1',
      taskId: 'task-1',
      planId: plan.id,
      executionDigest: plan.executionDigest,
      scope: 'TASK',
      approvedAt: '2026-07-13T10:00:00.000Z'
    }] : [],
    generations: options.generation ? [options.generation] : [],
    generationAttachments: [],
    attempts: options.attempts ?? [],
    managedResources: [],
    composeProjects: [],
    localBindings: [],
    taskRouteOptions: [],
    runtimeResources: [],
    executionReadiness: options.approved ? { status: 'READY', blockers: [] } : undefined,
    onResolve: async () => {},
    onSetLocalBinding: async () => {},
    onGetRecipeGeneration: async () => ({ taskId: 'task-1', status: 'EMPTY' }),
    onGenerateRecipe: async () => ({ taskId: 'task-1', status: 'EMPTY' }),
    onValidateRecipeDraft: async () => ({ status: 'VALID' }),
    onAcceptRecipeDraft: async () => ({ recipePath: '.taskmonki/preview.yaml' }),
    onDiscardRecipeDraft: async () => ({ taskId: 'task-1', status: 'EMPTY' }),
    onWriteRecipeManually: async () => {},
    onApprove: async () => {},
    onStart: async () => {},
    onOpen: async () => {},
    onStop: async () => {},
    onResetData: async () => {},
    onRetrySetup: async () => {},
    onReadLog: async () => ({ chunk: '', nextOffset: 0, endOfFile: true })
  };
}

function taskFixture(): Task {
  return {
    id: 'task-1',
    title: 'Preview task',
    prompt: 'Implement a preview.',
    repositoryPath: '/repo',
    runtimeId: 'codex',
    workflowPhase: 'IN_PROGRESS',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    currentIterationId: 'iteration-1',
    currentWorktreeId: 'worktree-1',
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T10:00:00.000Z',
    projection: createInitialProjection('2026-07-13T10:00:00.000Z')
  };
}

function worktreeFixture(): WorktreeRecord {
  return {
    id: 'worktree-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    repositoryPath: '/repo',
    worktreePath: '/worktree',
    branchName: 'codex/preview',
    baseSha: 'base',
    status: 'PRESENT',
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T10:00:00.000Z'
  };
}

function previewPlan(): PreviewPlanRecord {
  return {
    id: 'plan-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    recipePath: '.taskmonki/preview.yaml',
    recipeVersion: 1,
    recipeDigest: 'recipe',
    executionDigest: 'execution',
    executionPlan: {
      version: 1,
      inputs: [{ id: 'api-token', type: 'private', label: 'API token' }],
      attachments: [{
        id: 'accounts',
        type: 'http',
        target: { type: 'endpoint', scheme: 'https', host: 'accounts.internal', port: 443, basePath: '/' },
        check: { path: '/ready', timeoutSeconds: 10 }
      }],
      jobs: [{
        id: 'prepare',
        cwd: '.',
        command: ['node', 'prepare.mjs'],
        needs: {},
        env: {},
        role: 'generic',
        retrySafe: false
      }],
      resources: [],
      services: [{
        id: 'web',
        cwd: '.',
        command: ['node', 'server.mjs'],
        needs: { prepare: 'succeeded', accounts: 'ready' },
        env: {
          API_TOKEN: { type: 'private-input', input: 'api-token' },
          ACCOUNTS_ORIGIN: { type: 'attached-http-origin', attachment: 'accounts' }
        },
        ports: { http: { env: 'PORT' } },
        ready: { type: 'http', port: 'http', path: '/ready', timeoutSeconds: 20 },
        critical: true,
        restart: { mode: 'never', maxRestarts: 0, backoffMs: 250 }
      }],
      workers: [],
      routes: [{ id: 'app', service: 'web', port: 'http', primary: true }],
      scenarios: [{ id: 'default', jobs: [], resources: [] }],
      selectedScenarioId: 'default'
    },
    warnings: ['Native commands run as your local user.'],
    createdAt: '2026-07-13T10:00:00.000Z'
  };
}

function activeGeneration(): PreviewGenerationRecord {
  return {
    id: 'active-generation',
    previewKey: 'task-task1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    planId: 'plan-1',
    approvalId: 'approval-1',
    executionDigest: 'execution',
    sourceGitSnapshotId: 'git-1',
    sourceHeadSha: 'abcdef1234567890',
    sourceDirtyFingerprint: 'clean',
    workspacePath: '/preview/active',
    state: 'READY',
    routingState: 'ACTIVE',
    freshness: 'CURRENT',
    attachmentReadiness: [{
      attachmentId: 'accounts',
      status: 'PASSED',
      observedAt: '2026-07-13T10:00:00.000Z'
    }],
    routes: [{
      id: 'app',
      hostname: 'tm-ac6194662119229bf44ff8f080aedb3d.localhost',
      url: 'http://tm-ac6194662119229bf44ff8f080aedb3d.localhost:31337/',
      gatewayPort: 31337,
      targetHost: '127.0.0.1',
      targetPort: 41000,
      state: 'ATTACHED'
    }],
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T10:00:00.000Z',
    readyAt: '2026-07-13T10:00:00.000Z'
  };
}

function generationFixture(
  overrides: Partial<PreviewGenerationRecord> = {}
): PreviewGenerationRecord {
  return {
    ...activeGeneration(),
    id: 'generation',
    workspacePath: '/preview/generation',
    routingState: 'RETIRED',
    routes: [],
    attachmentReadiness: [],
    readyAt: undefined,
    ...overrides
  };
}

function attemptFixture(
  generationId: string,
  state: PreviewNodeAttemptRecord['state']
): PreviewNodeAttemptRecord {
  return {
    id: `attempt-${generationId}`,
    taskId: 'task-1',
    generationId,
    nodeId: 'web',
    kind: 'SERVICE',
    attempt: 1,
    commandDigest: 'command',
    state,
    stdoutArtifactId: 'stdout',
    stderrArtifactId: 'stderr',
    startedAt: '2026-07-13T10:00:01.000Z',
    endedAt: state === 'RUNNING' ? undefined : '2026-07-13T10:00:02.000Z'
  };
}
