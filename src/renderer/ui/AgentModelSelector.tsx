import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { AgentModel, AgentRuntimeState } from '../../shared/contracts';
import { formatReasoningEffort } from '../model/agentExecutionSettings';
import { runtimeReadinessView } from '../model/runtimeReadiness';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget
} from './menuKeyboard';

export type ModelDiscoveryStatus = 'idle' | 'loading' | 'failed';

interface AgentModelSelectorProps {
  label: string;
  runtimeId: string;
  modelId: string;
  reasoningEffort?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  disabled?: boolean;
  compact?: boolean;
  fallbackSummary?: string;
  selectionUnavailable?: boolean;
  selectionUnavailableMessage?: string;
  access?: ReactNode;
  onDiscoverModels?(runtimeId: string): Promise<void>;
  onDiscoveryStatusChange?(status: ModelDiscoveryStatus): void;
  onSelectionChange(runtimeId: string, modelId: string): void;
  onReasoningEffortChange?(value: string): void;
}

interface DiscoveryState {
  runtimeId: string;
  status: Exclude<ModelDiscoveryStatus, 'idle'>;
  error?: string;
}

/**
 * Shared renderer palette for runtime-owned model and reasoning choices.
 * It retains only transient menu state: provider adapters own catalog scope,
 * caching, and invalidation, and discovery starts only from an explicit action.
 */
