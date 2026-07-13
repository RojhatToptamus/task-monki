import type {
  PreviewEnvironmentValue,
  PreviewExecutionPlan,
  PreviewGenerationState,
  PreviewLongRunningPlan,
  PreviewNodeAttemptRecord,
  PreviewReadinessPlan,
  PreviewResourceRecord,
  PreviewServicePlan,
  PreviewWorkerPlan
} from '../../shared/contracts';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewReadinessService, type PreviewReadinessResult } from './PreviewReadinessService';
import { NativeJobRunner } from './runtime/NativeJobRunner';
import { NativeServiceRuntime, type RunningNativeService } from './runtime/NativeServiceRuntime';
import { PreviewPortAllocator } from './runtime/PreviewPortAllocator';
import type { PreviewListenerInspector } from './runtime/PreviewListenerInspector';
import type { RuntimeManagedResourceBinding } from './runtime/PreviewCredentialHost';
import { attachmentEnvironmentValue, PreviewAttachedDependencyRuntime } from './runtime/PreviewAttachedDependencyRuntime';

const MAX_PARALLEL_NATIVE_EFFECTS = 4;

interface RunningLongNode {
  node: PreviewServicePlan | PreviewWorkerPlan;
  kind: 'SERVICE' | 'WORKER';
  ports: Record<string, number>;
  current: RunningNativeService;
  attempt: number;
  probeAttempt: number;
  stopping: boolean;
  handedOff?: boolean;
  forcedFailure?: string;
  livenessAbort?: AbortController;
  livenessOperation?: Promise<string | undefined>;
}

export interface RunningPreviewGraph {
  ports: Readonly<Record<string, Record<string, number>>>;
  unexpectedExit: Promise<string | undefined>;
  isRunning(): boolean;
  stopExclusive(): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'>;
  restoreExclusive(): Promise<boolean>;
  stop(): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'>;
}

export class PreviewGraph {
  constructor(
    private readonly store: FileTaskStore,
    private readonly jobs: NativeJobRunner,
    private readonly services: NativeServiceRuntime,
    private readonly readiness: PreviewReadinessService,
    private readonly ports: PreviewPortAllocator,
    private readonly listeners: PreviewListenerInspector,
    private readonly attachments = new PreviewAttachedDependencyRuntime()
  ) {}

