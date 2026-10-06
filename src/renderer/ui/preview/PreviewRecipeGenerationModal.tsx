import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type {
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation
} from '../../../shared/contracts';
import { humanizeEnum } from '../../model/formatting';
import { useDialogFocusBoundary } from '../dialogFocus';
import { StatusGlyph } from '../StatusBadge';
import { message } from './previewPresentation';

export function PreviewRecipeGenerationModal({
  taskId,
  state,
  returnFocus,
  onClose,
  onRegenerate,
  onValidate,
  onAccept,
  onDiscard,
  fallbackReturnFocusRef,
  modalRootRef,
  onModalOpenChange
}: {
  taskId: string;
  state: PreviewRecipeGenerationSnapshot;
  returnFocus?: HTMLElement;
  onClose(): void;
  onRegenerate(clarification?: string): Promise<void>;
  onValidate(taskId: string, draftId: string, yaml: string): Promise<PreviewRecipeValidation>;
  onAccept(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<import('../../../shared/contracts').AcceptPreviewRecipeDraftResult>;
  onDiscard(): Promise<void>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  modalRootRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [yaml, setYaml] = useState(state.draft?.yaml ?? '');
  const [loadedDraftId, setLoadedDraftId] = useState(state.draft?.id);
  const [edited, setEdited] = useState(false);
  const [validation, setValidation] = useState<PreviewRecipeValidation>();
  const [accepting, setAccepting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [regenerateArmed, setRegenerateArmed] = useState(false);
  const [clarification, setClarification] = useState('');
  const [actionError, setActionError] = useState<string>();
  const busy = accepting || discarding;
  const generating = state.status === 'GENERATING';
  const report = state.draft?.report ?? state.report;
  const questions = state.report?.unresolvedDecisions ?? [];
  const compact = !state.draft;
  const needsInput = state.status === 'NEEDS_INPUT';
  const answeringQuestions = !generating && questions.length > 0;

  useEffect(() => {
    if (state.draft && state.draft.id !== loadedDraftId) {
      setYaml(state.draft.yaml);
      setLoadedDraftId(state.draft.id);
      setEdited(false);
      setValidation(state.draft.validation);
      setRegenerateArmed(false);
      setClarification('');
    }
  }, [loadedDraftId, state.draft]);

  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: closeButtonRef,
    fallbackReturnFocusRef,
    busy,
    onClose,
    returnFocus
  });

  useLayoutEffect(() => {
    onModalOpenChange(true);
    return () => onModalOpenChange(false);
  }, [onModalOpenChange]);

  const validateAndAccept = async () => {
    const draft = state.draft;
    if (!draft || accepting || generating) return;
    setAccepting(true);
    setActionError(undefined);
    try {
      const nextValidation = await onValidate(taskId, draft.id, yaml);
      setValidation(nextValidation);
      if (nextValidation.status !== 'VALID') return;
      await onAccept(taskId, draft.id, yaml);
      onClose();
    } catch (cause) {
      setActionError(message(cause));
    } finally {
      setAccepting(false);
    }
  };

  const regenerate = async () => {
    if (generating) return;
    if (edited && !regenerateArmed) {
      setRegenerateArmed(true);
      return;
    }
    setValidation(undefined);
    setRegenerateArmed(false);
    setActionError(undefined);
    try {
      await onRegenerate(clarification.trim() || undefined);
    } catch (cause) {
      setActionError(message(cause));
    }
  };

  const discard = async () => {
    setDiscarding(true);
    setActionError(undefined);
    try {
      await onDiscard();
    } catch (cause) {
      setActionError(message(cause));
    } finally {
      setDiscarding(false);
    }
  };

  const dialog = (
    <div
      className="tm-modal tm-preview-recipe-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-recipe-generation-title"
    >
      <div className="tm-modal__scrim" onClick={busy ? undefined : onClose} />
      <div
        ref={panelRef}
        className={`tm-modal__panel tm-preview-recipe-review ${
          compact ? 'tm-preview-recipe-review--compact' : ''
        }`}
        tabIndex={-1}
      >
        <header className="tm-preview-recipe-review__head">
          <div>
            <h3 id="preview-recipe-generation-title">{needsInput ? 'Complete preview setup' : 'Preview configuration'}</h3>
            <p>
              Review and save the draft before approving execution.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="tm-preview-recipe-review__close"
            disabled={busy}
            aria-label="Close Preview recipe review"
            onClick={onClose}
          >
            <X aria-hidden="true" absoluteStrokeWidth size={16} strokeWidth={1.5} />
          </button>
        </header>

        {generating ? (
          <div className="tm-preview-recipe-progress" role="status" aria-live="polite">
            <StatusGlyph kind="working" />
            <div>
              <strong>{generationStageLabel(state.stage)}</strong>
              <p>{generationStageDetail(state.stage)}</p>
            </div>
          </div>
        ) : null}

        {state.status === 'FAILED' ? (
          <div className="tm-preview-recipe-message" role="status">
            <p role="alert">{state.message}</p>
          </div>
        ) : null}

        {answeringQuestions && report ? (
          <div className="tm-preview-recipe-questions">
            <ul id="preview-generation-questions">
              {questions.map((question, index) => <li key={index}>{question}</li>)}
            </ul>
            <label className="field">
              <span id="preview-generation-details-label">Setup details</span>
              <textarea
                value={clarification}
                onChange={event => {
                  setClarification(event.target.value);
                  setActionError(undefined);
                }}
                aria-labelledby="preview-generation-details-label"
                aria-describedby="preview-generation-questions preview-generation-private-inputs"
                maxLength={4000}
                rows={3}
                disabled={busy}
              />
              <small id="preview-generation-private-inputs">Use secret reference names here. Store values in Settings → Secrets.</small>
            </label>
          </div>
        ) : null}

        {state.draft ? (
          <div className="tm-preview-recipe-review__body">
            <section className="tm-preview-recipe-editor" aria-label="Generated Preview YAML">
              <div className="tm-preview-recipe-editor__head">
                <div>
                  <strong>Complete YAML</strong>
                  <span>{edited ? 'Edited' : 'Generated'} · {yaml.split('\n').length} lines</span>
                </div>
                <code>preview.yaml</code>
              </div>
              <textarea
                aria-label="Preview recipe YAML"
                value={yaml}
                disabled={generating || busy}
                spellCheck={false}
                onChange={(event) => {
                  setYaml(event.target.value);
                  setEdited(event.target.value !== state.draft?.yaml);
                  setValidation(undefined);
                  setRegenerateArmed(false);
                }}
              />
              {validation?.status === 'INVALID' ? (
                <div className="tm-preview-recipe-validation" role="alert">
                  {validation.issues.map((issue) => (
                    <p key={issue.code}>{issue.message}</p>
                  ))}
                </div>
              ) : null}
            </section>
            {report ? (
              <PreviewRecipeGenerationReportView report={report} originalDraftOnly={edited} omitQuestions={answeringQuestions} />
            ) : null}
          </div>
        ) : null}

        {actionError ? <p className="form-error tm-preview-recipe-action-error" role="alert">{actionError}</p> : null}

        <footer className="tm-preview-recipe-review__footer">
          <div className="tm-preview-recipe-review__secondary">
            <button type="button" className="outline-button" disabled={busy} onClick={onClose}>
              Close
            </button>
            {state.draft || generating ? (
              <button
                type="button"
                className="tm-preview-recipe-review__discard"
                disabled={busy}
                onClick={() => void discard()}
              >
                {discarding
                  ? generating ? 'Stopping…' : 'Discarding…'
                  : generating ? 'Stop' : 'Discard'}
              </button>
            ) : null}
          </div>
          <div className="tm-preview-recipe-review__primary">
            {state.draft ? (
              <>
                {regenerateArmed ? <span>Your edits will be replaced.</span> : null}
                <button
                  type="button"
                  className="outline-button"
                  disabled={busy || generating}
                  onClick={() => void regenerate()}
                >
                  {regenerateArmed ? 'Replace draft' : 'Regenerate'}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || generating}
                  onClick={() => void validateAndAccept()}
                >
                  {accepting ? 'Checking…' : 'Save configuration'}
                </button>
              </>
            ) : !generating ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy || (needsInput && !clarification.trim())}
                onClick={() => void regenerate()}
              >
                {needsInput ? 'Continue' : state.status === 'EMPTY' ? 'Generate draft' : 'Try again'}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
  return modalRootRef.current ? createPortal(dialog, modalRootRef.current) : dialog;
}

function PreviewRecipeGenerationReportView({
  report,
  originalDraftOnly = false,
  omitQuestions = false
}: {
  report: import('../../../shared/contracts').PreviewRecipeGenerationReport;
  originalDraftOnly?: boolean;
  omitQuestions?: boolean;
}) {
  const sections = [
    ['Evidence', report.evidence.map((item) => `${item.path} — ${item.finding}`)],
    ['Assumptions', report.assumptions],
    ['Omissions', report.omissions],
    ['Public environment', report.publicEnvironmentDecisions.map((item) =>
      `${item.key} — ${humanizeEnum(item.decision)}: ${item.reason}`
    )],
    ['Unresolved', omitQuestions ? [] : report.unresolvedDecisions]
  ] as const;
  return (
    <aside className="tm-preview-recipe-report" aria-label="Generation report">
      <div>
        <span>{originalDraftOnly ? 'Generation report · original draft' : 'Generation report'}</span>
        <strong>{report.summary}</strong>
      </div>
      {sections.map(([label, items]) => items.length ? (
        <section key={label}>
          <h4>{label}</h4>
          <ul>
            {items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}
          </ul>
        </section>
      ) : null)}
    </aside>
  );
}

function generationStageLabel(stage?: PreviewRecipeGenerationSnapshot['stage']): string {
  if (stage === 'GENERATING_DRAFT') return 'Agent is drafting the recipe';
  if (stage === 'VALIDATING_DRAFT') return 'Validating against Preview';
  return 'Preparing safe repository evidence';
}

function generationStageDetail(stage?: PreviewRecipeGenerationSnapshot['stage']): string {
  if (stage === 'GENERATING_DRAFT') {
    return 'Reading only the bounded evidence bundle and mapping proven commands, ports, and readiness.';
  }
  if (stage === 'VALIDATING_DRAFT') {
    return 'Task Monki is checking the YAML and its Preview runtime constraints.';
  }
  return 'Likely secret-bearing, binary, generated, and oversized files are excluded before inspection.';
}
