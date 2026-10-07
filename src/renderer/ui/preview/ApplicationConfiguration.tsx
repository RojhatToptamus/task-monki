import { Ellipsis } from 'lucide-react';
import { ActionMenu } from '../ActionMenu';
import { useEffect, useRef, useState } from 'react';
import type {
  AttemptSummary,
  ConfigurationBindingChange,
  ConfigurationBindingsInspection,
  PreviewStatus
} from 'previewhost';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { ApplicationDependencies } from './ApplicationDependencies';
import { DisclosureChevron } from '../DisclosureChevron';
import {
  message,
  expected,
  PreviewDialog,
  ConfigurationDefinitions
} from './previewPresentation';

export function ApplicationConfiguration({
  taskId,
  status,
  designAttempts,
  onChanged,
  onOpenSecrets,
  onModalOpenChange
}: {
  taskId: string;
  status?: PreviewStatus;
  designAttempts?: string[];
  onChanged(): void;
  onOpenSecrets?(references: string[]): void;
  onModalOpenChange?(open: boolean): void;
}) {
  const [sourceEdit, setSourceEdit] = useState<{
    service?: string;
    directory: string;
    attemptId: string;
    expected: ReturnType<typeof expected>;
  }>();
  const [selectedService, setSelectedService] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const attemptId = selected ?? status?.latest?.id ?? status?.active?.id;
  const editable =
    !!attemptId &&
    !designAttempts?.includes(attemptId) &&
    (attemptId === status?.active?.id || attemptId === status?.latest?.id);
  const [pendingSelection, setPendingSelection] = useState<string>();
  const [applying, setApplying] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [inspection, setInspection] =
    useState<ConfigurationBindingsInspection>();
  const [changes, setChanges] = useState<ConfigurationBindingChange[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    key: string;
    service?: string;
    type: string;
    reference: string;
    existing?: boolean;
    concealed?: boolean;
    port?: string;
  }>();
  const valueRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!applying) return;
    if (status?.active?.id === applying) {
      setChanges([]);
      setSelected(applying);
      setApplying(undefined);
    } else if (
      status?.latest?.id === applying &&
      ['failed', 'canceled'].includes(status.latest.state)
    ) {
      setError(
        status.latest.error?.message ??
          'The update was canceled. Your draft is retained.'
      );
      setApplying(undefined);
    }
  }, [applying, status?.active?.id, status?.latest]);
  useEffect(() => {
    let disposed = false;
    setInspection(undefined);
    setChanges([]);
    setError(undefined);
    if (attemptId)
      void api
        .inspectApplicationPreviewConfiguration({
          taskId,
          attemptId,
          changes: []
        })
        .then(
          (value) => {
            if (!disposed) setInspection(value);
          },
          (cause) => {
            if (!disposed) setError(message(cause));
          }
        );
    return () => {
      disposed = true;
    };
  }, [taskId, attemptId]);
  async function inspect(next: ConfigurationBindingChange[]) {
    if (!attemptId) return;
    setSelected(attemptId);
    next = [
      ...new Map(
        next.map((change) => [`${change.service ?? ''}/${change.key}`, change])
      ).values()
    ];
    setBusy(true);
    setError(undefined);
    try {
      setInspection(
        await api.inspectApplicationPreviewConfiguration({
          taskId,
          attemptId,
          changes: next
        })
      );
      setChanges(next);
      setSaved(undefined);
      setEditing(undefined);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      if (valueRef.current) valueRef.current.value = '';
    }
  }
  const services: Array<string | undefined> =
    inspection?.description.spec.type === 'environment'
      ? Object.entries(inspection.description.spec.services)
          .filter(
            ([, value]) =>
              value.type === 'command' ||
              value.type === 'worker' ||
              value.type === 'job'
          )
          .map(([id]) => id)
      : inspection?.description.spec.type === 'command'
        ? [undefined]
        : [];
  const selectable = [
    status?.latest,
    status?.active,
    ...(status?.history ?? [])
  ].filter(
    (value, index, all): value is AttemptSummary =>
      !!value && all.findIndex((item) => item?.id === value.id) === index
  );
  const service = services.includes(selectedService)
    ? selectedService
    : services[0];
  const sourceServices =
    inspection?.description.spec.type === 'environment'
      ? Object.entries(inspection.description.spec.services)
          .filter(([, value]) => 'cwd' in value || value.type === 'static')
          .map(([id]) => id)
      : inspection &&
          ('cwd' in inspection.description.spec ||
            inspection.description.spec.type === 'static')
        ? [undefined]
        : [];
  const currentSource = inspection?.description.spec.type === 'environment'
    ? sourceEdit?.service ? inspection.description.spec.services[sourceEdit.service] : undefined
    : inspection?.description.spec;
  const currentFolder = currentSource && ('cwd' in currentSource ? currentSource.cwd : 'directory' in currentSource ? currentSource.directory : undefined);
  return (
    <div className="tm-application-preview__configuration">
      {attemptId ? (
        <label className="field tm-application-preview__selector">
          <span className="tm-visually-hidden">Configuration attempt</span>
          <select
            disabled={busy || !!editing || !!applying}
            value={attemptId}
            onChange={(event) => {
              if (changes.length) setPendingSelection(event.target.value);
              else setSelected(event.target.value);
            }}
          >
            {!selectable.some((value) => value.id === attemptId) ? (
              <option value={attemptId}>Draft configuration</option>
            ) : null}
            {selectable.map((value) => (
              <option key={value.id} value={value.id}>
                {value.id === status?.active?.id
                  ? 'Serving configuration'
                  : value.id === status?.latest?.id
                    ? 'Latest configuration'
                    : `Earlier · ${value.id.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error && !inspection && !editing && !sourceEdit ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {inspection ? (
        <>
          <section
            className="tm-application-preview__configuration-section"
            aria-label="Environment variables"
          >
            <div className="tm-application-preview__toolbar">
              <h3 className="tm-panel__title">Environment variables</h3>
              {editable && services?.length ? (
                <button
                  className="outline-button"
                  disabled={busy}
                  onClick={() =>
                    setEditing({
                      key: '',
                      service,
                      type: 'secret',
                      reference: '',
                      port: undefined
                    })
                  }
                >
                  Add variable
                </button>
              ) : null}
            </div>
            {services[0] !== undefined ? (
              <label className="field tm-application-preview__service-selector">
                <span>Service or job</span>
                <select
                  value={service}
                  disabled={busy}
                  onChange={(event) => setSelectedService(event.target.value)}
                >
                  {services.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!editable ? (
              <p className="tm-application-preview__notice">
                {attemptId && designAttempts?.includes(attemptId)
                  ? 'Saved Design source · Stop, then load preview.yaml to edit workspace configuration.'
                  : 'Earlier configuration · Read only'}
              </p>
            ) : null}
            <div className="tm-application-preview__table-wrap">
              <table className="tm-application-preview__table tm-application-preview__variables">
                <thead>
                  <tr>
                    <th scope="col">Variable</th>
                    <th scope="col">Type</th>
                    <th scope="col">Reference</th>
                    <th scope="col">
                      <span className="tm-visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inspection.bindings
                    .filter((row) => row.service === service)
                    .map((row) => (
                      <tr key={`${row.service}/${row.key}`}>
                        <th scope="row">
                          <code title={row.key}>{row.key}</code>
                        </th>
                        <td>
                          {row.value
                            ? bindingTypeLabel(bindingEditor(row.value).type)
                            : 'Value'}
                        </td>
                        <td
                          className="tm-application-preview__endpoint"
                          title={
                            row.value
                              ? bindingEditor(row.value).reference
                              : undefined
                          }
                        >
                          {row.value
                            ? bindingEditor(row.value).reference +
                              (bindingEditor(row.value).port
                                ? ` · ${bindingEditor(row.value).port}`
                                : '')
                            : 'Value not shown'}
                        </td>
                        <td>
                          <div className="tm-application-preview__toolbar">
                            {editable ? (
                              <button
                                className="ghost-button"
                                disabled={busy}
                                onClick={() =>
                                  setEditing({
                                    key: row.key,
                                    service: row.service,
                                    ...bindingEditor(row.value),
                                    existing: true,
                                    concealed: row.value === null
                                  })
                                }
                              >
                                Edit
                              </button>
                            ) : null}
                            {editable ||
                            (row.value &&
                              'secret' in row.value &&
                              onOpenSecrets) ? (
                              <ActionMenu
                                label={`Actions for ${row.key}`}
                                trigger={
                                  <Ellipsis
                                    size={16}
                                    strokeWidth={1.5}
                                    aria-hidden="true"
                                  />
                                }
                                disabled={busy}
                                items={[
                                  ...(row.value &&
                                  'secret' in row.value &&
                                  onOpenSecrets
                                    ? [
                                        {
                                          label: 'Manage secret',
                                          onSelect: () => {
                                            if (
                                              row.value &&
                                              'secret' in row.value
                                            )
                                              onOpenSecrets([row.value.secret]);
                                          }
                                        }
                                      ]
                                    : []),
                                  ...(editable
                                    ? [
                                        {
                                          label: 'Remove variable',
                                          onSelect: () =>
                                            void inspect([
                                              ...changes,
                                              {
                                                service: row.service,
                                                key: row.key,
                                                value: null
                                              }
                                            ])
                                        }
                                      ]
                                    : [])
                                ]}
                              />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  {!inspection.bindings.some(
                    (row) => row.service === service
                  ) ? (
                    <tr>
                      <td colSpan={4} className="tm-application-preview__muted">
                        No environment variables.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
          <ApplicationDependencies
            taskId={taskId}
            attemptId={attemptId!}
            inspection={inspection}
            status={status}
            disabled={
              !editable ||
              busy ||
              !!applying ||
              changes.length > 0 ||
              !!status?.candidate
            }
            onChanged={onChanged}
            onModalOpenChange={onModalOpenChange}
          />
          <section
            className="tm-application-preview__configuration-section"
            aria-label="Services and sources"
          >
            <div className="tm-application-preview__toolbar">
              <h3 className="tm-panel__title">Services and sources</h3>
              {editable && sourceServices.length ? (
                <button
                  className="outline-button"
                  disabled={
                    busy ||
                    changes.length > 0 ||
                    !!applying ||
                    !!status?.candidate
                  }
                  title={
                    changes.length
                      ? 'Apply or discard variable edits first.'
                      : undefined
                  }
                  onClick={() => {
                    setError(undefined);
                    setSourceEdit({
                      service: sourceServices[0],
                      directory: '',
                      attemptId: attemptId!,
                      expected: expected(status)
                    });
                  }}
                >
                  Connect folder
                </button>
              ) : null}
            </div>
            {inspection.inspection?.error?.code === 'SOURCE_DENIED' ? (
              <div className="tm-application-preview__feedback">
                <p role="alert" className="form-error">
                  Source access needs approval. Connect the folder to continue.
                </p>
                <details className="tm-application-preview__technical">
                  <summary>
                    <DisclosureChevron />
                    Details
                  </summary>
                  <p>{inspection.inspection.error.message}</p>
                </details>
              </div>
            ) : null}
            <details className="tm-preview-disclosure">
              <summary>
                <DisclosureChevron />
                <span>Service definitions</span>
              </summary>
              <ConfigurationDefinitions description={inspection.description} />
            </details>
          </section>
          {inspection.inspection?.error &&
          inspection.inspection.error.code !== 'SOURCE_DENIED' ? (
            <p role="alert" className="form-error">
              {inspection.inspection.error.message}
            </p>
          ) : null}
          <div className="tm-application-preview__configuration-actions">
            <div className="tm-application-preview__configuration-feedback">
              {error && !editing && !sourceEdit ? (
                <p role="alert" className="form-error">
                  {error}
                </p>
              ) : saved ? (
                <p role="status" className="tm-application-preview__notice">
                  Saved preview.yaml
                </p>
              ) : changes.length ? (
                <p className="tm-application-preview__notice">
                  {changes.length} unsaved{' '}
                  {changes.length === 1 ? 'edit' : 'edits'}
                </p>
              ) : null}
            </div>
            {changes.length ? (
              <button
                className="ghost-button"
                disabled={busy || !!applying}
                onClick={() => void inspect([])}
              >
                Discard edits
              </button>
            ) : null}
            <button
              className="outline-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .saveApplicationPreviewConfiguration({
                    taskId,
                    attemptId: attemptId!,
                    changes
                  })
                  .then(
                    (result) => {
                      setError(undefined);
                      setSaved(result.file);
                    },
                    (cause) => setError(message(cause))
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Save as preview.yaml
            </button>
            <button
              className="primary-button"
              disabled={
                !editable ||
                busy ||
                !!applying ||
                status?.busy ||
                !!status?.candidate ||
                !changes.length
              }
              title={
                !changes.length
                  ? 'Edit a variable to apply a configuration update.'
                  : undefined
              }
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void api
                  .applyApplicationPreviewConfiguration({
                    taskId,
                    attemptId: attemptId!,
                    changes,
                    expected: expected(status)
                  })
                  .then(
                    (result) => {
                      setApplying(
                        result.status?.candidate?.id ??
                          result.status?.latest?.id
                      );
                      onChanged();
                    },
                    (cause) => setError(message(cause))
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Review and apply
            </button>
          </div>
        </>
      ) : null}
      {editing ? (
        <PreviewDialog
          onOpenChange={onModalOpenChange}
          title={editing.key ? 'Edit variable' : 'Add variable'}
          busy={busy}
          onClose={() => setEditing(undefined)}
          onSubmit={(event) => {
            event.preventDefault();
            const value = valueRef.current?.value ?? '';
            if (editing.concealed && editing.type === 'value' && !value) {
              setEditing(undefined);
              return;
            }
            void inspect([
              ...changes,
              {
                key: editing.key,
                service: editing.service,
                value: bindingValue(editing.type, value, editing.port)
              }
            ]);
          }}
          footer={
            <>
              {editing.type === 'value' && editing.existing ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy}
                  onClick={() =>
                    void inspect([
                      ...changes,
                      { key: editing.key, service: editing.service, value: '' }
                    ])
                  }
                >
                  Clear value
                </button>
              ) : null}
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy}>
                Save edit
              </button>
            </>
          }
        >
          <label className="field">
            <span>Name</span>
            <input
              required
              disabled={editing.existing}
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              value={editing.key}
              onChange={(event) =>
                setEditing({ ...editing, key: event.target.value })
              }
            />
          </label>
          {services && services[0] !== undefined ? (
            <label className="field">
              <span>Service or job</span>
              <select
                value={editing.service}
                disabled={editing.existing}
                onChange={(event) =>
                  setEditing({ ...editing, service: event.target.value })
                }
              >
                {services.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span>Type</span>
            <select
              value={editing.type}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  type: event.target.value,
                  reference: '',
                  port: undefined
                })
              }
            >
              {[
                'value',
                'secret',
                ...(editing.type === 'fromEnv' ? ['fromEnv'] : []),
                ...(inspection?.description.spec.type === 'environment'
                  ? ['service', 'publicUrl', 'browserUrl']
                  : [])
              ].map((value) => (
                <option key={value} value={value}>
                  {bindingTypeLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{editing.type === 'value' ? 'New value' : 'Reference'}</span>
            <input
              key={editing.type}
              ref={valueRef}
              defaultValue={editing.reference}
              required={editing.type !== 'value'}
              autoComplete="off"
              placeholder={
                editing.concealed && editing.type === 'value'
                  ? 'Leave blank to keep the current value'
                  : undefined
              }
            />
          </label>
          {editing.type === 'service' ? (
            <label className="field">
              <span>Port</span>
              <input
                value={editing.port ?? ''}
                placeholder="Default connection"
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    port: event.target.value || undefined
                  })
                }
              />
            </label>
          ) : null}
          {editing.type === 'secret' ? (
            <p>
              Enter the secret reference here. Add or replace its concealed value
              from the secret control in Preview before approving startup.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="tm-application-preview__error">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
      {sourceEdit ? (
        <PreviewDialog
          title="Connect source folder"
          busy={busy}
          onClose={() => setSourceEdit(undefined)}
          onOpenChange={onModalOpenChange}
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            void api
              .connectApplicationPreviewSource({
                taskId,
                attemptId: sourceEdit.attemptId,
                service: sourceEdit.service,
                directory: sourceEdit.directory,
                expected: sourceEdit.expected
              })
              .then(
                () => {
                  setSourceEdit(undefined);
                  onChanged();
                },
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
                onClick={() => setSourceEdit(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy || !sourceEdit.directory}
              >
                Connect folder
              </button>
            </>
          }
        >
          {sourceServices[0] !== undefined ? (
            <label className="field">
              <span>Service or job</span>
              <select
                value={sourceEdit.service}
                onChange={(event) =>
                  setSourceEdit({
                    ...sourceEdit,
                    service: event.target.value
                  })
                }
              >
                {sourceServices.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {currentFolder ? <p>Current folder: <code>{currentFolder}</code></p> : null}
          <div className="tm-application-preview__folder-picker">
            <label className="field">
              <span>New folder</span>
              <input
                value={sourceEdit.directory}
                readOnly
                required
                placeholder="Choose a folder"
                title={sourceEdit.directory}
              />
            </label>
            <button
              type="button"
              className="outline-button"
              disabled={busy}
              onClick={() => {
                void api.chooseRepositoryFolder().then(
                  (directory) => {
                    if (directory) setSourceEdit({ ...sourceEdit, directory });
                  },
                  (cause) => setError(message(cause))
                );
              }}
            >
              Choose…
            </button>
          </div>
          <p className="tm-application-preview__notice">
            {sourceEdit.service ?? 'Application'} will use the selected folder.
            Connection permits Previewhost to use it until Task Monki closes.
            Commands run with your account permissions and may read or change files.
            After connecting, review and approve the configuration before it runs.
          </p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
      {pendingSelection ? (
        <PreviewDialog
          onOpenChange={onModalOpenChange}
          title="Discard unsaved edits?"
          busy={false}
          onClose={() => setPendingSelection(undefined)}
          footer={
            <>
              <button
                className="outline-button"
                onClick={() => setPendingSelection(undefined)}
              >
                Keep editing
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  setSelected(pendingSelection);
                  setPendingSelection(undefined);
                }}
              >
                Discard edits
              </button>
            </>
          }
        >
          <p>Changing the selected configuration discards this draft.</p>
        </PreviewDialog>
      ) : null}
    </div>
  );
}

function bindingValue(
  type: string,
  value: string,
  port?: string
): ConfigurationBindingChange['value'] {
  switch (type) {
    case 'value':
      return value;
    case 'secret':
      return { secret: value };
    case 'service':
      return { service: value, ...(port ? { port } : {}) };
    case 'publicUrl':
      return { publicUrl: value };
    case 'browserUrl':
      return { browserUrl: value };
    case 'fromEnv':
      return { fromEnv: value };
    default:
      throw new Error('Unknown binding type.');
  }
}

function bindingEditor(value: ConfigurationBindingChange['value']): {
  type: string;
  reference: string;
  port?: string;
} {
  if (!value || typeof value === 'string')
    return { type: 'value', reference: '' };
  if ('service' in value)
    return { type: 'service', reference: value.service, port: value.port };
  if ('secret' in value) return { type: 'secret', reference: value.secret };
  if ('fromEnv' in value) return { type: 'fromEnv', reference: value.fromEnv };
  if ('publicUrl' in value)
    return { type: 'publicUrl', reference: value.publicUrl };
  return { type: 'browserUrl', reference: value.browserUrl };
}

function bindingTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    value: 'Value',
    service: 'Service URL',
    secret: 'Secret reference',
    fromEnv: 'Owner input',
    publicUrl: 'App URL',
    browserUrl: 'Browser URL'
  };
  return labels[type] ?? type;
}