  async start(input: {
    taskId: string;
    generationId: string;
    generationRoot: string;
    sourcePath: string;
    markerDigest: string;
    plan: PreviewExecutionPlan;
    resourceBindings?: Record<string, RuntimeManagedResourceBinding>;
    privateBindings?: Readonly<Record<string, string>>;
    attachmentGatewayPort?: number;
    onAttachmentEvidence?(evidence: import('../../shared/preview').PreviewAttachmentReadinessEvidence): Promise<void>;
    releaseBindings?(): Promise<void>;
    runSetup: boolean;
    onSetupComplete?(): Promise<void>;
    beforeExclusiveStart?(): Promise<void>;
    routeOrigins?: Record<string, string>;
    updateGenerationState(state: PreviewGenerationState): Promise<void>;
    signal?: AbortSignal;
  }): Promise<RunningPreviewGraph> {
    const scenario = input.plan.scenarios.find(
      (candidate) => candidate.id === input.plan.selectedScenarioId
    );
    if (!scenario) throw new Error(`Selected preview scenario is missing: ${input.plan.selectedScenarioId}.`);
    const activeJobIds = new Set([
      ...input.plan.jobs.filter((job) => job.role === 'generic').map((job) => job.id),
      ...(input.runSetup ? scenario.jobs : [])
    ]);
    const satisfiedSetupJobIds = new Set(input.runSetup ? [] : scenario.jobs);
    const activeResourceIds = new Set(scenario.resources);
    const jobs = input.plan.jobs.filter((job) => activeJobIds.has(job.id));
    const resources = input.plan.resources.filter((resource) => activeResourceIds.has(resource.id));
    const longNodes = [...input.plan.services, ...input.plan.workers];
    const resourceNodes = resources.map((resource) => ({ ...resource, needs: {} as Record<string, never> }));
    const attachmentNodes = (input.plan.attachments ?? []).map((attachment) => ({ ...attachment, needs: {} as Record<string, never> }));
    const allNodes = [...jobs, ...resourceNodes, ...longNodes, ...attachmentNodes];
    const byId = new Map(allNodes.map((node) => [node.id, node]));
    const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
    const attachmentById = new Map(attachmentNodes.map((attachment) => [attachment.id, attachment]));
    if (byId.size !== allNodes.length) throw new Error('Preview graph node identifiers are not unique.');
    assertGraphAcyclic(byId, satisfiedSetupJobIds);
    const semaphore = new Semaphore(MAX_PARALLEL_NATIVE_EFFECTS);
    const startupAbort = new AbortController();
    const onInputAbort = () => startupAbort.abort();
    if (input.signal?.aborted) startupAbort.abort();
    else input.signal?.addEventListener('abort', onInputAbort, { once: true });
    const startupInput = { ...input, signal: startupAbort.signal };
    const running = new Map<string, RunningLongNode>();
    const allocatedPorts: Record<string, Record<string, number>> = {};
    const resourceBindings: Record<string, RuntimeManagedResourceBinding> = { ...(input.resourceBindings ?? {}) };
    const promises = new Map<string, Promise<void>>();
    let phase: PreviewGenerationState | undefined;

    const updatePhase = async (state: PreviewGenerationState) => {
      if (phase === state) return;
      phase = state;
      await input.updateGenerationState(state);
    };
    const execute = (id: string): Promise<void> => {
      const existing = promises.get(id);
      if (existing) return existing;
      const node = byId.get(id);
      if (!node) return Promise.reject(new Error(`Preview dependency is missing: ${id}.`));
      const operation = (async () => {
        const dependencies = Object.keys(node.needs).sort().filter((dependencyId) => {
          if (byId.has(dependencyId)) return true;
          if (satisfiedSetupJobIds.has(dependencyId)) return false;
          throw new Error(`Preview dependency is missing: ${dependencyId}.`);
        });
        await Promise.all(dependencies.map(execute));
        throwIfAborted(startupAbort.signal);
        const resource = resourceById.get(node.id);
        if (resource) {
          if (!resourceBindings[node.id]) {
            throw new Error(`Managed resource binding ${node.id} is unavailable.`);
          }
          return;
        }
        const attachment = attachmentById.get(node.id);
        if (attachment) {
          const result = await this.attachments.check(
            attachment,
            input.privateBindings ?? {},
            startupAbort.signal,
            input.attachmentGatewayPort
          );
          await input.onAttachmentEvidence?.({ attachmentId: attachment.id, ...result });
          if (result.status === 'FAILED') throw new Error(`Preview attachment ${attachment.id} readiness failed (${result.failureCode ?? 'CHECK_FAILED'}).`);
          return;
        }
        if ('critical' in node) {
          const kind = input.plan.services.some((service) => service.id === node.id) ? 'SERVICE' : 'WORKER';
          const ports = await this.allocatePorts(node);
          allocatedPorts[node.id] = ports;
          const current = await semaphore.run(async () => {
            throwIfAborted(startupAbort.signal);
            try {
              const resolved = resolveEnvironment(
                node.env, allocatedPorts, input.routeOrigins ?? {}, resourceBindings, input.plan, input.privateBindings ?? {}, input.attachmentGatewayPort
              );
              return await this.services.start({
                ...runtimeInput(startupInput),
                node,
                kind,
                attempt: 1,
                portValues: ports,
                resolvedEnv: resolved.values,
                redactions: resolved.redactions
              });
            } catch (error) {
              startupAbort.abort();
              throw error;
            }
          });
          const owner: RunningLongNode = {
            node,
            kind,
            ports,
            current,
            attempt: 1,
            probeAttempt: 0,
            stopping: false
          };
          running.set(node.id, owner);
          await updatePhase('WAITING_READY');
          await this.waitUntilReady(startupInput, owner, semaphore, allocatedPorts, resourceBindings);
          return;
        }
        if (!('role' in node)) throw new Error(`Unknown preview graph node: ${node.id}.`);
        await semaphore.run(async () => {
          throwIfAborted(startupAbort.signal);
          try {
            const resolved = resolveEnvironment(
              node.env, allocatedPorts, input.routeOrigins ?? {}, resourceBindings, input.plan, input.privateBindings ?? {}, input.attachmentGatewayPort
            );
            return await this.jobs.run({
              ...runtimeInput(startupInput),
              node,
              signal: startupAbort.signal,
              env: resolved.values,
              redactions: resolved.redactions
            });
          } catch (error) {
            startupAbort.abort();
            throw error;
          }
        });
      })().catch((error) => {
        startupAbort.abort();
        throw error;
      });
      promises.set(id, operation);
      return operation;
    };

    const setupJobs = jobs.filter((job) => job.role !== 'generic');
    const exclusiveWorkers = input.plan.workers.filter((worker) => worker.overlap === 'exclusive');
    const prerequisiteNodes = [...resources, ...jobs];
    const overlappingLongNodes = longNodes.filter(
      (node) => !exclusiveWorkers.some((worker) => worker.id === node.id)
    );
    try {
      await updatePhase('RUNNING_GRAPH');
      await Promise.all(prerequisiteNodes.map((node) => node.id).sort().map(execute));
      if (input.runSetup) {
        await Promise.all(setupJobs.map((job) => execute(job.id)));
        await input.onSetupComplete?.();
      }
      await Promise.all(overlappingLongNodes.map((node) => node.id).sort().map(execute));
      throwIfAborted(startupAbort.signal);
      await Promise.all(
        [...running.values()].map((owner) =>
          this.stabilizeBeforeCutover(startupInput, owner, semaphore, allocatedPorts, resourceBindings)
        )
      );
      throwIfAborted(startupAbort.signal);
      await this.assertRoutedListeners(input.plan, running, allocatedPorts);
      if (exclusiveWorkers.length > 0) {
        await Promise.all(exclusiveWorkers.map(async (worker) => {
          await Promise.all(
            Object.keys(worker.needs)
              .filter((dependencyId) => attachmentById.has(dependencyId))
              .sort()
              .map(execute)
          );
          throwIfAborted(startupAbort.signal);
          resolveEnvironment(
            worker.env,
            allocatedPorts,
            input.routeOrigins ?? {},
            resourceBindings,
            input.plan,
            input.privateBindings ?? {},
            input.attachmentGatewayPort
          );
          for (const probe of [worker.ready, worker.liveness?.probe]) {
            if (probe?.type !== 'argv') continue;
            resolveEnvironment(
              probe.env ?? {},
              allocatedPorts,
              input.routeOrigins ?? {},
              resourceBindings,
              input.plan,
              input.privateBindings ?? {},
              input.attachmentGatewayPort
            );
          }
        }));
        await input.beforeExclusiveStart?.();
        await Promise.all(exclusiveWorkers.map((worker) => execute(worker.id)));
        await Promise.all(
          exclusiveWorkers
            .map((worker) => running.get(worker.id))
            .filter((owner): owner is RunningLongNode => Boolean(owner))
            .map((owner) => this.stabilizeBeforeCutover(startupInput, owner, semaphore, allocatedPorts, resourceBindings))
        );
      }
    } catch (error) {
      startupAbort.abort();
      await Promise.allSettled([...promises.values()]);
      await this.stopNodes(running, reverseDependencyOrder(input.plan));
      for (const ports of Object.values(allocatedPorts)) this.releasePorts(ports);
      input.signal?.removeEventListener('abort', onInputAbort);
      await input.releaseBindings?.();
      throw error;
    }
    input.signal?.removeEventListener('abort', onInputAbort);

    let resolveUnexpected!: (reason: string | undefined) => void;
    const unexpectedExit = new Promise<string | undefined>((resolve) => {
      resolveUnexpected = resolve;
    });
    let graphStopping = false;
    let stopOperation: Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> | undefined;
    const lifecycleAbort = new AbortController();
    const supervisions: Array<Promise<void>> = [];
    for (const owner of running.values()) {
      supervisions.push(
        this.supervise(
          { ...input, signal: lifecycleAbort.signal },
          owner,
          semaphore,
          allocatedPorts,
          resourceBindings
        )
          .then((reason) => {
            if (reason && !graphStopping && owner.node.critical) resolveUnexpected(reason);
          })
          .catch((error: unknown) => {
            if (!graphStopping) {
              resolveUnexpected(
                `Preview ${owner.kind.toLowerCase()} ${owner.node.id} supervision failed: ${boundedError(error)}`
              );
            }
          })
      );
    }

    const stopExclusive = async (): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> => {
      const owners = [...running.values()].filter(
        (owner) => owner.kind === 'WORKER' && 'overlap' in owner.node && owner.node.overlap === 'exclusive'
      );
      let result: 'STOPPED' | 'ALREADY_EXITED' | 'REFUSED' = owners.length ? 'STOPPED' : 'ALREADY_EXITED';
      for (const owner of owners) {
        if (owner.handedOff) continue;
        owner.handedOff = true;
        owner.stopping = true;
        owner.livenessAbort?.abort();
        const stopped = await this.services.stop(owner.current.resource).catch(() => 'REFUSED' as const);
        if (stopped === 'REFUSED') result = 'REFUSED';
        await owner.current.completion.catch(() => undefined);
      }
      return result;
    };

    const restoreExclusive = async (): Promise<boolean> => {
      const owners = [...running.values()].filter((owner) => owner.handedOff);
      try {
        for (const owner of owners) {
          owner.attempt += 1;
          owner.stopping = false;
          owner.current = await semaphore.run(() => this.services.start({
            ...runtimeInput(input),
            node: owner.node,
            kind: owner.kind,
            attempt: owner.attempt,
            portValues: owner.ports,
            ...resolvedRuntimeEnvironment(
              owner.node.env, allocatedPorts, input.routeOrigins ?? {}, resourceBindings, input.plan, input.privateBindings ?? {}, input.attachmentGatewayPort
            )
          }));
          await this.waitUntilReady(input, owner, semaphore, allocatedPorts, resourceBindings);
          owner.handedOff = false;
          supervisions.push(
            this.supervise(
              { ...input, signal: lifecycleAbort.signal },
              owner,
              semaphore,
              allocatedPorts,
              resourceBindings
            ).then((reason) => {
              if (reason && !graphStopping && owner.node.critical) resolveUnexpected(reason);
            }).catch((error: unknown) => {
              if (!graphStopping) resolveUnexpected(
                `Preview ${owner.kind.toLowerCase()} ${owner.node.id} supervision failed: ${boundedError(error)}`
              );
            })
          );
        }
        await this.assertRoutedListeners(input.plan, running, allocatedPorts);
        return [...running.values()]
          .filter((owner) => owner.node.critical)
          .every((owner) => owner.current.isRunning() && !owner.handedOff);
      } catch {
        return false;
      }
    };

    return {
      ports: allocatedPorts,
      unexpectedExit,
      isRunning: () =>
        [...running.values()]
          .filter((owner) => owner.node.critical)
          .every((owner) => owner.current.isRunning()),
      stopExclusive,
      restoreExclusive,
      stop: () => {
        if (stopOperation) {
          return stopOperation.then(() => 'ALREADY_EXITED' as const);
        }
        graphStopping = true;
        resolveUnexpected(undefined);
        stopOperation = (async () => {
          const activeLiveness: Array<Promise<string | undefined>> = [];
          for (const owner of running.values()) {
            owner.stopping = true;
            owner.livenessAbort?.abort();
            if (owner.livenessOperation) activeLiveness.push(owner.livenessOperation);
          }
          lifecycleAbort.abort();
          const result = await this.stopNodes(running, reverseDependencyOrder(input.plan));
          await Promise.allSettled([...supervisions, ...activeLiveness]);
          for (const ports of Object.values(allocatedPorts)) this.releasePorts(ports);
          await input.releaseBindings?.();
          return result;
        })();
        return stopOperation;
      }
    };
  }

