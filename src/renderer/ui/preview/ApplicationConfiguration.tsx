import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import type { PreviewConfigurationFile } from '../../../shared/applicationPreview';
import {
  configurationDiff,
  configurationOverview,
  editableFields,
  environmentValue,
  folderLabel,
  formatCommand,
  needsAddress,
  parseCommand,
  readConfiguration,
  removeEnvironmentBinding,
  renameEnvironmentBinding,
  setEntryField,
  setEnvironmentBinding,
  waitsForManagedData,
  type ConfigurationEntry,
  type ConfigurationOverview,
  type EnvironmentBinding,
  type EnvironmentKind
} from '../../model/previewConfigurationModel';
import { ActionMenu } from '../ActionMenu';
import { DiffLines } from '../DiffLines';
import { DisclosureChevron } from '../DisclosureChevron';
import { commandText, GroupLabel, serviceTypeLabel, shortenPath } from './previewPresentation';

export interface PreviewEditorDraft {
  original?: PreviewConfigurationFile;
  text: string;
  draftId?: string;
}
export type ConfigurationView = 'Configuration' | 'YAML' | 'Changes';

/** The configuration file: grouped entries edited in place, the text, and the changes against what runs. Save lives in the status row. */
export function ApplicationConfiguration({ draft, previous, view, onView, onChange, onSave, busy }: {
  draft: PreviewEditorDraft;
  previous?: PreviewConfigurationFile;
  view: ConfigurationView;
  onView(view: ConfigurationView): void;
  onChange(text: string): void;
  onSave(): void;
  busy: boolean;
}) {
  const entries = useMemo(() => readConfiguration(draft.text), [draft.text]);
  const overview = useMemo(() => (entries ? configurationOverview(entries) : undefined), [entries]);
  // An external service without an address cannot start, so its editor opens first.
  const [expanded, setExpanded] = useState(() => entries?.find(needsAddress)?.id);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const original =
    draft.draftId || draft.text !== draft.original?.text
      ? (draft.original?.text ?? '')
      : (previous?.text ?? draft.original?.text ?? '');
  const changed = original !== draft.text;
  const changes = useMemo(() => (view === 'Changes' && changed ? configurationDiff(original, draft.text) : []), [view, changed, original, draft.text]);
  const state = draft.draftId
    ? draft.original ? 'proposed' : 'proposed · new file'
    : draft.text !== draft.original?.text ? (draft.original ? 'unsaved' : 'new file') : undefined;
  const toggle = (next: ConfigurationView) => onView(view === next ? 'Configuration' : next);
  const collapse = (id: string) => {
    setExpanded(undefined);
    rows.current.get(id)?.focus();
  };
  return (
    <div className="tm-preview-configuration">
      <div className="tm-preview-configuration__toolbar">
        <span className="tm-preview-configuration__file">
          <strong>{draft.original?.name ?? 'preview.yaml'}</strong>
          {state ? ` · ${state}` : ''}
        </span>
        <div className="tm-preview-configuration__views">
          {changed || view === 'Changes' ? (
            <button type="button" className="ghost-button" aria-pressed={view === 'Changes'} onClick={() => toggle('Changes')}>
              Changes
            </button>
          ) : null}
          <button type="button" className="ghost-button" aria-pressed={view === 'YAML'} onClick={() => toggle('YAML')}>
            YAML
          </button>
        </div>
      </div>
      {view === 'YAML' ? (
        <label className="field tm-preview-configuration__source">
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
                onChange(draft.text.slice(0, start) + '  ' + draft.text.slice(input.selectionEnd));
                requestAnimationFrame(() => {
                  input.selectionStart = input.selectionEnd = start + 2;
                });
              }
            }}
          />
        </label>
      ) : view === 'Changes' ? (
        <div className="tm-preview-diff" aria-label="Configuration changes">
          {changed ? <DiffLines lines={changes} /> : <p>No changes.</p>}
        </div>
      ) : !entries || !overview ? (
        <p className="tm-preview-help" role="status">
          The file needs correction.{' '}
          <button type="button" className="tm-preview-configuration__link" onClick={() => onView('YAML')}>Open YAML</button>
        </p>
      ) : (
        <ConfigurationGroups
          overview={overview}
          entry={(entry) => !hasEditor(entry) ? <EntryRow entry={entry} /> : (
            <EntryRow
              entry={entry}
              expanded={expanded === entry.id}
              buttonRef={(element) => {
                if (element) rows.current.set(entry.id, element);
                else rows.current.delete(entry.id);
              }}
              onToggle={() => setExpanded(expanded === entry.id ? undefined : entry.id)}
            >
              {expanded === entry.id ? (
                <EntryEditor
                  entry={entry}
                  entries={entries}
                  text={draft.text}
                  busy={busy}
                  onChange={onChange}
                  onYaml={() => onView('YAML')}
                  onDone={() => collapse(entry.id)}
                />
              ) : null}
            </EntryRow>
          )}
        />
      )}
    </div>
  );
}

