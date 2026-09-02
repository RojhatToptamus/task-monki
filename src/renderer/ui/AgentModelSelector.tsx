import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import { Check, ChevronDown, RefreshCw, Search, X } from 'lucide-react';
import type { AgentModel, AgentRuntimeState } from '../../shared/contracts';
import { formatReasoningEffort } from '../model/agentExecutionSettings';
import { runtimeReadinessView } from '../model/runtimeReadiness';

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
  presentation?: 'full' | 'compact';
  fallbackSummary?: string;
  selectionUnavailable?: boolean;
  showSelectionError?: boolean;
  selectionUnavailableMessage?: string;
  showRuntimeLabel?: boolean;
  access?: ReactNode;
  runtimeUnavailableReason?(runtime: AgentRuntimeState): string | undefined;
  modelUnavailableReason?(
    model: AgentModel,
    runtime: AgentRuntimeState
  ): string | undefined;
  onDiscoverModels?(runtimeId: string): Promise<void>;
  onDiscoveryStatusChange?(status: ModelDiscoveryStatus): void;
  onSelectionChange(runtimeId: string, modelId: string): void;
  onReasoningEffortChange?(value: string): void;
}

interface DiscoveryState {
  runtimeId: string;
  status: Exclude<ModelDiscoveryStatus, 'idle'> | 'resolved';
}

type PickerOptionKind = 'model' | 'provider-default' | 'discovery';

interface PickerOption {
  id: string;
  kind: PickerOptionKind;
  runtime: AgentRuntimeState;
  model?: AgentModel;
  selected: boolean;
  meta: string;
  title: string;
  unavailableReason?: string;
}

interface PickerGroup {
  runtimeId: string;
  label: string;
  meta: string;
  options: PickerOption[];
}

