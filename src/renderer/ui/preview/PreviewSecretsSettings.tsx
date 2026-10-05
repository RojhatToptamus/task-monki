import {
  Ellipsis,
  KeyRound,
  LockKeyhole,
  ArrowLeft,
  Search
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewSecretsApi } from '../../../shared/applicationPreview';
import { PreviewDialog, message } from './previewPresentation';
import { DisclosureChevron } from '../DisclosureChevron';
import { SettingsPane } from '../SettingsPane';
import { ActionMenu } from '../ActionMenu';

type VaultStatus = Awaited<ReturnType<PreviewSecretsApi['status']>>;
type SecretPage = Awaited<ReturnType<PreviewSecretsApi['list']>>;

export function PreviewSecretsSettings({
  context
}: {
  context?: { title: string; references: string[]; onReturn(): void };
}) {
  const api = window.previewSecrets;
  const [status, setStatus] = useState<VaultStatus>();
  const [page, setPage] = useState<SecretPage>({ ids: [], usage: {} });
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined
  ]);
  const after = cursors.at(-1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; create: boolean }>();
  const [removing, setRemoving] = useState<string>();
  const [unlocking, setUnlocking] = useState(false);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const value = useRef<HTMLTextAreaElement>(null);
  const remember = useRef<HTMLInputElement>(null);
  const attachValue = useCallback((node: HTMLTextAreaElement | null) => {
    value.current = node;
    if (node)
      return () => {
        node.value = '';
        value.current = null;
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
    setLoading(true);
    async function read() {
      if (!api) return;
      try {
        const next = await api.status();
        const result =
          next.state === 'unlocked'
            ? await api.list({ query: search, after })
            : { ids: [], usage: {} };
        if (!disposed) {
          setStatus(next);
          setPage(result);
          setError(undefined);
        }
      } catch (cause) {
        if (!disposed) setError(message(cause));
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void read();
    return () => {
      disposed = true;
    };
  }, [api, search, after, refresh]);
  async function run(action: () => Promise<unknown>) {
    if (!api) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      if (password.current) password.current.value = '';
      if (confirmation.current) confirmation.current.value = '';
      if (value.current) value.current.value = '';
      setBusy(false);
    }
  }
  return (
    <SettingsPane
      id="secrets"
      title="Secrets"
      detail="Encrypted values for application previews. Changes apply on the next start."
      action={
        status?.state === 'unlocked' ? (
          <div className="tm-application-preview__toolbar">
            <button
              ref={primaryAction}
              className="tm-settings__button tm-settings__button--primary"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                setEditing({ id: '', create: true });
              }}
            >
              New secret
            </button>
            <ActionMenu
              label="Secret storage actions"
              trigger={<Ellipsis size={16} aria-hidden="true" />}
              items={[
                {
                  label: 'Lock storage',
                  disabled: busy,
                  onSelect: () => void run(() => api!.lock())
                },
                ...(status.canRemember
                  ? [
                      {
                        label: 'Remember unlock',
                        disabled: busy,
                        onSelect: () => void run(() => api!.remember())
                      },
                      {
                        label: 'Forget automatic unlock',
                        disabled: busy,
                        onSelect: () => void run(() => api!.forget())
                      }
                    ]
                  : [])
              ]}
            />
          </div>
        ) : undefined
      }
    >
      {context ? (
        <div className="tm-application-preview__toolbar">
          <button
            className="outline-button"
            disabled={busy}
            onClick={context.onReturn}
          >
            <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />{' '}
            {context.title}
          </button>
          {context.references.map((id) => (
            <button
              key={id}
              className="outline-button"
              disabled={busy || status?.state !== 'unlocked'}
              onClick={() =>
                void run(async () => {
                  const matches = await api!.list({ query: id });
                  setEditing({ id, create: !matches.ids.includes(id) });
                })
              }
            >
              {id}
            </button>
          ))}
        </div>
      ) : null}
      {!api ? (
        <p>Secret management is available in the desktop application.</p>
      ) : !status ? (
        <p role="status">Loading secret storage…</p>
      ) : status.state !== 'unlocked' ? (
        <div className="tm-settings__list">
          <div className="tm-application-secrets__empty">
            <LockKeyhole size={20} aria-hidden="true" />
            <p>
              {status.state === 'new'
                ? 'Store secrets once and use their references in your previews.'
                : 'Unlock storage to manage your secret references.'}
            </p>
            <button
              ref={primaryAction}
              className="primary-button"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                setUnlocking(true);
              }}
            >
              {status.state === 'new' ? 'Set up secrets' : 'Unlock'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <form
            className="tm-application-secrets__search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setCursors([undefined]);
              setSearch(query);
            }}
          >
            <label className="field field--search">
              <Search size={16} strokeWidth={1.5} aria-hidden="true" />
              <input
                aria-label="Search secret references"
                type="search"
                placeholder="Search references…"
                value={query}
                maxLength={128}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (!event.target.value) {
                    setCursors([undefined]);
                    setSearch('');
                  }
                }}
              />
            </label>
            <button className="tm-settings__button" disabled={busy || loading}>
              Search
            </button>
            <span className="tm-application-preview__muted" role="status">
              {loading ? 'Loading…' : `${page.ids.length} shown`}
            </span>
          </form>
          <div className="tm-settings__list" aria-busy={loading}>
            {page.ids.length ? (
              page.ids.map((id) => (
                <div
                  className="tm-settings__row tm-application-secrets__row"
                  key={id}
                >
                  <KeyRound size={16} strokeWidth={1.5} aria-hidden="true" />
                  <div className="tm-application-secrets__identity">
                    <code title={id}>{id}</code>
                    {page.usage[id]?.length ? (
                      <details>
                        <summary>
                          <DisclosureChevron />
                          Used in {page.usage[id].length} source{' '}
                          {page.usage[id].length === 1 ? 'folder' : 'folders'}
                        </summary>
                        {page.usage[id].map((source) => (
                          <p key={source}>
                            <code>{source}</code>
                          </p>
                        ))}
                      </details>
                    ) : null}
                  </div>
                  <button
                    className="tm-settings__button"
                    disabled={busy}
                    onClick={() => {
                      setError(undefined);
                      setEditing({ id, create: false });
                    }}
                  >
                    Edit
                  </button>
                  <ActionMenu
                    label={`Actions for ${id}`}
                    trigger={<Ellipsis size={16} aria-hidden="true" />}
                    items={[
                      {
                        label: 'Delete secret…',
                        danger: true,
                        disabled: busy,
                        onSelect: () => {
                          setError(undefined);
                          setRemoving(id);
                        }
                      }
                    ]}
                  />
                </div>
              ))
            ) : (
              <div className="tm-settings__empty">
                {search ? 'No matching references.' : 'No secrets yet.'}
              </div>
            )}
          </div>
          <div className="tm-application-preview__toolbar">
            {cursors.length > 1 ? (
              <button
                className="outline-button"
                disabled={busy || loading}
                onClick={() => setCursors((value) => value.slice(0, -1))}
              >
                Previous references
              </button>
            ) : null}
            {page.next ? (
              <button
                className="outline-button"
                disabled={busy || loading}
                onClick={() => setCursors((value) => [...value, page.next])}
              >
                Next references
              </button>
            ) : null}
          </div>
        </>
      )}
      {status?.warning ? (
        <p role="status" className="form-warning">
          {status.warning}
        </p>
      ) : null}
      {error && !unlocking && !editing && !removing ? (
        <p role="alert" className="tm-application-preview__error">
          {error}{' '}
          <button
            className="ghost-button"
            disabled={busy || loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}
      {unlocking && api ? (
        <PreviewDialog
          fallbackReturnFocusRef={primaryAction}
          title={
            status?.state === 'new'
              ? 'Create secret storage'
              : 'Unlock secret storage'
          }
          busy={busy}
          onClose={() => setUnlocking(false)}
          onSubmit={(event) => {
            event.preventDefault();
            if (
              status?.state === 'new' &&
              password.current?.value !== confirmation.current?.value
            ) {
              setError('Passwords do not match.');
              confirmation.current?.focus();
              return;
            }
            void run(async () => {
              const input = {
                password: password.current?.value ?? '',
                confirmation: confirmation.current?.value,
                create: status?.state === 'new',
                remember: remember.current?.checked
              };
              if (password.current) password.current.value = '';
              if (confirmation.current) confirmation.current.value = '';
              setStatus(await api.unlock(input));
              setUnlocking(false);
            });
          }}
          footer={
            <>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => setUnlocking(false)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy}>
                {status?.state === 'new' ? 'Create' : 'Unlock'}
              </button>
            </>
          }
        >
          <label className="field">
            <span>Password</span>
            <input
              ref={attachPassword}
              type="password"
              required
              minLength={status?.state === 'new' ? 12 : 1}
              autoComplete={
                status?.state === 'new' ? 'new-password' : 'current-password'
              }
            />
          </label>
          {status?.state === 'new' ? (
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
          {status?.canRemember ? (
            <label className="tm-application-preview__checkbox">
              <input type="checkbox" ref={remember} />
              <span>Remember on this Mac</span>
            </label>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
      {editing && api ? (
        <PreviewDialog
          fallbackReturnFocusRef={primaryAction}
          title={editing.create ? 'New secret' : 'Edit secret'}
          busy={busy}
          onClose={() => setEditing(undefined)}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const input = {
                id: editing.id,
                value: value.current?.value ?? ''
              };
              if (value.current) value.current.value = '';
              if (editing.create) await api.create(input);
              else if (!(await api.update(input)))
                throw new Error(
                  'This secret was removed. Create a new reference to store it again.'
                );
              setEditing(undefined);
            });
          }}
          footer={
            <>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy}>
                {editing.create ? 'Create secret' : 'Save'}
              </button>
            </>
          }
        >
          <label className="field">
            <span>Reference</span>
            <input
              value={editing.id}
              readOnly={!editing.create}
              onChange={(event) =>
                setEditing({ ...editing, id: event.target.value })
              }
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._/\-]{0,127}"
              autoComplete="off"
              placeholder="project/dev/api"
            />
          </label>
          <label className="field">
            <span>{editing.create ? 'Value' : 'New value'}</span>
            <textarea
              ref={attachValue}
              required
              autoComplete="off"
              spellCheck={false}
              aria-label="Secret value"
            />
          </label>
          {!editing.create ? (
            <p className="tm-application-preview__muted">
              The stored value is never displayed.
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
      {removing && api ? (
        <PreviewDialog
          fallbackReturnFocusRef={primaryAction}
          size="compact"
          title="Delete secret?"
          busy={busy}
          onClose={() => setRemoving(undefined)}
          footer={
            <>
              <button
                className="outline-button"
                disabled={busy}
                onClick={() => setRemoving(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.remove({ id: removing });
                    setRemoving(undefined);
                  })
                }
              >
                Delete secret
              </button>
            </>
          }
        >
          <p>
            Delete <code>{removing}</code>? Previews that use it will need a
            value before their next start. Running processes keep their existing
            environment.
          </p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
    </SettingsPane>
  );
}