  private async supervise(
    input: Parameters<PreviewGraph['start']>[0],
    owner: RunningLongNode,
    semaphore: Semaphore,
    allPorts: Record<string, Record<string, number>>,
    resourceBindings: Record<string, RuntimeManagedResourceBinding>
  ): Promise<string | undefined> {
    const stopping = waitForAbort(input.signal);
    while (!owner.stopping) {
      const liveness = owner.node.liveness
        ? this.watchLiveness(input, owner, semaphore, allPorts, resourceBindings)
        : undefined;
      owner.livenessOperation = liveness;
      let exit:
        | { type: 'exit'; result: Awaited<RunningNativeService['completion']> }
        | { type: 'liveness'; reason: string | undefined }
        | { type: 'stopping' };
      try {
        exit = await Promise.race([
          owner.current.completion.then((result) => ({ type: 'exit' as const, result })),
          ...(liveness
            ? [liveness.then((reason) => ({ type: 'liveness' as const, reason }))]
            : []),
          stopping.then(() => ({ type: 'stopping' as const }))
        ]);
        if (exit.type !== 'liveness') owner.livenessAbort?.abort();
        if (liveness) await liveness;
      } finally {
        owner.livenessAbort?.abort();
        if (liveness) await Promise.allSettled([liveness]);
        if (owner.livenessOperation === liveness) owner.livenessOperation = undefined;
        owner.livenessAbort = undefined;
      }
      if (owner.stopping || exit.type === 'stopping') return undefined;
      let reason: string;
      let failed = true;
      if (exit.type === 'liveness') {
        if (!exit.reason) return undefined;
        reason = exit.reason;
        owner.forcedFailure = reason;
        await this.services.stop(owner.current.resource);
        await owner.current.completion.catch(() => undefined);
      } else {
        failed = exit.result.receipt.state !== 'EXITED' || exit.result.receipt.exitCode !== 0;
        reason = owner.forcedFailure ?? nodeExitReason(owner, exit.result.receipt);
      }
      owner.forcedFailure = undefined;
      const restart = owner.node.restart;
      const shouldRestart = restart.mode === 'always' || (restart.mode === 'on-failure' && failed);
      if (!shouldRestart || owner.attempt > restart.maxRestarts) return reason;
      if (restart.backoffMs > 0) await delay(restart.backoffMs, input.signal);
      if (owner.stopping) return undefined;
      owner.attempt += 1;
      try {
        owner.current = await semaphore.run(() => {
          if (owner.stopping) throw new Error('Preview node is stopping.');
          return this.services.start({
            ...runtimeInput(input),
            node: owner.node,
            kind: owner.kind,
            attempt: owner.attempt,
            portValues: owner.ports,
            ...resolvedRuntimeEnvironment(
              owner.node.env, allPorts, input.routeOrigins ?? {}, resourceBindings, input.plan, input.privateBindings ?? {}, input.attachmentGatewayPort
            )
          });
        });
        if (owner.stopping) {
          await this.services.stop(owner.current.resource);
          return undefined;
        }
        await this.waitUntilReady(input, owner, semaphore, allPorts, resourceBindings);
      } catch (error) {
        if (owner.stopping) {
          await this.services.stop(owner.current.resource).catch(() => undefined);
          return undefined;
        }
        reason = `Preview ${owner.kind.toLowerCase()} ${owner.node.id} restart ${owner.attempt} failed: ${boundedError(error)}`;
        if (owner.attempt > restart.maxRestarts) return reason;
      }
    }
    return undefined;
  }