const MODEL_MENU_GAP = 6;
const MODEL_MENU_MIN_HEIGHT = 152;
const MODEL_MENU_MAX_HEIGHT = 320;
const MODEL_MENU_WIDTH = 260;

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
  presentation,
  fallbackSummary,
  selectionUnavailable = false,
  showSelectionError = true,
  selectionUnavailableMessage = 'Choose an available provider and model.',
  showRuntimeLabel = true,
  access,
  runtimeUnavailableReason,
  modelUnavailableReason,
  onDiscoverModels,
  onDiscoveryStatusChange,
  onSelectionChange,
  onReasoningEffortChange
}: AgentModelSelectorProps) {
  const effectivePresentation = presentation ?? (compact ? 'compact' : 'full');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeOptionId, setActiveOptionId] = useState<string>();
  const [discovery, setDiscovery] = useState<DiscoveryState>();
  const [menuGeometry, setMenuGeometry] = useState<{
    maxHeight: number;
    width: number;
    alignRight: boolean;
    placement: 'bottom' | 'top';
  }>();
  const popupId = useId();
  const listboxId = `${popupId}-listbox`;
  const selectionErrorId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const discoveryRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedRuntime = runtimes.find(
    (runtime) => runtime.preflight.runtime.id === runtimeId
  );
  const selectedRuntimeReadiness = runtimeReadinessView(selectedRuntime);
  const selectedRuntimeUnavailableReason = selectedRuntime
    ? runtimeUnavailableReason?.(selectedRuntime) ??
      (!selectedRuntimeReadiness.canStart
        ? selectedRuntimeReadiness.detail
        : undefined)
    : undefined;
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
  const includesProviderDefaultReasoning =
    selectedModel?.defaultReasoningEffort === undefined;
  const reasoningChoiceCount =
    efforts.length + (includesProviderDefaultReasoning ? 1 : 0);
  const pickerGroups = buildPickerGroups({
    popupId,
    query,
    runtimeId,
    modelId,
    models,
    runtimes,
    discovery,
    runtimeUnavailableReason,
    modelUnavailableReason
  });
  const interactiveOptions = pickerGroups.flatMap((group) =>
    group.options.filter((option) => !option.unavailableReason)
  );
  const interactiveOptionIds = interactiveOptions
    .map((option) => option.id)
    .join('\u0000');
  const defaultActiveOptionId =
    interactiveOptions.find((option) => option.selected)?.id ??
    interactiveOptions[0]?.id;
  const resolvedDiscoveryOptionId =
    discovery?.status === 'resolved'
      ? pickerGroups
          .find((group) => group.runtimeId === discovery.runtimeId)
          ?.options.find(
            (option) => option.kind !== 'discovery' && !option.unavailableReason
          )?.id
      : undefined;

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
      setQuery('');
      setActiveOptionId(undefined);
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
        setActiveOptionId(undefined);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () =>
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [disabled, open]);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => searchRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveOptionId((current) => {
      if (current && interactiveOptionIds.split('\u0000').includes(current)) {
        return current;
      }
      return defaultActiveOptionId;
    });
  }, [defaultActiveOptionId, interactiveOptionIds, open, query]);

  useLayoutEffect(() => {
    if (!open || discovery?.status !== 'resolved') return;
    if (resolvedDiscoveryOptionId) {
      setActiveOptionId(resolvedDiscoveryOptionId);
    }
    setDiscovery(undefined);
  }, [discovery?.status, open, resolvedDiscoveryOptionId]);

  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId, open]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    const updateMenuGeometry = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const scrollBoundary = findScrollableAncestor(trigger);
      const boundaryRect = scrollBoundary?.getBoundingClientRect();
      setMenuGeometry(
        agentModelMenuGeometry({
          trigger: triggerRect,
          boundary: boundaryRect ?? {
            top: 8,
            right: window.innerWidth - 8,
            bottom: window.innerHeight - 8,
            left: 8
          }
        })
      );
    };

    const closeOnAnchoredScroll = (event: Event) => {
      const trigger = triggerRef.current;
      const target = event.target;
      if (
        trigger &&
        (target === document || (target instanceof Node && target.contains(trigger)))
      ) {
        setOpen(false);
        setQuery('');
        setActiveOptionId(undefined);
      }
    };

    updateMenuGeometry();
    window.addEventListener('resize', updateMenuGeometry);
    document.addEventListener('scroll', closeOnAnchoredScroll, true);
    return () => {
      window.removeEventListener('resize', updateMenuGeometry);
      document.removeEventListener('scroll', closeOnAnchoredScroll, true);
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
      setDiscovery({ runtimeId: nextRuntimeId, status: 'resolved' });
      onDiscoveryStatusChange?.('idle');
    } catch {
      if (!mountedRef.current || discoveryRevisionRef.current !== revision) {
        return;
      }
      setDiscovery({ runtimeId: nextRuntimeId, status: 'failed' });
      onDiscoveryStatusChange?.('failed');
    }
  };

  const closeMenu = (returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    setActiveOptionId(undefined);
    if (returnFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  const openMenu = () => {
    setQuery('');
    setActiveOptionId(undefined);
    setOpen(true);
  };

  const choose = async (option: PickerOption) => {
    if (option.unavailableReason) return;
    if (option.kind === 'discovery') {
      setActiveOptionId(option.id);
      await discover(option.runtime);
      return;
    }
    onSelectionChange(option.runtime.preflight.runtime.id, option.model?.id ?? '');
    clearDiscovery();
    closeMenu(true);
  };

  const moveActiveOption = (direction: -1 | 1) => {
    if (interactiveOptions.length === 0) return;
    const currentIndex = interactiveOptions.findIndex(
      (option) => option.id === activeOptionId
    );
    const nextIndex =
      currentIndex < 0
        ? 0
        : Math.max(
            0,
            Math.min(interactiveOptions.length - 1, currentIndex + direction)
          );
    setActiveOptionId(interactiveOptions[nextIndex]?.id);
  };

  const activateCurrentOption = () => {
    const option = interactiveOptions.find(
      (candidate) => candidate.id === activeOptionId
    );
    if (option) void choose(option);
  };

  const handlePickerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (event.target !== triggerRef.current) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openMenu();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActiveOption(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateCurrentOption();
    }
  };

  const triggerSummary =
    selectedModel?.displayName ??
    fallbackSummary ??
    (selectedRuntime ? 'Provider default' : 'No agent available');
  const triggerDetails = selectedRuntime
    ? `${selectedRuntime.preflight.runtime.displayName} · ${triggerSummary}`
    : runtimeId
      ? `${runtimeId} · ${triggerSummary}`
      : triggerSummary;

  return (
    <div
      className={`tm-agent-console tm-agent-console--${effectivePresentation}`}
      ref={rootRef}
    >
      <div
        className={`tm-agent-console__row tm-agent-console__row--agent ${
          showRuntimeLabel ? '' : 'tm-agent-console__row--agent-unlabelled'
        }`}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            closeMenu(false);
          }
        }}
        onKeyDown={handlePickerKeyDown}
      >
        {showRuntimeLabel ? (
          <span className="tm-agent-console__label">Model</span>
        ) : null}
        <button
          ref={triggerRef}
          type="button"
          className={`tm-agent-console__trigger ${
            (discovery?.runtimeId === runtimeId && discovery.status === 'failed') ||
            selectedRuntime?.preflight.readiness.checks.modelCatalog === 'FAILED' ||
            selectedRuntimeUnavailableReason ||
            selectionUnavailable
              ? 'tm-agent-console__trigger--error'
              : ''
          }`}
          aria-label={`${label}: ${triggerDetails}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-busy={
            discovery?.runtimeId === runtimeId && discovery.status === 'loading'
          }
          aria-invalid={selectionUnavailable || undefined}
          aria-describedby={
            selectionUnavailable && showSelectionError
              ? selectionErrorId
              : undefined
          }
          title={selectedRuntimeUnavailableReason ?? triggerDetails}
          disabled={disabled || runtimes.length === 0}
          onClick={() => (open ? closeMenu(false) : openMenu())}
        >
          <span className="tm-agent-console__summary">{triggerSummary}</span>
          {discovery?.runtimeId === runtimeId && discovery.status === 'loading' ? (
            <SpinnerIcon />
          ) : (
            <ChevronIcon open={open} />
          )}
        </button>

        <div
          id={popupId}
          className={`tm-agent-console__menu ${
            menuGeometry?.placement === 'top' ? 'tm-agent-console__menu--top' : ''
          } ${menuGeometry?.alignRight ? 'tm-agent-console__menu--right' : ''}`}
          hidden={!open}
          style={
            menuGeometry
              ? {
                  maxHeight: `${menuGeometry.maxHeight}px`,
                  width: `${menuGeometry.width}px`
                }
              : undefined
          }
        >
          <div className="tm-agent-console__search">
            <Search aria-hidden="true" size={14} strokeWidth={1.5} />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              value={query}
              aria-label="Search models and providers"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={open}
              aria-activedescendant={activeOptionId}
              placeholder="Search models and providers"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveOptionId(undefined);
              }}
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  setActiveOptionId(undefined);
                  searchRef.current?.focus();
                }}
              >
                <X aria-hidden="true" size={12} strokeWidth={1.6} />
              </button>
            ) : null}
          </div>

          <div
            id={listboxId}
            className="tm-agent-console__list"
            role="listbox"
            aria-label="Models by provider"
          >
            {pickerGroups.map((group) => (
              <div
                className="tm-agent-console__group"
                role="presentation"
                key={group.runtimeId}
              >
                <div
                  className="tm-agent-console__group-title"
                  role="presentation"
                >
                  <span>{group.label}</span>
                  {group.meta ? <span>{group.meta}</span> : null}
                </div>
                {group.options.map((option) => {
                  const active = option.id === activeOptionId;
                  const discoveryFailed =
                    option.kind === 'discovery' &&
                    ((discovery?.runtimeId ===
                      option.runtime.preflight.runtime.id &&
                      discovery.status === 'failed') ||
                      option.runtime.preflight.readiness.checks.modelCatalog ===
                        'FAILED');
                  const discoveryLoading =
                    option.kind === 'discovery' &&
                    discovery?.runtimeId ===
                      option.runtime.preflight.runtime.id &&
                    discovery.status === 'loading';
                  const optionLabel =
                    option.kind === 'discovery'
                      ? discoveryLoading
                        ? 'Loading models…'
                        : discoveryFailed
                          ? 'Retry model discovery'
                          : 'Load models'
                      : option.model?.displayName ?? 'Provider default';
                  const optionDisabled =
                    Boolean(option.unavailableReason) || discoveryLoading;
                  return (
                    <button
                      type="button"
                      id={option.id}
                      role="option"
                      tabIndex={-1}
                      aria-selected={option.selected}
                      aria-disabled={optionDisabled}
                      aria-busy={discoveryLoading || undefined}
                      disabled={optionDisabled}
                      aria-label={`${optionLabel} via ${group.label}${
                        option.unavailableReason
                          ? `, unavailable. ${option.unavailableReason}`
                          : ''
                      }`}
                      className={`tm-agent-console__option ${
                        active ? 'is-active' : ''
                      } ${
                        option.kind === 'discovery'
                          ? 'tm-agent-console__option--discovery'
                          : ''
                      } ${discoveryFailed ? 'tm-agent-console__option--error' : ''}`}
                      key={option.id}
                      title={option.title}
                      onMouseMove={() => {
                        if (!optionDisabled) setActiveOptionId(option.id);
                      }}
                      onClick={() => void choose(option)}
                    >
                      <span className="tm-agent-console__option-name">
                        {discoveryLoading ? (
                          <SpinnerIcon />
                        ) : option.kind === 'discovery' ? (
                          <RefreshCw
                            aria-hidden="true"
                            size={13}
                            strokeWidth={1.5}
                          />
                        ) : null}
                        {optionLabel}
                      </span>
                      <span className="tm-agent-console__option-meta">
                        {option.meta}
                      </span>
                      <span className="tm-agent-console__check" aria-hidden="true">
                        {option.selected ? <CheckIcon /> : null}
                      </span>
                      {option.kind === 'discovery' && discoveryFailed ? (
                        <small className="tm-agent-console__option-detail">
                          Could not load models. Check the connection and try again.
                        </small>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {runtimes.length === 0 ? (
              <div className="tm-agent-console__empty" role="presentation">
                No agent supports this operation.
              </div>
            ) : pickerGroups.length === 0 ? (
              <div className="tm-agent-console__empty" role="presentation">
                {query
                  ? `No model matches “${query}”. Search matches model and provider names.`
                  : 'No models available.'}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {selectionUnavailable && showSelectionError ? (
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
          <div
            className="tm-agent-console__reasoning"
            role="group"
            aria-label={`${label} reasoning`}
            data-many-options={reasoningChoiceCount > 4 || undefined}
          >
            <div className="tm-agent-console__reasoning-options">
              {includesProviderDefaultReasoning ? (
                <button
                  type="button"
                  className={reasoningEffort === '' ? 'is-selected' : ''}
                  aria-pressed={reasoningEffort === ''}
                  aria-label="Default reasoning"
                  disabled={disabled}
                  onClick={() => onReasoningEffortChange('')}
                >
                  <span />
                  <ReasoningLabel label="Default" compactLabel="Auto" />
                </button>
              ) : null}
              {efforts.map((effort) => (
                <button
                  type="button"
                  className={effort === reasoningEffort ? 'is-selected' : ''}
                  aria-pressed={effort === reasoningEffort}
                  aria-label={`${formatReasoningEffort(effort)} reasoning`}
                  disabled={disabled}
                  key={effort}
                  onClick={() => onReasoningEffortChange(effort)}
                >
                  <span />
                  <ReasoningLabel
                    label={formatReasoningEffort(effort)}
                    compactLabel={compactReasoningEffort(effort)}
                  />
                </button>
              ))}
            </div>
            <select
              className="tm-agent-console__reasoning-select"
              aria-label={`${label} reasoning effort`}
              value={reasoningEffort}
              disabled={disabled}
              onChange={(event) => onReasoningEffortChange(event.target.value)}
            >
              {includesProviderDefaultReasoning ? (
                <option value="">Default</option>
              ) : null}
              {efforts.map((effort) => (
                <option value={effort} key={effort}>
                  {formatReasoningEffort(effort)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {access}
    </div>
  );
}

function compactReasoningEffort(effort: string): string {
  const label = formatReasoningEffort(effort);
  return label === 'Medium' ? 'Med' : label;
}

function ReasoningLabel({
  label,
  compactLabel
}: {
  label: string;
  compactLabel: string;
}) {
  return (
    <small>
      <span className="tm-agent-console__reasoning-label--full">{label}</span>
      <span className="tm-agent-console__reasoning-label--compact">
        {compactLabel}
      </span>
    </small>
  );
}

function buildPickerGroups(input: {
  popupId: string;
  query: string;
  runtimeId: string;
  modelId: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  discovery?: DiscoveryState;
  runtimeUnavailableReason?(runtime: AgentRuntimeState): string | undefined;
  modelUnavailableReason?(
    model: AgentModel,
    runtime: AgentRuntimeState
  ): string | undefined;
}): PickerGroup[] {
  const query = input.query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(query);

  return input.runtimes.flatMap((runtime): PickerGroup[] => {
    const runtimeId = runtime.preflight.runtime.id;
    const label = runtime.preflight.runtime.displayName;
    const readiness = runtimeReadinessView(runtime);
    const runtimeUnavailableReason =
      input.runtimeUnavailableReason?.(runtime) ??
      (!readiness.canStart ? readiness.detail : undefined);
    const providerMatches = query.length === 0 || matches(label);
    const needsDiscovery = modelCatalogNeedsActivation(runtime);
    const discoveryInProgress =
      input.discovery?.runtimeId === runtimeId &&
      input.discovery.status === 'loading';
    const showDiscoveryOption = needsDiscovery || discoveryInProgress;
    const candidateModels = input.models
      .filter(
        (model) =>
          model.runtimeId === runtimeId &&
          (!model.hidden ||
            (model.id === input.modelId && runtimeId === input.runtimeId))
      )
      .map((model, catalogIndex) => ({
        model,
        catalogIndex,
        unavailableReason:
          runtimeUnavailableReason ?? input.modelUnavailableReason?.(model, runtime)
      }))
      .filter(({ model }) => providerMatches || matches(model.displayName))
      .sort((left, right) => {
        const availabilityOrder =
          Number(Boolean(left.unavailableReason)) -
          Number(Boolean(right.unavailableReason));
        if (availabilityOrder !== 0) return availabilityOrder;
        const defaultOrder =
          Number(!left.model.isDefault) - Number(!right.model.isDefault);
        return defaultOrder !== 0
          ? defaultOrder
          : left.catalogIndex - right.catalogIndex;
      });

    if (
      (showDiscoveryOption && !providerMatches) ||
      (!providerMatches && candidateModels.length === 0)
    ) {
      return [];
    }

    let options: PickerOption[] = [];

    if (showDiscoveryOption) {
      options = [
        {
          id: pickerOptionId(input.popupId, runtimeId, 'discovery'),
          kind: 'discovery',
          runtime,
          selected: false,
          meta: '',
          title: runtimeUnavailableReason ?? `Load models from ${label}.`,
          ...(runtimeUnavailableReason
            ? { unavailableReason: runtimeUnavailableReason }
            : {})
        }
      ];
    } else if (candidateModels.length > 0) {
      options = candidateModels.map(({ model, unavailableReason }) => ({
        id: pickerOptionId(input.popupId, runtimeId, model.id),
        kind: 'model',
        runtime,
        model,
        selected: runtimeId === input.runtimeId && model.id === input.modelId,
        meta: model.isDefault ? 'default' : '',
        title:
          unavailableReason ?? `Run ${model.displayName} through ${label}.`,
        ...(unavailableReason ? { unavailableReason } : {})
      }));
    } else if (providerMatches) {
      options = [
        {
          id: pickerOptionId(input.popupId, runtimeId, 'provider-default'),
          kind: 'provider-default',
          runtime,
          selected: runtimeId === input.runtimeId && input.modelId === '',
          meta: 'no catalog',
          title:
            runtimeUnavailableReason ??
            `Run ${label} on the model selected by the provider.`,
          ...(runtimeUnavailableReason
            ? { unavailableReason: runtimeUnavailableReason }
            : {})
        }
      ];
    }

    if (options.length === 0) return [];

    const unavailableCount = options.filter(
      (option) => option.kind === 'model' && option.unavailableReason
    ).length;
    const meta = runtimeUnavailableReason
      ? readiness.canStart
        ? 'Unavailable'
        : readiness.label
      : unavailableCount > 0
        ? `${unavailableCount} unavailable`
        : '';
    return [{ runtimeId, label, meta, options }];
  });
}

function pickerOptionId(
  popupId: string,
  runtimeId: string,
  optionId: string
): string {
  return `${popupId}-${encodeURIComponent(runtimeId)}-${encodeURIComponent(optionId)}`;
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | undefined {
  let parent = element.parentElement;
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
    parent = parent.parentElement;
  }
  return undefined;
}

export function agentModelMenuGeometry(input: {
  trigger: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>;
  boundary: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>;
}): {
  maxHeight: number;
  width: number;
  alignRight: boolean;
  placement: 'bottom' | 'top';
} {
  const boundaryTop = Math.max(8, input.boundary.top);
  const boundaryBottom = input.boundary.bottom;
  const spaceAbove = Math.max(0, input.trigger.top - boundaryTop - MODEL_MENU_GAP);
  const spaceBelow = Math.max(
    0,
    boundaryBottom - input.trigger.bottom - MODEL_MENU_GAP
  );
  const placement =
    spaceBelow >= MODEL_MENU_MIN_HEIGHT
      ? 'bottom'
      : spaceAbove >= MODEL_MENU_MIN_HEIGHT
        ? 'top'
        : spaceBelow >= spaceAbove
          ? 'bottom'
          : 'top';
  const availableHeight = placement === 'bottom' ? spaceBelow : spaceAbove;
  const boundaryWidth = input.boundary.right - input.boundary.left;
  const width = Math.max(1, Math.min(MODEL_MENU_WIDTH, boundaryWidth - 16));
  return {
    placement,
    maxHeight: Math.max(
      MODEL_MENU_MIN_HEIGHT,
      Math.min(MODEL_MENU_MAX_HEIGHT, availableHeight)
    ),
    width,
    alignRight: input.trigger.left + width > input.boundary.right - 8
  };
}

export function AgentModelSetting({
  label,
  hint,
  runtimeId,
  modelId,
  fallbackSummary,
  selectionUnavailable,
  selectionUnavailableMessage,
  reasoningEffort,
  models,
  runtimes,
  runtimeUnavailableReason,
  modelUnavailableReason,
  onDiscoverModels,
  onSelectionChange,
  onReasoningEffortChange
}: {
  label: string;
  hint?: string;
  runtimeId: string;
  modelId: string;
  fallbackSummary?: string;
  selectionUnavailable?: boolean;
  selectionUnavailableMessage?: string;
  reasoningEffort?: string;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  runtimeUnavailableReason?(runtime: AgentRuntimeState): string | undefined;
  modelUnavailableReason?(
    model: AgentModel,
    runtime: AgentRuntimeState
  ): string | undefined;
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
        showRuntimeLabel={false}
        runtimeId={runtimeId}
        modelId={modelId}
        fallbackSummary={fallbackSummary}
        selectionUnavailable={selectionUnavailable}
        selectionUnavailableMessage={selectionUnavailableMessage}
        reasoningEffort={reasoningEffort}
        models={models}
        runtimes={runtimes}
        runtimeUnavailableReason={runtimeUnavailableReason}
        modelUnavailableReason={modelUnavailableReason}
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
    <ChevronDown
      absoluteStrokeWidth
      className={`tm-agent-console__chevron ${open ? 'is-open' : ''}`}
      aria-hidden="true"
      size={12}
      strokeWidth={1.5}
    />
  );
}

function CheckIcon() {
  return <Check aria-hidden="true" absoluteStrokeWidth size={13} strokeWidth={1.5} />;
}

function SpinnerIcon() {
  return <span className="tm-agent-console__spinner" aria-hidden="true" />;
}