export function AgentModelSelector({
  label,
  runtimeId,
  modelId,
  reasoningEffort = '',
  models,
  runtimes,
  disabled = false,
  compact = false,
  fallbackSummary,
  selectionUnavailable = false,
  selectionUnavailableMessage = 'Choose an available provider and model.',
  access,
  onDiscoverModels,
  onDiscoveryStatusChange,
  onSelectionChange,
  onReasoningEffortChange
}: AgentModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryState>();
  const [menuGeometry, setMenuGeometry] = useState<{
    maxHeight: number;
    placement: 'bottom' | 'top';
  }>();
  const popupId = useId();
  const selectionErrorId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const discoveryRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedRuntime = runtimes.find(
    (runtime) => runtime.preflight.runtime.id === runtimeId
  );
  const runtimeModels = selectedRuntime
    ? models.filter((model) => model.runtimeId === runtimeId)
    : [];
  const selectedModel = runtimeModels.find((model) => model.id === modelId);
  const efforts = selectedModel
    ? [
        ...new Set(
          [
            ...selectedModel.supportedReasoningEfforts,
            selectedModel.defaultReasoningEffort,
            reasoningEffort
          ].filter((effort): effort is string => Boolean(effort))
        )
      ]
    : [];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discoveryRevisionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    if (disabled) {
      setOpen(false);
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [disabled, open]);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => focusMenuItem(menuRef.current, 'selected'));
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const updateMenuGeometry = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const scrollBoundary = trigger.closest('.slideover__body');
      const boundaryRect = scrollBoundary?.getBoundingClientRect();
      const boundaryTop = Math.max(8, boundaryRect?.top ?? 8);
      const boundaryBottom = Math.min(
        window.innerHeight - 8,
        boundaryRect?.bottom ?? window.innerHeight - 8
      );
      const spaceAbove = triggerRect.top - boundaryTop - 6;
      const spaceBelow = boundaryBottom - triggerRect.bottom - 6;
      const placement = spaceBelow >= spaceAbove ? 'bottom' : 'top';
      setMenuGeometry({
        placement,
        maxHeight: Math.max(96, Math.min(320, placement === 'bottom' ? spaceBelow : spaceAbove))
      });
    };

    updateMenuGeometry();
    window.addEventListener('resize', updateMenuGeometry);
    document.addEventListener('scroll', updateMenuGeometry, true);
    return () => {
      window.removeEventListener('resize', updateMenuGeometry);
      document.removeEventListener('scroll', updateMenuGeometry, true);
    };
  }, [open]);

  const clearDiscovery = () => {
    discoveryRevisionRef.current += 1;
    setDiscovery(undefined);
    onDiscoveryStatusChange?.('idle');
  };

  const discover = async (runtime: AgentRuntimeState) => {
    if (!onDiscoverModels || discovery?.status === 'loading') {
      return;
    }
    const nextRuntimeId = runtime.preflight.runtime.id;
    const revision = ++discoveryRevisionRef.current;
    setDiscovery({ runtimeId: nextRuntimeId, status: 'loading' });
    onDiscoveryStatusChange?.('loading');
    try {
      await onDiscoverModels(nextRuntimeId);
      if (!mountedRef.current || discoveryRevisionRef.current !== revision) {
        return;
      }
      setDiscovery(undefined);
      onDiscoveryStatusChange?.('idle');
    } catch (caught) {
      if (!mountedRef.current || discoveryRevisionRef.current !== revision) {
        return;
      }
      setDiscovery({
        runtimeId: nextRuntimeId,
        status: 'failed',
        error: caught instanceof Error ? caught.message : 'Model catalog could not be loaded.'
      });
      onDiscoveryStatusChange?.('failed');
    }
  };

  const choose = async (runtime: AgentRuntimeState, model?: AgentModel) => {
    const nextRuntimeId = runtime.preflight.runtime.id;
    const nextModelId = model?.id ?? '';
    onSelectionChange(nextRuntimeId, nextModelId);
    const needsDiscovery = Boolean(onDiscoverModels && modelCatalogNeedsActivation(runtime));
    if (needsDiscovery) {
      setOpen(true);
      await discover(runtime);
      return;
    }
    clearDiscovery();
    setOpen(false);
    triggerRef.current?.focus();
  };

  const triggerSummary = selectedRuntime
    ? `${selectedRuntime.preflight.runtime.displayName}${
        selectedModel ? ` · ${selectedModel.displayName}` : fallbackSummary ? ` · ${fallbackSummary}` : ''
      }`
    : fallbackSummary ?? 'No agent available';

  return (
    <div className={`tm-agent-console ${compact ? 'tm-agent-console--compact' : ''}`} ref={rootRef}>
      <div className="tm-agent-console__row tm-agent-console__row--agent">
        <span className="tm-agent-console__label">Agent</span>
        <button
          ref={triggerRef}
          type="button"
          className={`tm-agent-console__trigger ${
            (discovery?.runtimeId === runtimeId && discovery.status === 'failed') ||
            selectedRuntime?.preflight.readiness.checks.modelCatalog === 'FAILED' ||
            selectionUnavailable
              ? 'tm-agent-console__trigger--error'
              : ''
          }`}
          aria-label={`${label}: ${triggerSummary}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={popupId}
          aria-busy={discovery?.runtimeId === runtimeId && discovery.status === 'loading'}
          aria-invalid={selectionUnavailable || undefined}
          aria-describedby={selectionUnavailable ? selectionErrorId : undefined}
          disabled={disabled || runtimes.length === 0}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            const target = menuTriggerFocusTarget(event.key);
            if (!target) return;
            event.preventDefault();
            setOpen(true);
            queueMicrotask(() => focusMenuItem(menuRef.current, target));
          }}
        >
          <span className="tm-agent-console__summary">{triggerSummary}</span>
          {discovery?.runtimeId === runtimeId && discovery.status === 'loading' ? (
            <SpinnerIcon />
          ) : (
            <ChevronIcon open={open} />
          )}
        </button>

        <div
          ref={menuRef}
          id={popupId}
          className={`tm-agent-console__menu ${
            menuGeometry?.placement === 'top' ? 'tm-agent-console__menu--top' : ''
          }`}
          style={menuGeometry ? { maxHeight: menuGeometry.maxHeight } : undefined}
          role="menu"
          aria-label={`${label} agent and model`}
          hidden={!open}
          tabIndex={-1}
          onBlur={(event) => handleMenuBlur(event, () => setOpen(false))}
          onKeyDown={(event) =>
            handleMenuKeyDown(event, {
              onClose: () => setOpen(false),
              returnFocus: triggerRef.current
            })
          }
        >
          {runtimes.map((runtime) => {
            const candidateRuntimeId = runtime.preflight.runtime.id;
            const candidateModels = models.filter(
              (model) =>
                model.runtimeId === candidateRuntimeId &&
                (!model.hidden || model.id === modelId)
            );
            const readiness = runtimeReadinessView(runtime);
            const runtimeDiscovery =
              discovery?.runtimeId === candidateRuntimeId ? discovery : undefined;
            const needsDiscovery = Boolean(
              onDiscoverModels && modelCatalogNeedsActivation(runtime)
            );
            const groupId = `${popupId}-${candidateRuntimeId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
            return (
              <div
                className="tm-agent-console__group"
                role="group"
                aria-labelledby={groupId}
                key={candidateRuntimeId}
              >
                <div className="tm-agent-console__group-title" id={groupId}>
                  <span>{runtime.preflight.runtime.displayName}</span>
                  {!runtime.preflight.readiness.canStart ? (
                    <span>{readiness.label}</span>
                  ) : null}
                </div>
                {candidateModels.map((model) => {
                  const selected = model.id === modelId && candidateRuntimeId === runtimeId;
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className="tm-agent-console__option"
                      key={model.id}
                      onClick={() => void choose(runtime, model)}
                    >
                      <span>{model.displayName}</span>
                      <span className="tm-agent-console__option-meta">
                        {model.isDefault ? 'Default' : ''}
                      </span>
                      <span className="tm-agent-console__check" aria-hidden="true">
                        {selected ? <CheckIcon /> : null}
                      </span>
                    </button>
                  );
                })}
                {candidateModels.length === 0 && !needsDiscovery ? (
                  compact ? (
                    <div className="tm-agent-console__empty">No models available.</div>
                  ) : (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={candidateRuntimeId === runtimeId}
                      className="tm-agent-console__option"
                      onClick={() => void choose(runtime)}
                    >
                      <span>Provider default</span>
                      <span className="tm-agent-console__option-meta">No catalog available</span>
                      <span className="tm-agent-console__check" aria-hidden="true">
                        {candidateRuntimeId === runtimeId ? <CheckIcon /> : null}
                      </span>
                    </button>
                  )
                ) : null}
                {needsDiscovery ? (
                  runtimeDiscovery?.status === 'loading' ? (
                    <div className="tm-agent-console__catalog-state" role="status">
                      <SpinnerIcon />
                      <span>Loading models…</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className={`tm-agent-console__catalog-action ${
                        runtimeDiscovery?.status === 'failed' ||
                        runtime.preflight.readiness.checks.modelCatalog === 'FAILED'
                          ? 'tm-agent-console__catalog-action--error'
                          : ''
                      }`}
                      onClick={() => {
                        onSelectionChange(candidateRuntimeId, candidateModels[0]?.id ?? '');
                        void discover(runtime);
                      }}
                    >
                      <span>
                        {runtimeDiscovery?.status === 'failed' ||
                        runtime.preflight.readiness.checks.modelCatalog === 'FAILED'
                          ? 'Retry model discovery'
                          : 'Load models'}
                      </span>
                      {runtimeDiscovery?.error ? (
                        <small>Could not load models. Check the connection and try again.</small>
                      ) : null}
                    </button>
                  )
                ) : null}
              </div>
            );
          })}
          {runtimes.length === 0 ? (
            <div className="tm-agent-console__empty">No agent supports this operation.</div>
          ) : null}
        </div>
      </div>

      {selectionUnavailable ? (
        <small
          id={selectionErrorId}
          className="tm-agent-console__selection-error"
          role="status"
        >
          {selectionUnavailableMessage}
        </small>
      ) : null}

      {onReasoningEffortChange && efforts.length > 0 ? (
        <div className="tm-agent-console__row">
          <span className="tm-agent-console__label">Reasoning</span>
          <div className="tm-agent-console__reasoning" role="group" aria-label={`${label} reasoning`}>
            {selectedModel?.defaultReasoningEffort === undefined ? (
              <button
                type="button"
                className={reasoningEffort === '' ? 'is-selected' : ''}
                aria-pressed={reasoningEffort === ''}
                disabled={disabled}
                onClick={() => onReasoningEffortChange('')}
              >
                <span />
                <small>Default</small>
              </button>
            ) : null}
            {efforts.map((effort) => (
              <button
                type="button"
                className={effort === reasoningEffort ? 'is-selected' : ''}
                aria-pressed={effort === reasoningEffort}
                disabled={disabled}
                key={effort}
                onClick={() => onReasoningEffortChange(effort)}
              >
                <span />
                <small>{formatReasoningEffort(effort)}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {access}
    </div>
  );
}

export function AgentModelSetting({
  label,
  hint,
  runtimeId,
  modelId,
  reasoningEffort,
  models,
  runtimes,
  onDiscoverModels,
  onSelectionChange,
  onReasoningEffortChange
}: {
  label: string;
  hint?: string;
  runtimeId: string;
  modelId: string;
  reasoningEffort?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  onDiscoverModels?(runtimeId: string): Promise<void>;
  onSelectionChange(runtimeId: string, modelId: string): void;
  onReasoningEffortChange?(value: string): void;
}) {
  return (
    <div className="tm-model-default">
      <div className="tm-model-default__title">
        <strong>{label}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      <AgentModelSelector
        label={label}
        runtimeId={runtimeId}
        modelId={modelId}
        reasoningEffort={reasoningEffort}
        models={models}
        runtimes={runtimes}
        onDiscoverModels={onDiscoverModels}
        onSelectionChange={onSelectionChange}
        onReasoningEffortChange={onReasoningEffortChange}
      />
    </div>
  );
}

function modelCatalogNeedsActivation(runtime: AgentRuntimeState): boolean {
  return (
    runtime.preflight.capabilities.modelCatalog.activation === 'EXPLICIT' &&
    runtime.preflight.readiness.checks.modelCatalog !== 'AVAILABLE'
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`tm-agent-console__chevron ${open ? 'is-open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="m2.5 6.7 2.4 2.4 5.6-5.7" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function SpinnerIcon() {
  return <span className="tm-agent-console__spinner" aria-hidden="true" />;
}