  private async stabilizeBeforeCutover(
    input: Parameters<PreviewGraph['start']>[0],
    owner: RunningLongNode,
    semaphore: Semaphore,
    allPorts: Record<string, Record<string, number>>,
    resourceBindings: Record<string, RuntimeManagedResourceBinding>
  ): Promise<void> {
    while (!owner.current.isRunning()) {
      const exit = await owner.current.completion;
      const failed = exit.receipt.state !== 'EXITED' || exit.receipt.exitCode !== 0;
      let reason = nodeExitReason(owner, exit.receipt);
      const restart = owner.node.restart;
      const shouldRestart = restart.mode === 'always' || (restart.mode === 'on-failure' && failed);
      if (!shouldRestart || owner.attempt > restart.maxRestarts) {
        if (owner.node.critical) throw new Error(reason);
        return;
      }
      if (restart.backoffMs > 0) await delay(restart.backoffMs, input.signal);
      throwIfAborted(input.signal);
      owner.attempt += 1;
      try {
        owner.current = await semaphore.run(() => {
          throwIfAborted(input.signal);
          return this.services.start({
            ...runtimeInput(input),
            node: owner.node,
            kind: owner.kind,
            attempt: owner.attempt,
            portValues: owner.ports,
            ...resolvedRuntimeEnvironment(
              owner.node.env, allPorts, input.routeOrigins ?? {}, resourceBindings, input.plan, input.privateBindings ?? {}, input.attachmentGatewayPort
            )
          });
        });
        await this.waitUntilReady(input, owner, semaphore, allPorts, resourceBindings);
      } catch (error) {
        reason = `Preview ${owner.kind.toLowerCase()} ${owner.node.id} restart ${owner.attempt} failed: ${boundedError(error)}`;
        if (owner.attempt > restart.maxRestarts) {
          if (owner.node.critical) throw new Error(reason);
          return;
        }
      }
    }
  }

