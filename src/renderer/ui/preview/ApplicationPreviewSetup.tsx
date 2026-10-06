import { useRef, useState, type RefObject } from 'react';
import type {
  AcceptPreviewRecipeDraftResult,
  PreviewRecipeGenerationSnapshot,
  PreviewRecipeValidation
} from '../../../shared/contracts';
import { PreviewRecipeGenerationModal } from './PreviewRecipeGenerationModal';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { message, PreviewDialog } from './previewPresentation';

export function ApplicationPreviewSetup(props: {
  taskId: string;
  worktreeId: string;
  state?: PreviewRecipeGenerationSnapshot;
  disabledReason?: string;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
  onModalOpenChange(open: boolean): void;
  get(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  generate(taskId: string, clarification?: string): Promise<PreviewRecipeGenerationSnapshot>;
  validate(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<PreviewRecipeValidation>;
  accept(
    taskId: string,
    draftId: string,
    yaml: string
  ): Promise<AcceptPreviewRecipeDraftResult>;
  discard(taskId: string): Promise<PreviewRecipeGenerationSnapshot>;
  writeManually(taskId: string, worktreeId: string): Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<'command' | 'static'>('command');
  const [command, setCommand] = useState('');
  const [directory, setDirectory] = useState('.');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const returnFocus = useRef<HTMLElement | undefined>(undefined);
  const modalRoot = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : document.body
  );
  async function generate(clarification?: string) {
    setError(undefined);
    await props.generate(props.taskId, clarification);
  }
  async function openGenerator(button: HTMLElement) {
    returnFocus.current = button;
    setError(undefined);
    setOpen(true);
    try {
      const state = await props.get(props.taskId);
      if (state.status === 'EMPTY') await generate();
    } catch (cause) {
      setOpen(false);
      setError(message(cause));
    }
  }
  const state = props.state ?? {
    taskId: props.taskId,
    status: 'EMPTY' as const
  };
  return (
    <section className="tm-preview-setup" aria-label="Preview setup">
      <h3 className="tm-panel__title tm-panel__title--flush">Configure your application</h3>
      <p className="tm-application-preview__notice">
        Run a development command or serve a static folder.
      </p>
      <div className="tm-preview-workspace__actions">
        <button
          className="primary-button"
          disabled={!!props.disabledReason}
          title={props.disabledReason}
          onClick={() => {
            setError(undefined);
            setCreating(true);
          }}
        >
          Add application
        </button>
        <button
          className="outline-button"
          disabled={!!props.disabledReason}
          title={props.disabledReason}
          onClick={(event) => void openGenerator(event.currentTarget)}
        >
          Generate with agent
        </button>
        <button
          className="ghost-button"
          onClick={() => {
            setError(undefined);
            void props
              .writeManually(props.taskId, props.worktreeId)
              .catch((cause) => setError(message(cause)));
          }}
        >
          Open source folder
        </button>
      </div>
      {props.disabledReason ? (
        <p className="tm-application-preview__notice">{props.disabledReason}</p>
      ) : null}
      {error && !open && !creating ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {creating ? (
        <PreviewDialog
          title="Add application"
          busy={busy}
          onClose={() => setCreating(false)}
          onOpenChange={props.onModalOpenChange}
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            void api
              .createApplicationPreviewConfiguration({
                taskId: props.taskId,
                type,
                command: type === 'command' ? command : undefined,
                directory
              })
              .then(
                () => setCreating(false),
                (cause) => setError(message(cause))
              )
              .finally(() => setBusy(false));
          }}
          footer={
            <>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy}>
                Review and start
              </button>
            </>
          }
        >
          <label className="field">
            <span>Application type</span>
            <select
              value={type}
              onChange={(event) =>
                setType(event.target.value as 'command' | 'static')
              }
            >
              <option value="command">Development command</option>
              <option value="static">Static site</option>
            </select>
          </label>
          <label className="field">
            <span>{type === 'command' ? 'Working folder' : 'Site folder'}</span>
            <input
              value={directory}
              required
              onChange={(event) => setDirectory(event.target.value)}
            />
            <small>Relative to this worktree.</small>
          </label>
          {type === 'command' ? (
            <label className="field">
              <span>Command</span>
              <input
                value={command}
                required
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npm run dev -- --port $PORT"
                spellCheck={false}
              />
              <small>
                The runtime provides PORT. The command must listen on it.
              </small>
            </label>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
      {open ? (
        <PreviewRecipeGenerationModal
          taskId={props.taskId}
          state={
            error
              ? {
                  ...state,
                  status: 'FAILED',
                  message: error,
                  failureCode: 'AGENT_UNAVAILABLE'
                }
              : state
          }
          returnFocus={returnFocus.current}
          onClose={() => setOpen(false)}
          onRegenerate={generate}
          onValidate={props.validate}
          onAccept={props.accept}
          onDiscard={async () => {
            setError(undefined);
            await props.discard(props.taskId);
            setOpen(false);
          }}
          fallbackReturnFocusRef={props.fallbackReturnFocusRef}
          modalRootRef={modalRoot}
          onModalOpenChange={props.onModalOpenChange}
        />
      ) : null}
    </section>
  );
}