const hasEditor = (entry: ConfigurationEntry) => entry.other.length > 0 || Object.values(editableFields(entry)).some(Boolean);

/** Services, databases, setup steps, then where they run and which secrets they read. Empty groups are left out. */
export function ConfigurationGroups({ overview, projectDirectory, entry, folderEnd }: {
  overview: ConfigurationOverview;
  projectDirectory?: string;
  entry(entry: ConfigurationEntry): ReactNode;
  folderEnd?(path: string): ReactNode;
}) {
  const group = (name: string, children: ReactNode[]) =>
    children.length ? (
      <section className="tm-preview-configuration__group" aria-label={name}>
        <GroupLabel>{name}</GroupLabel>
        <div className="tm-preview-entries">{children}</div>
      </section>
    ) : null;
  return (
    <div className="tm-preview-configuration__groups">
      {group('Services', overview.services.map((item) => <EntryBlock key={item.id}>{entry(item)}</EntryBlock>))}
      {group('Databases', overview.databases.map((item) => <EntryBlock key={item.id}>{entry(item)}</EntryBlock>))}
      {group('Setup steps', overview.steps.map((item) => <EntryBlock key={item.id}>{entry(item)}</EntryBlock>))}
      {group(
        'Folders',
        overview.folders.map((folder) => {
          const named = folderLabel(folder.path, projectDirectory);
          const shown = shortenPath(folder.path);
          return (
            <EntryBlock key={folder.path}>
              <div className="tm-preview-entry">
                <span className="tm-preview-entry__head">
                  {named.root ? <span className="tm-preview-entry__name">Task worktree</span> : <code className="tm-preview-entry__name">{named.name}</code>}
                  {!named.root && shown !== named.name ? <code className="tm-preview-entry__path" title={folder.path}>{shown}</code> : null}
                </span>
                <span className="tm-preview-entry__summary" title={folder.entries.join(', ')}>{folder.entries.join(', ')}</span>
                {folderEnd ? <span className="tm-preview-entry__end">{folderEnd(folder.path)}</span> : null}
              </div>
            </EntryBlock>
          );
        })
      )}
      {group(
        'Secrets',
        overview.secrets.map((secret) => {
          const uses = secret.uses.map((use) => `${use.entry} · ${use.key}`).join(', ');
          return (
            <EntryBlock key={secret.id}>
              <div className="tm-preview-entry">
                <span className="tm-preview-entry__head">
                  <code className="tm-preview-entry__name" title={secret.id}>{secret.id}</code>
                </span>
                <span className="tm-preview-entry__summary" title={uses}>{uses}</span>
              </div>
            </EntryBlock>
          );
        })
      )}
    </div>
  );
}

function EntryBlock({ children }: { children: ReactNode }) {
  return <div className="tm-preview-entry-block">{children}</div>;
}

function entrySummary(entry: ConfigurationEntry): ReactNode {
  const node = entry.node;
  const value = (scalar: unknown) =>
    typeof scalar === 'string' ? scalar : scalar && typeof scalar === 'object' ? Object.entries(scalar).map(([key, item]) => `${key} ${String(item)}`).join(' · ') : undefined;
  if (entry.command?.length) return <code>{commandText(entry.command)}</code>;
  if (entry.type === 'postgres' || entry.type === 'redis') return 'Managed by Preview · data kept after Stop';
  const text =
    entry.type === 'static' ? entry.folder
      : entry.type === 'external-tcp' ? `${String(node.host ?? '127.0.0.1')}:${String(node.port ?? '')}`
      : entry.type === 'preview' ? [node.name, node.service].filter(Boolean).map(String).join(' · ')
      : entry.type === 'compose' ? (typeof node.image === 'string' ? node.image : Array.isArray(node.files) ? node.files.join(', ') : undefined)
      : value(node.url);
  return text ? <code>{text}</code> : node.url === undefined && ['attach', 'external-postgres', 'external-redis'].includes(entry.type) ? 'Address required' : null;
}