  private async watchLiveness(
    input: Parameters<PreviewGraph['start']>[0],
    owner: RunningLongNode,
    semaphore: Semaphore,
    allPorts: Record<string, Record<string, number>>,
    resourceBindings: Record<string, RuntimeManagedResourceBinding>
  ): Promise<string | undefined> {
    const live = owner.node.liveness;
    if (!live) return undefined;
    const controller = new AbortController();
    owner.livenessAbort = controller;
    let failures = 0;
    while (!owner.stopping && !controller.signal.aborted) {
      try {
        await delay(live.intervalSeconds * 1_000, controller.signal);
      } catch (error) {
        if (owner.stopping || controller.signal.aborted) return undefined;
        throw error;
      }
      const result = await this.runProbe(
        input, owner, live.probe, semaphore, allPorts, resourceBindings, controller.signal
      );
      if (owner.stopping || controller.signal.aborted) return undefined;
      if (result.status === 'PASSED') failures = 0;
      else failures += 1;
      if (failures >= live.failureThreshold) {
        return `Preview ${owner.kind.toLowerCase()} ${owner.node.id} failed liveness ${failures} consecutive times: ${result.lastError ?? 'probe failed'}.`;
      }
    }
    return undefined;
  }

  private async waitUntilReady(
    input: Parameters<PreviewGraph['start']>[0],
    owner: RunningLongNode,
    semaphore: Semaphore,
    allPorts: Record<string, Record<string, number>>,
    resourceBindings: Record<string, RuntimeManagedResourceBinding>
  ): Promise<void> {
    if (!owner.node.ready) {
      await this.store.savePreviewNodeAttempt({ ...owner.current.attempt, state: 'READY' });
      return;
    }
    let attempt = await this.store.savePreviewNodeAttempt({
      ...owner.current.attempt,
      state: 'WAITING_READY',
      readiness: { status: 'PENDING' }
    });
    const probeAbort = new AbortController();
    const abortProbe = () => probeAbort.abort();
    if (input.signal?.aborted) probeAbort.abort();
    else input.signal?.addEventListener('abort', abortProbe, { once: true });
    const readinessOperation = this.runProbe(
      input,
      owner,
      owner.node.ready,
      semaphore,
      allPorts,
      resourceBindings,
      probeAbort.signal
    );
    let readinessOrExit:
      | { type: 'readiness'; readiness: PreviewReadinessResult }
      | { type: 'exit'; exit: Awaited<RunningNativeService['completion']> };
    try {
      readinessOrExit = await Promise.race([
        readinessOperation.then((readiness) => ({ type: 'readiness' as const, readiness })),
        owner.current.completion.then((exit) => ({ type: 'exit' as const, exit }))
      ]);
      if (readinessOrExit.type === 'exit') {
        probeAbort.abort();
        await Promise.allSettled([readinessOperation]);
      }
    } finally {
      input.signal?.removeEventListener('abort', abortProbe);
    }
    if (readinessOrExit.type === 'exit') {
      throw new Error(nodeExitReason(owner, readinessOrExit.exit.receipt));
    }
    const readiness = readinessOrExit.readiness;
    if (readiness.status !== 'PASSED') {
      attempt = await this.store.savePreviewNodeAttempt({ ...attempt, state: 'FAILED', endedAt: new Date().toISOString(), readiness });
      await this.services.stop(owner.current.resource);
      throw new PreviewReadinessFailure(owner.node.id, readiness.lastError, attempt, owner.current.resource);
    }
    if (owner.node.ready.type !== 'argv') {
      const processGroupId = owner.current.resource.native?.target?.processGroupId;
      if (!processGroupId) throw new Error(`Preview node ${owner.node.id} has no verified target process group.`);
      await this.listeners.assertOwnedLoopback(owner.ports[owner.node.ready.port], processGroupId);
    }
    if (!owner.current.isRunning()) throw new Error(`Preview node ${owner.node.id} exited before readiness was committed.`);
    await this.store.savePreviewNodeAttempt({ ...attempt, state: 'READY', readiness });
  }

