import { useMemo, useState } from 'react';
import { parseDocument } from 'yaml';
import type { PreviewConfigurationFile } from '../../../shared/applicationPreview';
import type { PreviewRecipeGenerationSnapshot } from '../../../shared/contracts';
import { AccessibleTab } from '../AccessibleTabs';
import { DisclosureChevron } from '../DisclosureChevron';
import { serviceTypeLabel } from './previewPresentation';

const fieldLabels: Record<string, string> = {
  cwd: 'Working folder',
  directory: 'Folder',
  command: 'Command',
  dependsOn: 'Starts after',
  readyPath: 'Readiness path',
  timeoutMs: 'Startup deadline (milliseconds)',
  run: 'Repeat',
  url: 'Connection',
  check: 'Check connection',
  ports: 'Ports',
  ready: 'Readiness',
  liveness: 'Health check'
};

export interface PreviewEditorDraft {
  original?: PreviewConfigurationFile;
  text: string;
  draftId?: string;
}
export type ConfigurationView = 'Configuration' | 'YAML' | 'Changes';

export function ApplicationConfiguration({
  draft,
  previous,
  view,
  onView,
  onChange,
  onSave,
  busy,
  generation
}: {
  draft: PreviewEditorDraft;
  previous?: PreviewConfigurationFile;
  view: ConfigurationView;
  onView(view: ConfigurationView): void;
  onChange(text: string): void;
  onSave(): void;
  busy: boolean;
  generation?: PreviewRecipeGenerationSnapshot;
}) {
  const [edit, setEdit] = useState<{
    path: string[];
    label: string;
    value: string;
    json: boolean;
  }>();
  const [error, setError] = useState<string>();
  const document = useMemo(() => parseDocument(draft.text), [draft.text]);
  const config = useMemo(() => {
    try {
      return document.errors.length
        ? undefined
        : (document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }, [document]);
  const services: Array<[string, Record<string, unknown>, string[]]> =
    config?.type === 'environment'
      ? Object.entries(
          (config.services as Record<string, Record<string, unknown>>) ?? {}
        )
          .filter(([, node]) => !!node && typeof node === 'object')
          .map(([id, node]) => [id, node, ['services', id]])
      : config
        ? [['Application', config, []]]
        : [];
  const changeField = () => {
    if (!edit) return;
    try {
      const next = parseDocument(draft.text);
      next.setIn(edit.path, edit.json ? JSON.parse(edit.value) : edit.value);
      onChange(next.toString());
      setEdit(undefined);
      setError(undefined);
    } catch {
      setError('Use valid JSON for commands, references, lists, and numbers.');
    }
  };
  const original =
    draft.draftId || draft.text !== draft.original?.text
      ? (draft.original?.text ?? '')
      : (previous?.text ?? draft.original?.text ?? '');
  const before = original.split('\n');
  const after = draft.text.split('\n');
  let first = 0;
  while (
    first < before.length &&
    first < after.length &&
    before[first] === after[first]
  )
    first++;
  let last = 0;
  while (
    last < before.length - first &&
    last < after.length - first &&
    before[before.length - last - 1] === after[after.length - last - 1]
  )
    last++;
  const report = generation?.draft?.report ?? generation?.report;
  return (
    <div className="tm-preview-configuration">
      <div className="tm-preview-configuration__toolbar">
        <strong>
          {draft.original?.name ?? 'preview.yaml'}
          {draft.draftId
            ? ' · proposed'
            : draft.text !== draft.original?.text
              ? ' · unsaved'
              : ''}
        </strong>
        <button
          className="outline-button"
          disabled={
            busy || (!draft.draftId && draft.text === draft.original?.text)
          }
          onClick={onSave}
        >
          Save configuration
        </button>
        <nav
          className="tm-tabs"
          role="tablist"
          aria-label="Configuration views"
        >
          {(['Configuration', 'YAML', 'Changes'] as const).map((item) => (
            <AccessibleTab
              key={item}
              id={`configuration-${item}`}
              panelId={`configuration-view-${item}`}
              label={item}
              selected={view === item}
              onSelect={() => onView(item)}
            />
          ))}
        </nav>
      </div>
      <div
        role="tabpanel"
        id={`configuration-view-${view}`}
        aria-labelledby={`configuration-${view}`}
      >
        {view === 'YAML' ? (
          <label className="field">
            <span className="tm-visually-hidden">Preview YAML</span>
            <textarea
              className="tm-preview-yaml"
              aria-label="Preview YAML"
              value={draft.text}
              spellCheck={false}
              disabled={busy}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                  event.preventDefault();
                  onSave();
                }
                if (event.key === 'Tab' && !event.shiftKey) {
                  event.preventDefault();
                  const input = event.currentTarget;
                  const start = input.selectionStart;
                  onChange(
                    draft.text.slice(0, start) +
                      '  ' +
                      draft.text.slice(input.selectionEnd)
                  );
                  requestAnimationFrame(() => {
                    input.selectionStart = input.selectionEnd = start + 2;
                  });
                }
              }}
            />
          </label>
        ) : view === 'Changes' ? (
          <div className="tm-preview-diff" aria-label="Configuration changes">
            {original === draft.text ? (
              <p>No changes.</p>
            ) : (
              <pre>
                {before
                  .slice(0, first)
                  .slice(-3)
                  .map((line, i) => (
                    <div key={`context-${i}`}> {line}</div>
                  ))}
                {before.slice(first, before.length - last).map((line, i) => (
                  <div className="tm-preview-diff__removed" key={`before-${i}`}>
                    − {line}
                  </div>
                ))}
                {after.slice(first, after.length - last).map((line, i) => (
                  <div className="tm-preview-diff__added" key={`after-${i}`}>
                    + {line}
                  </div>
                ))}
                {after
                  .slice(after.length - last)
                  .slice(0, 3)
                  .map((line, i) => (
                    <div key={`after-context-${i}`}> {line}</div>
                  ))}
              </pre>
            )}
          </div>
        ) : (
          <>
            {!config ? (
              <p role="status">
                The file needs correction. Open YAML to edit it.
              </p>
            ) : (
              services.map(([id, node, prefix]) => (
                <section
                  key={id}
                  className="tm-preview-configuration__service"
                  aria-label={`Configuration for ${id}`}
                >
                  <h3 className="tm-panel__title">
                    {id} <span>{serviceTypeLabel(String(node.type))}</span>
                  </h3>
                  {Object.entries(node)
                    .filter(([key]) => !['type', 'name', 'env'].includes(key))
                    .map(([key, value]) => (
                      <div className="tm-preview-detail-row" key={key}>
                        <strong>{fieldLabels[key] ?? key}</strong>
                        <code>
                          {Array.isArray(value)
                            ? value.join(' ')
                            : typeof value === 'object'
                              ? JSON.stringify(value)
                              : String(value)}
                        </code>
                        <button
                          className="ghost-button"
                          disabled={busy}
                          onClick={() =>
                            setEdit({
                              path: [...prefix, key],
                              label: `${id} · ${key}`,
                              value:
                                typeof value === 'string'
                                  ? value
                                  : JSON.stringify(value),
                              json: typeof value !== 'string'
                            })
                          }
                        >
                          Edit
                          <span className="tm-visually-hidden">
                            {' '}
                            {id} {key}
                          </span>
                        </button>
                      </div>
                    ))}
                  {['attach', 'external-postgres', 'external-redis'].includes(
                    String(node.type)
                  ) && !node.url ? (
                    <div className="tm-preview-detail-row">
                      <strong>Connection</strong>
                      <span>Address required</span>
                      <button
                        className="outline-button"
                        onClick={() =>
                          setEdit({
                            path: [...prefix, 'url'],
                            label: `${id} · address or secret reference`,
                            value:
                              node.type === 'attach'
                                ? 'http://localhost:8001'
                                : '{"secret":"project/dev/database"}',
                            json: node.type !== 'attach'
                          })
                        }
                      >
                        Connect address
                      </button>
                    </div>
                  ) : null}
                  {'env' in node ||
                  ['command', 'job', 'worker'].includes(String(node.type)) ? (
                    <div className="tm-preview-detail-row">
                      <strong>Environment</strong>
                      <span>
                        {Object.keys((node.env as object) ?? {}).join(', ') ||
                          'No bindings'}
                      </span>
                      <button
                        className="ghost-button"
                        disabled={busy}
                        onClick={() =>
                          setEdit({
                            path: [...prefix, 'env'],
                            label: `${id} · environment bindings`,
                            value: JSON.stringify(node.env ?? {}, null, 2),
                            json: true
                          })
                        }
                      >
                        Edit
                        <span className="tm-visually-hidden">
                          {' '}
                          {id} environment
                        </span>
                      </button>
                    </div>
                  ) : null}
                </section>
              ))
            )}
          </>
        )}
      </div>
      {edit ? (
        <form
          className="tm-preview-inline-editor"
          onSubmit={(event) => {
            event.preventDefault();
            changeField();
          }}
        >
          <label className="field">
            <span>{edit.label}</span>
            <textarea
              autoFocus
              aria-label={edit.label}
              spellCheck={false}
              rows={4}
              value={edit.value}
              onChange={(event) =>
                setEdit({ ...edit, value: event.target.value })
              }
            />
          </label>
          <p>
            Use secret references for private values. Apply updates this draft;
            Save writes the file.
          </p>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className="ghost-button"
            onClick={() => setEdit(undefined)}
          >
            Cancel edit
          </button>
          <button className="outline-button">Apply to draft</button>
        </form>
      ) : null}
      {report ? (
        <details className="tm-preview-disclosure">
          <summary>
            <DisclosureChevron />
            What the agent found
          </summary>
          <ul>
            {report.evidence.map((item, i) => (
              <li key={i}>{`${item.path}: ${item.finding}`}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