function entryMeta(entry: ConfigurationEntry, projectDirectory?: string): string {
  const folder = entry.folder !== undefined && entry.type !== 'static' ? folderLabel(entry.folder, projectDirectory) : undefined;
  return [
    folder && !folder.root ? folder.name : undefined,
    entry.dependsOn.length ? `after ${entry.dependsOn.join(', ')}` : undefined,
    entry.run ? (entry.run === 'once' ? 'once' : 'every start') : undefined
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Name and type, then what it runs; the whole row toggles its editor when it has one. */
export function EntryRow({ entry, projectDirectory, end, expanded, onToggle, buttonRef, children }: {
  entry: ConfigurationEntry;
  projectDirectory?: string;
  end?: ReactNode;
  expanded?: boolean;
  onToggle?(): void;
  buttonRef?(element: HTMLButtonElement | null): void;
  children?: ReactNode;
}) {
  const editor = useId();
  const meta = entryMeta(entry, projectDirectory);
  const contents = (
    <>
      <span className="tm-preview-entry__head">
        <span className="tm-preview-entry__name">{entry.id}</span>
        <span className="tm-preview-entry__type">{serviceTypeLabel(entry.type)}</span>
      </span>
      <span className="tm-preview-entry__summary">{entrySummary(entry)}</span>
      <span className="tm-preview-entry__meta" title={meta || undefined}>{meta}</span>
      {end ? <span className="tm-preview-entry__end">{end}</span> : null}
      {onToggle ? <DisclosureChevron className="tm-preview-entry__chevron" /> : null}
    </>
  );
  return (
    <>
      {onToggle ? (
        <button
          ref={buttonRef}
          type="button"
          className="tm-preview-entry tm-preview-entry--toggle"
          aria-expanded={!!expanded}
          aria-controls={expanded ? editor : undefined}
          onClick={onToggle}
        >
          {contents}
        </button>
      ) : (
        <div className="tm-preview-entry">{contents}</div>
      )}
      {children ? <div id={editor}>{children}</div> : null}
    </>
  );
}

/** Typed fields for one entry, written straight into the draft text. */
function EntryEditor({ entry, entries, text, busy, onChange, onYaml, onDone }: {
  entry: ConfigurationEntry;
  entries: ConfigurationEntry[];
  text: string;
  busy: boolean;
  onChange(text: string): void;
  onYaml(): void;
  onDone(): void;
}) {
  const id = useId();
  const fields = editableFields(entry);
  const [error, setError] = useState<string>();
  const write = (change: () => string) => {
    try {
      onChange(change());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change could not be written.');
    }
  };
  const field = (field: string, value: unknown) => write(() => setEntryField(text, entry.path, field, value));
  const others = entries.filter((item) => item.id !== entry.id && item.path.length > 0);
  const once = waitsForManagedData(entry, entries);
  const onKeyDown = (event: KeyboardEvent) => {
    // An open menu or select consumes its own Escape first.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onDone();
  };
  return (
    <div className="tm-preview-entry-editor" role="group" aria-label={`Edit ${entry.id}`} onKeyDown={onKeyDown}>
      {fields.command ? (
        <EditorField label="Command" htmlFor={`${id}-command`}>
          <CommandField id={`${id}-command`} command={entry.command ?? []} busy={busy} onCommit={(command) => field('command', command)} />
        </EditorField>
      ) : null}
      {fields.folder ? (
        <EditorField label="Folder" htmlFor={`${id}-folder`}>
          <span className="field">
            <input
              id={`${id}-folder`}
              className="tm-preview-entry-editor__mono"
              spellCheck={false}
              disabled={busy}
              value={entry.folder ?? ''}
              placeholder="."
              onChange={(event) => field(fields.folder!, event.target.value)}
            />
          </span>
        </EditorField>
      ) : null}
      {fields.dependsOn ? (
        <EditorField label="Starts after" labelId={`${id}-depends`}>
          <ActionMenu
            className="tm-action-menu tm-preview-entry-editor__menu"
            align="start"
            closeOnSelect={false}
            disabled={busy || !others.length}
            label={`Starts after: ${entry.dependsOn.join(', ') || 'nothing'}`}
            trigger={
              <>
                <span className={entry.dependsOn.length ? undefined : 'tm-preview-entry-editor__none'}>{entry.dependsOn.join(', ') || 'Nothing'}</span>
                <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
              </>
            }
            items={others.map((other) => ({
              id: other.id,
              label: other.id,
              meta: serviceTypeLabel(other.type),
              pressed: entry.dependsOn.includes(other.id),
              onSelect: () => {
                const next = entry.dependsOn.includes(other.id) ? entry.dependsOn.filter((item) => item !== other.id) : [...entry.dependsOn, other.id];
                field('dependsOn', next.length ? next : undefined);
              }
            }))}
          />
        </EditorField>
      ) : null}
      {fields.run ? (
        <EditorField label="Repeat" labelId={`${id}-run`}>
          <div
            className="segmented"
            role="group"
            aria-labelledby={`${id}-run`}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
              buttons[next]?.click();
            }}
          >
            {(['always', 'once'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="segmented__btn"
                aria-pressed={entry.run === value}
                aria-describedby={value === 'once' && !once ? `${id}-once` : undefined}
                disabled={busy || (value === 'once' && !once && entry.run !== 'once')}
                onClick={() => {
                  if (entry.run !== value) field('run', value);
                }}
              >
                {value === 'always' ? 'Every start' : 'Once'}
              </button>
            ))}
          </div>
          {!once ? <small id={`${id}-once`} className="tm-preview-entry-editor__help">Once needs this step to start after a managed database.</small> : null}
        </EditorField>
      ) : null}
      {fields.address ? (
        <EditorField label="Address" htmlFor={`${id}-address`}>
          <AddressField
            id={`${id}-address`}
            address={entry.address}
            secrets={fields.address === 'reference'}
            placeholder={fields.address === 'url' ? 'http://127.0.0.1:8000' : 'postgres://…'}
            busy={busy}
            onValue={(kind, value) => field('url', value ? environmentValue(kind, value) : undefined)}
          />
        </EditorField>
      ) : null}
      {fields.readyPath ? (
        <EditorField label="Readiness path" htmlFor={`${id}-ready`}>
          <span className="field">
            <input
              id={`${id}-ready`}
              className="tm-preview-entry-editor__mono"
              spellCheck={false}
              disabled={busy}
              value={entry.readyPath ?? ''}
              placeholder="/"
              onChange={(event) => field('readyPath', event.target.value || undefined)}
            />
          </span>
        </EditorField>
      ) : null}
      {fields.environment ? (
        <EditorField label="Environment" labelId={`${id}-env`}>
          <EnvironmentTable
            labelId={`${id}-env`}
            entry={entry}
            // Only entries that listen have an address; steps and workers do not.
            entries={others.filter((item) => item.type !== 'job' && item.type !== 'worker')}
            text={text}
            busy={busy}
            write={write}
          />
        </EditorField>
      ) : null}
      {entry.other.length ? (
        <EditorField label="Also set" labelId={`${id}-other`}>
          <div className="tm-preview-entry-editor__other" aria-labelledby={`${id}-other`}>
            <dl>
              {entry.other.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd><code>{typeof value === 'string' ? value : JSON.stringify(value)}</code></dd>
                </div>
              ))}
            </dl>
            <button type="button" className="ghost-button" onClick={onYaml}>Edit in YAML</button>
          </div>
        </EditorField>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="tm-preview-entry-editor__actions">
        <button type="button" className="outline-button" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function EditorField({ label, htmlFor, labelId, children }: { label: string; htmlFor?: string; labelId?: string; children: ReactNode }) {
  return (
    <div className="tm-preview-entry-editor__field">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span id={labelId}>{label}</span>}
      <div className="tm-preview-entry-editor__control">{children}</div>
    </div>
  );
}

/** Where an external service listens. A database address can stay in secret storage as a reference. */
function AddressField({ id, address, secrets, placeholder, busy, onValue }: {
  id: string;
  address?: EnvironmentBinding;
  secrets: boolean;
  placeholder: string;
  busy: boolean;
  onValue(kind: 'text' | 'secret', value: string): void;
}) {
  // A database address usually carries credentials, so an empty one starts as a secret reference.
  const [chosen, setChosen] = useState<'text' | 'secret'>(address?.kind === 'text' || !secrets ? 'text' : 'secret');
  const kind = address?.kind === 'secret' || address?.kind === 'text' ? address.kind : chosen;
  if (address?.kind === 'other') return <code className="tm-preview-env__other" title={address.value}>{address.value}</code>;
  const input = (
    <span className="field">
      <input
        id={id}
        className="tm-preview-entry-editor__mono"
        spellCheck={false}
        disabled={busy}
        value={address?.value ?? ''}
        placeholder={kind === 'secret' ? 'project/dev/database-url' : placeholder}
        onChange={(event) => onValue(kind, event.target.value)}
      />
    </span>
  );
  if (!secrets) return input;
  return (
    <div className="tm-preview-entry-editor__address">
      <span className="field">
        <select
          aria-label="Address kind"
          disabled={busy}
          value={kind}
          onChange={(event) => {
            const next = event.target.value as 'text' | 'secret';
            setChosen(next);
            if (address?.value) onValue(next, address.value);
          }}
        >
          <option value="secret">{KIND_LABELS.secret}</option>
          <option value="text">{KIND_LABELS.text}</option>
        </select>
      </span>
      {input}
    </div>
  );
}

/**
 * A command is parsed into arguments, so it is written when the person leaves the field or
 * presses Enter: a half-typed quote would otherwise turn into a broken argument list mid-word.
 */
function CommandField({ id, command, busy, onCommit }: { id: string; command: string[]; busy: boolean; onCommit(command: string[]): void }) {
  const formatted = formatCommand(command);
  const [value, setValue] = useState(formatted);
  const [source, setSource] = useState(formatted);
  const [error, setError] = useState<string>();
  if (source !== formatted) {
    setSource(formatted);
    setValue(formatted);
    setError(undefined);
  }
  const commit = () => {
    const parsed = parseCommand(value);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(undefined);
    if (formatCommand(parsed.command) !== formatted) onCommit(parsed.command);
  };
  return (
    <span className="field">
      <input
        id={id}
        className="tm-preview-entry-editor__mono"
        spellCheck={false}
        disabled={busy}
        value={value}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError(undefined);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape' && value !== formatted) {
            event.preventDefault();
            setValue(formatted);
            setError(undefined);
          }
        }}
      />
      {error ? <small id={`${id}-error`} className="form-error" role="alert">{error}</small> : null}
    </span>
  );
}