  private async runProbe(
    input: Parameters<PreviewGraph['start']>[0],
    owner: RunningLongNode,
    probe: PreviewReadinessPlan,
    semaphore: Semaphore,
    allPorts: Record<string, Record<string, number>>,
    resourceBindings: Record<string, RuntimeManagedResourceBinding>,
    signal?: AbortSignal
  ): Promise<PreviewReadinessResult> {
    if (probe.type === 'http') {
      return this.readiness.waitForHttp({ port: owner.ports[probe.port], path: probe.path, timeoutMs: probe.timeoutSeconds * 1_000, signal });
    }
    if (probe.type === 'tcp') {
      return this.readiness.waitForTcp({ port: owner.ports[probe.port], timeoutMs: probe.timeoutSeconds * 1_000, signal });
    }
    owner.probeAttempt += 1;
    try {
      await semaphore.run(() => {
        throwIfAborted(signal);
        const resolved = resolveEnvironment(
          probe.env ?? {}, allPorts, input.routeOrigins ?? {}, resourceBindings, input.plan, input.privateBindings ?? {}, input.attachmentGatewayPort
        );
        return this.jobs.run({
          ...runtimeInput(input),
          node: {
            id: `${owner.node.id}-probe`,
            cwd: probe.cwd,
            command: probe.command,
            needs: {},
            env: {},
            role: 'generic',
            retrySafe: false
          },
          kind: 'PROBE',
          attempt: owner.probeAttempt,
          timeoutMs: probe.timeoutSeconds * 1_000,
          signal,
          env: {
            ...resolved.values,
            ...Object.fromEntries(
              Object.entries(owner.node.ports).map(([portId, port]) => [port.env, String(owner.ports[portId])])
            )
          },
          redactions: resolved.redactions
        });
      });
      return { status: 'PASSED', observedAt: new Date().toISOString() };
    } catch (error) {
      return { status: 'FAILED', lastError: boundedError(error), observedAt: new Date().toISOString() };
    } finally {
      await this.store.prunePreviewProbeHistory(input.generationId, `${owner.node.id}-probe`);
    }
  }

