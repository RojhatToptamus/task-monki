import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject
} from 'react';
import type { PreviewSecretsApi } from '../../../shared/applicationPreview';
import { message, PreviewDialog } from './previewPresentation';

type VaultStatus = Awaited<ReturnType<PreviewSecretsApi['status']>>;

export function PreviewSecretDialog({
  references,
  recipients,
  onClose,
  onSaved,
  onModalOpenChange,
  fallbackReturnFocusRef,
  inPreview = true,
  inline = false
}: {
  /** Omit to create a reference; an empty list unlocks storage only. */
  references?: string[];
  fallbackReturnFocusRef?: RefObject<HTMLElement | null>;
  inPreview?: boolean;
  inline?: boolean;
  recipients?: Record<string, string[]>;
  onClose(): void;
  onSaved(): void | Promise<void>;
  onModalOpenChange?(open: boolean): void;
}) {
  const api = window.previewSecrets;
  const creating = references === undefined;
  const unlockOnly = references?.length === 0;
  const [reference, setReference] = useState(references?.[0] ?? '');
  const [status, setStatus] = useState<VaultStatus>();
  const [exists, setExists] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const password = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const value = useRef<HTMLInputElement>(null);
  const pastedValue = useRef<string | undefined>(undefined);
  const [multiline, setMultiline] = useState(false);
  const remember = useRef<HTMLInputElement>(null);
  function clearValue() {
    if (value.current) value.current.value = '';
    pastedValue.current = undefined;
    setMultiline(false);
  }
  const attachValue = useCallback((node: HTMLInputElement | null) => {
    value.current = node;
    if (node)
      return () => {
        node.value = '';
        value.current = null;
        pastedValue.current = undefined;
      };
  }, []);
  const attachPassword = useCallback((node: HTMLInputElement | null) => {
    password.current = node;
    if (node)
      return () => {
        node.value = '';
        password.current = null;
      };
  }, []);
  const attachConfirmation = useCallback((node: HTMLInputElement | null) => {
    confirmation.current = node;
    if (node)
      return () => {
        node.value = '';
        confirmation.current = null;
      };
  }, []);
  useEffect(() => {
    let disposed = false;
    setExists(undefined);
    async function read() {
      if (!api) {
        setError('Secret storage is available in the desktop app.');
        return;
      }
      try {
        const next = await api.status();
        const present = creating
          ? false
          : next.state === 'unlocked' && reference
            ? await api.has({ id: reference })
            : undefined;
        if (!disposed) {
          setStatus(next);
          setExists(present);
        }
      } catch (cause) {
        if (!disposed) setError(message(cause));
      }
    }
    void read();
    return () => {
      disposed = true;
    };
  }, [api, creating, reference, refresh]);
  const locked = status && status.state !== 'unlocked';
  const title = !status
    ? 'Secret storage'
    : locked
      ? status.state === 'new'
        ? 'Create secret storage'
        : 'Unlock secret storage'
      : creating
        ? 'New secret'
        : exists
          ? 'Replace secret value'
          : 'Add missing secret';
  async function submit() {
    if (!api || !status) return;
    setError(undefined);
    if (
      status.state === 'new' &&
      password.current?.value !== confirmation.current?.value
    ) {
      setError('Passwords do not match.');
      confirmation.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (locked) {
        const input = {
          password: password.current?.value ?? '',
          confirmation: confirmation.current?.value,
          create: status.state === 'new',
          remember: remember.current?.checked
        };
        if (password.current) password.current.value = '';
        if (confirmation.current) confirmation.current.value = '';
        await api.unlock(input);
        if (unlockOnly) await onSaved();
        else setRefresh((previous) => previous + 1);
      } else if (unlockOnly) {
        await onSaved();
      } else {
        const input = {
          id: reference,
          value: pastedValue.current ?? value.current?.value ?? ''
        };
        clearValue();
        if (exists) {
          if (!(await api.update(input)))
            throw new Error(
              'This reference was removed. Close this dialog and add it again.'
            );
        } else await api.create(input);
        await onSaved();
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const Container = inline ? InlineSecretForm : PreviewDialog;
  return (
    <Container
      title={title}
      fallbackReturnFocusRef={fallbackReturnFocusRef}
      busy={busy}
      onClose={onClose}
      onOpenChange={onModalOpenChange}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <button
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={onClose}
          >
            {inline ? 'Cancel' : inPreview ? 'Back to Preview' : 'Cancel'}
          </button>
          <button
            className={inline ? 'outline-button' : 'primary-button'}
            disabled={
              busy ||
              !status ||
              (!locked && !unlockOnly && (!reference || exists === undefined))
            }
          >
            {busy
              ? 'Saving…'
              : locked
                ? status?.state === 'new'
                  ? 'Create storage'
                  : 'Unlock'
                : unlockOnly
                  ? 'Done'
                  : creating
                    ? 'Create secret'
                    : exists
                      ? 'Replace value'
                      : 'Save secret'}
          </button>
        </>
      }
    >
      {creating ? (
        <label className="field">
          <span>Reference</span>
          <input
            value={reference}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._/\-]{0,127}"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              clearValue();
              setReference(event.target.value);
            }}
            placeholder="project/dev/api"
          />
        </label>
      ) : null}
      {reference && !creating ? (
        <label className="field">
          <span>Secret reference</span>
          {references!.length > 1 ? (
            <select
              value={reference}
              disabled={busy}
              onChange={(event) => {
                clearValue();
                setReference(event.target.value);
              }}
            >
              {references!.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          ) : (
            <input value={reference} readOnly autoComplete="off" />
          )}
        </label>
      ) : null}
      {recipients?.[reference]?.length ? (
        <p>Used by {recipients[reference].join(', ')}.</p>
      ) : null}
      {!inline ? <p>
        Saving or unlocking does not approve or start a preview.
        {inPreview
          ? ' Return to review before starting.'
          : ' Changes apply on the next approved start.'}
      </p> : null}
      {status?.warning ? <p role="status">{status.warning}</p> : null}
      {!status ? (
        <p role="status">Loading secret storage…</p>
      ) : locked ? (
        <>
          <p>
            {status.state === 'new'
              ? 'Choose a password to encrypt your local secret storage.'
              : 'Enter your storage password to add or replace this value.'}
          </p>
          <label className="field">
            <span>Password</span>
            <input
              ref={attachPassword}
              type="password"
              required
              minLength={status.state === 'new' ? 12 : 1}
              autoComplete={
                status.state === 'new' ? 'new-password' : 'current-password'
              }
            />
          </label>
          {status.state === 'new' ? (
            <label className="field">
              <span>Confirm password</span>
              <input
                ref={attachConfirmation}
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
              />
            </label>
          ) : null}
          {status.canRemember ? (
            <label className="tm-application-preview__checkbox">
              <input type="checkbox" ref={remember} />
              <span>Remember on this Mac</span>
            </label>
          ) : null}
        </>
      ) : unlockOnly ? (
        <p>
          Storage is unlocked. Return to Preview to review the required
          references.
        </p>
      ) : exists === undefined ? (
        <p role="status">Checking reference…</p>
      ) : (
        <>
          {exists ? (
            <p>
              This replaces the shared value for <code>{reference}</code>. Other
              previews using this reference receive the new value on their next
              start.
            </p>
          ) : null}
          <label className="field">
            <span>{exists ? 'New value' : 'Secret value'}</span>
            <input
              type="password"
              ref={attachValue}
              readOnly={multiline}
              onPaste={(event) => {
                const text = event.clipboardData.getData('text/plain');
                if (!multiline && !/[\r\n]/.test(text)) return;
                event.preventDefault();
                const hasLines = /[\r\n]/.test(text);
                pastedValue.current = hasLines ? text : undefined;
                event.currentTarget.value = hasLines
                  ? 'Multiline value pasted'
                  : text;
                setMultiline(hasLines);
              }}
              required
              autoComplete="off"
              spellCheck={false}
              aria-label="Secret value"
            />
          </label>
          <p>
            {multiline
              ? 'Multiline value pasted. Paste again to replace it, or clear it to type a new value.'
              : 'Values stay concealed. You can paste a multiline value.'}
          </p>
          {multiline ? (
            <button
              type="button"
              className="outline-button"
              onClick={() => {
                clearValue();
                value.current?.focus();
              }}
            >
              Clear pasted value
            </button>
          ) : null}
        </>
      )}
      {error ? (
        <div>
          <p className="form-error" role="alert">
            {error}
          </p>
          <button
            className="outline-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setError(undefined);
              clearValue();
              setRefresh((previous) => previous + 1);
            }}
          >
            Retry storage check
          </button>
        </div>
      ) : null}
    </Container>
  );
}

function InlineSecretForm({
  title,
  children,
  footer,
  onSubmit,
  onClose,
  busy
}: ComponentProps<typeof PreviewDialog>) {
  return (
    <form
      className="tm-preview-secret-form"
      aria-label={title}
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <h4>{title}</h4>
      {children}
      <div className="tm-preview-secret-actions">{footer}</div>
    </form>
  );
}