const KIND_LABELS: Record<EnvironmentKind, string> = { text: 'Text', secret: 'Secret', service: 'Service address', other: 'Other' };

interface PendingBinding {
  kind: Exclude<EnvironmentKind, 'other'>;
  value: string;
}

/** Key, kind and value per variable; secret values never enter the file, only their reference. */
function EnvironmentTable({ labelId, entry, entries, text, busy, write }: {
  labelId: string;
  entry: ConfigurationEntry;
  entries: ConfigurationEntry[];
  text: string;
  busy: boolean;
  write(change: () => string): void;
}) {
  const [pending, setPending] = useState<PendingBinding>();
  const keys = entry.environment.map((binding) => binding.key);
  const set = (key: string, kind: Exclude<EnvironmentKind, 'other'>, value: string) =>
    write(() => setEnvironmentBinding(text, entry.path, key, environmentValue(kind, value)));
  const valueFor = (kind: Exclude<EnvironmentKind, 'other'>) => (kind === 'service' ? (entries[0]?.id ?? '') : '');
  // The new variable is the last row of the same list, so writing it keeps focus where the person is.
  const rows: Array<{ binding: EnvironmentBinding; added: boolean }> = [
    ...entry.environment.map((binding) => ({ binding, added: false })),
    ...(pending ? [{ binding: { key: '', kind: pending.kind, value: pending.value }, added: true }] : [])
  ];
  return (
    <div className="tm-preview-env" role="table" aria-labelledby={labelId}>
      {rows.map(({ binding, added }, index) => {
        const name = added ? 'New variable' : binding.key;
        return (
          // Rows are keyed by position so a rename keeps focus in the field being edited.
          <div className="tm-preview-env__row" role="row" key={index}>
            <span role="cell">
              <KeyField
                value={binding.key}
                label={`${name} name`}
                autoFocus={added}
                busy={busy}
                taken={keys.filter((key) => key !== binding.key)}
                onCommit={(key) => {
                  if (!added) return write(() => renameEnvironmentBinding(text, entry.path, binding.key, key));
                  set(key, pending!.kind, pending!.value);
                  setPending(undefined);
                }}
              />
            </span>
            <span role="cell" className="field">
              <select
                aria-label={`${name} kind`}
                disabled={busy}
                value={binding.kind}
                onChange={(event) => {
                  const kind = event.target.value as Exclude<EnvironmentKind, 'other'>;
                  if (added) setPending({ kind, value: valueFor(kind) });
                  else set(binding.key, kind, valueFor(kind));
                }}
              >
                {(['text', 'secret', 'service'] as const).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
                {binding.kind === 'other' ? <option value="other" disabled>{KIND_LABELS.other}</option> : null}
              </select>
            </span>
            <span role="cell">
              <BindingValue
                name={name}
                binding={binding}
                entries={entries}
                busy={busy}
                onValue={(value) => {
                  if (added) setPending({ kind: pending!.kind, value });
                  else if (binding.kind !== 'other') set(binding.key, binding.kind, value);
                }}
              />
            </span>
            <span role="cell">
              <button
                type="button"
                className="tm-preview-icon-button"
                aria-label={`Remove ${name}`}
                title="Remove"
                disabled={busy}
                onClick={() => (added ? setPending(undefined) : write(() => removeEnvironmentBinding(text, entry.path, binding.key)))}
              >
                <X size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </span>
          </div>
        );
      })}
      <div className="tm-preview-env__add">
        <button type="button" className="ghost-button" disabled={busy || !!pending} onClick={() => setPending({ kind: 'text', value: '' })}>
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
          Add variable
        </button>
      </div>
    </div>
  );
}

/** A variable name is the map key, so it is written on Enter or when leaving the field, never half-typed. */
function KeyField({ value, label, taken, busy, autoFocus, onCommit }: { value: string; label: string; taken: string[]; busy: boolean; autoFocus?: boolean; onCommit(key: string): void }) {
  const id = useId();
  const [key, setKey] = useState(value);
  const [source, setSource] = useState(value);
  const [error, setError] = useState<string>();
  if (source !== value) {
    setSource(value);
    setKey(value);
    setError(undefined);
  }
  const commit = (explicit: boolean) => {
    const next = key.trim();
    if (!next) {
      if (explicit || value) setError('Enter a name.');
      return;
    }
    if (next === value) return;
    if (taken.includes(next)) {
      setError(`${next} is already set.`);
      return;
    }
    setError(undefined);
    onCommit(next);
  };
  return (
    <span className="field">
      <input
        className="tm-preview-entry-editor__mono"
        aria-label={label}
        placeholder="NAME"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={busy}
        value={key}
        aria-invalid={!!error}
        aria-describedby={error ? id : undefined}
        onChange={(event) => {
          setKey(event.target.value);
          if (error) setError(undefined);
        }}
        onBlur={() => commit(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(true);
          }
        }}
      />
      {error ? <small id={id} className="form-error" role="alert">{error}</small> : null}
    </span>
  );
}

function BindingValue({ name, binding, entries, busy, onValue }: { name: string; binding: EnvironmentBinding; entries: ConfigurationEntry[]; busy: boolean; onValue(value: string): void }) {
  if (binding.kind === 'other')
    return <code className="tm-preview-env__other" title={binding.value}>{binding.value}</code>;
  if (binding.kind === 'service') {
    const options = entries.some((entry) => entry.id === binding.value) || !binding.value ? entries.map((entry) => entry.id) : [binding.value, ...entries.map((entry) => entry.id)];
    return (
      <span className="field">
        <select aria-label={`${name} service`} disabled={busy} value={binding.value} onChange={(event) => onValue(event.target.value)}>
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </span>
    );
  }
  return (
    <span className="field">
      <input
        className="tm-preview-entry-editor__mono"
        aria-label={binding.kind === 'secret' ? `${name} secret reference` : `${name} value`}
        placeholder={binding.kind === 'secret' ? 'project/dev/name' : undefined}
        spellCheck={false}
        disabled={busy}
        value={binding.value}
        onChange={(event) => onValue(event.target.value)}
      />
    </span>
  );
}