  private async assertRoutedListeners(
    plan: PreviewExecutionPlan,
    running: Map<string, RunningLongNode>,
    ports: Record<string, Record<string, number>>
  ): Promise<void> {
    for (const route of plan.routes) {
      const owner = running.get(route.service);
      const processGroupId = owner?.current.resource.native?.target?.processGroupId;
      const port = ports[route.service]?.[route.port];
      if (!owner || !owner.current.isRunning() || !processGroupId || !port) {
        throw new Error(`Preview route ${route.id} has no running owned listener target.`);
      }
      await this.listeners.assertOwnedLoopback(port, processGroupId);
    }
  }

  private async allocatePorts(node: PreviewLongRunningPlan): Promise<Record<string, number>> {
    const values: Record<string, number> = {};
    try {
      for (const id of Object.keys(node.ports).sort()) values[id] = await this.ports.allocate();
      return values;
    } catch (error) {
      this.releasePorts(values);
      throw error;
    }
  }

  private releasePorts(values: Record<string, number>): void {
    for (const value of Object.values(values)) this.ports.release(value);
  }

  private async stopNodes(
    running: Map<string, RunningLongNode>,
    order: string[]
  ): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    let result: 'STOPPED' | 'ALREADY_EXITED' | 'REFUSED' = running.size === 0 ? 'ALREADY_EXITED' : 'STOPPED';
    for (const id of order) {
      const owner = running.get(id);
      if (!owner) continue;
      owner.stopping = true;
      owner.livenessAbort?.abort();
      const stopped = await this.services.stop(owner.current.resource).catch(() => 'REFUSED' as const);
      if (stopped === 'REFUSED') result = 'REFUSED';
    }
    return result;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function runtimeInput(input: Parameters<PreviewGraph['start']>[0]) {
  return {
    taskId: input.taskId,
    generationId: input.generationId,
    generationRoot: input.generationRoot,
    sourcePath: input.sourcePath,
    markerDigest: input.markerDigest
  };
}

function resolvedRuntimeEnvironment(
  env: Record<string, PreviewEnvironmentValue>,
  allPorts: Record<string, Record<string, number>>,
  routeOrigins: Record<string, string>,
  resourceBindings: Record<string, RuntimeManagedResourceBinding>,
  plan: PreviewExecutionPlan,
  privateBindings: Readonly<Record<string, string>>,
  attachmentGatewayPort?: number
): { resolvedEnv: Record<string, string>; redactions: string[] } {
  const resolved = resolveEnvironment(env, allPorts, routeOrigins, resourceBindings, plan, privateBindings, attachmentGatewayPort);
  return { resolvedEnv: resolved.values, redactions: resolved.redactions };
}

function resolveEnvironment(
  env: Record<string, PreviewEnvironmentValue>,
  allPorts: Record<string, Record<string, number>>,
  routeOrigins: Record<string, string>,
  resourceBindings: Record<string, RuntimeManagedResourceBinding>,
  plan: PreviewExecutionPlan,
  privateBindings: Readonly<Record<string, string>>,
  attachmentGatewayPort?: number
): { values: Record<string, string>; redactions: string[] } {
  const result: Record<string, string> = {};
  const redactions = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
    else if (value.type === 'route-origin') {
      const origin = routeOrigins[value.route];
      if (!origin) throw new Error(`Preview route origin ${value.route} is unavailable.`);
      result[key] = origin;
    } else if (value.type === 'service-origin') {
      const port = allPorts[value.service]?.[value.port];
      if (!port) throw new Error(`Preview service origin ${value.service}.${value.port} is unavailable.`);
      result[key] = `http://127.0.0.1:${port}`;
    } else if (value.type === 'postgres-url' || value.type === 'redis-url') {
      const binding = resourceBindings[value.resource];
      if (!binding) throw new Error(`Preview OCI environment reference ${value.resource} is unavailable.`);
      if (value.type === 'postgres-url') {
        if (!binding.postgresUrl) throw new Error(`Preview PostgreSQL URL ${value.resource} is unavailable.`);
        result[key] = binding.postgresUrl;
      } else if (value.type === 'redis-url') {
        if (!binding.redisUrl) throw new Error(`Preview Redis URL ${value.resource} is unavailable.`);
        result[key] = binding.redisUrl;
      }
      addUrlRedactions(redactions, result[key]);
    } else if (value.type === 'private-input') {
      const secret = privateBindings[value.input];
      if (!secret) throw new Error(`Private input ${value.input} is unavailable.`);
      result[key] = secret; redactions.add(secret);
    } else if (value.type.startsWith('attached-')) {
      const attachment = (plan.attachments ?? []).find((candidate) => candidate.id === value.attachment);
      if (!attachment) throw new Error(`Preview attachment ${value.attachment} is unavailable.`);
      result[key] = attachmentEnvironmentValue(attachment, value.type, privateBindings, attachmentGatewayPort);
      if (value.type === 'attached-postgres-url' || value.type === 'attached-redis-url') addUrlRedactions(redactions, result[key]);
    } else {
      throw new Error(`Preview environment reference ${value.type} has not been resolved.`);
    }
  }
  return {
    values: result,
    redactions: [...redactions].sort((left, right) => right.length - left.length)
  };
}

