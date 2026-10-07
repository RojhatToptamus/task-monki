import { useState } from 'react';
import type {
  ConfigurationBindingsInspection,
  DependencyBinding,
  PreviewStatus
} from 'previewhost';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import {
  expected,
  message,
  PreviewDialog,
  ServiceName,
  serviceTypeLabel
} from './previewPresentation';

const connectionTypes = [
  'attach',
  'preview',
  'external-tcp',
  'external-postgres',
  'external-redis'
] as const;

/** Connection values stay in Previewhost; this form holds only the replacement being entered. */
export function ApplicationDependencies({
  taskId,
  attemptId,
  inspection,
  status,
  disabled,
  onChanged,
  onModalOpenChange
}: {
  taskId: string;
  attemptId: string;
  inspection: ConfigurationBindingsInspection;
  status?: PreviewStatus;
  disabled: boolean;
  onChanged(): void;
  onModalOpenChange?(open: boolean): void;
}) {
  const [editing, setEditing] = useState<{
    service: string;
    type: DependencyBinding['type'];
  }>();
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const spec = inspection.description.spec;
  if (spec.type !== 'environment') return null;
  const connections = Object.entries(spec.services).filter(([, service]) =>
    connectionTypes.some((type) => type === service.type)
  );
  if (!connections.length) return null;
  const database =
    editing?.type === 'external-postgres' || editing?.type === 'external-redis';
  async function apply() {
    if (!editing) return;
    const binding: DependencyBinding =
      editing.type === 'attach'
        ? { type: 'attach', url: address }
        : editing.type === 'preview'
          ? {
              type: 'preview',
              name: address,
              ...(port ? { service: port } : {})
            }
          : editing.type === 'external-tcp'
            ? { type: 'external-tcp', host: '127.0.0.1', port: Number(port) }
            : { type: editing.type, url: { secret: address } };
    setBusy(true);
    setError(undefined);
    try {
      await api.connectApplicationPreviewDependency({
        taskId,
        attemptId,
        service: editing.service,
        binding,
        expected: expected(status)
      });
      setEditing(undefined);
      onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="tm-application-preview__configuration-section"
      aria-label="Dependency connections"
    >
      <h3 className="tm-panel__title">Connections</h3>
      <div className="tm-application-preview__table-wrap">
        <table className="tm-application-preview__table">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Type</th>
              <th scope="col">
                <span className="tm-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {connections.map(([id, service]) => (
              <tr key={id}>
                <th scope="row">
                  <ServiceName name={id} type={service.type} />
                </th>
                <td>{serviceTypeLabel(service.type)}</td>
                <td>
                  <button
                    className="ghost-button"
                    disabled={disabled || busy}
                    onClick={() => {
                      setAddress('');
                      setPort('');
                      setError(undefined);
                      setEditing({
                        service: id,
                        type: service.type as DependencyBinding['type']
                      });
                    }}
                  >
                    Connect
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? (
        <PreviewDialog
          title={`Connect ${editing.service}`}
          busy={busy}
          onClose={() => setEditing(undefined)}
          onOpenChange={onModalOpenChange}
          onSubmit={(event) => {
            event.preventDefault();
            void apply();
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
                Review connection
              </button>
            </>
          }
        >
          {editing.type !== 'external-tcp' ? (
            <label className="field">
              <span>
                {database
                  ? 'Secret reference'
                  : editing.type === 'preview'
                    ? 'Preview name'
                    : 'Local URL'}
              </span>
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  database
                    ? 'project/dev/database'
                    : editing.type === 'attach'
                      ? 'http://127.0.0.1:3000'
                      : undefined
                }
              />
            </label>
          ) : (
            <p className="tm-application-preview__notice">
              Connect to a service on this computer (127.0.0.1).
            </p>
          )}
          {editing.type === 'external-tcp' || editing.type === 'preview' ? (
            <label className="field">
              <span>
                {editing.type === 'preview' ? 'Service (optional)' : 'Port'}
              </span>
              <input
                value={port}
                onChange={(event) => setPort(event.target.value)}
                required={editing.type === 'external-tcp'}
                type={editing.type === 'external-tcp' ? 'number' : 'text'}
                min={1}
                max={65535}
              />
            </label>
          ) : null}
          {database ? (
            <p className="tm-application-preview__notice">
              Enter the secret reference for the connection URL. Add its value during Preview review. Use the
              reference here.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
        </PreviewDialog>
      ) : null}
    </section>
  );
}