function addUrlRedactions(redactions: Set<string>, value: string): void {
  redactions.add(value);
  const url = new URL(value);
  for (const component of [url.username, url.password]) {
    if (!component) continue;
    redactions.add(component);
    redactions.add(decodeURIComponent(component));
  }
}

export function reverseDependencyOrder(plan: PreviewExecutionPlan): string[] {
  const nodes = [
    ...plan.jobs,
    ...plan.resources.map((resource) => ({ ...resource, needs: {} })),
    ...plan.services,
    ...plan.workers
  ];
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodes.find((candidate) => candidate.id === id);
    for (const dependency of Object.keys(node?.needs ?? {}).sort()) visit(dependency);
    ordered.push(id);
  };
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) visit(node.id);
  return ordered.reverse();
}

function nodeExitReason(owner: RunningLongNode, receipt: { exitCode?: number | null; signal?: string | null; state: string }): string {
  return `Preview ${owner.kind.toLowerCase()} ${owner.node.id} exited with ${receipt.exitCode ?? receipt.signal ?? receipt.state}.`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Preview startup canceled.');
  error.name = 'AbortError';
  throw error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('Preview operation canceled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish(new Error('Preview operation canceled.'));
    function finish(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

export class PreviewReadinessFailure extends Error {
  constructor(
    nodeId: string,
    reason: string | undefined,
    readonly attempt: PreviewNodeAttemptRecord,
    readonly resource: PreviewResourceRecord
  ) {
    super(`Preview node ${nodeId} did not become ready: ${reason ?? 'readiness timed out'}`);
  }
}

function assertGraphAcyclic(
  nodes: Map<string, { id: string; needs: Record<string, unknown> }>,
  satisfiedExternalNodes: ReadonlySet<string> = new Set()
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (satisfiedExternalNodes.has(id)) return;
    if (visiting.has(id)) throw new Error(`Preview dependency graph contains a cycle at ${id}.`);
    const node = nodes.get(id);
    if (!node) throw new Error(`Preview dependency is missing: ${id}.`);
    visiting.add(id);
    for (const dependencyId of Object.keys(node.needs)) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
}
