import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { PreviewStatus } from 'previewhost';
import type { ApplicationPreviewSnapshot, PreviewDiagnosis, PreviewProjectFact } from '../../../shared/applicationPreview';
import type { WorktreeRecord } from '../../../shared/contracts';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import { previewFolderUsage, type PreviewWorktreeAvailability } from '../../model/applicationPreviewPanel';
import type { PreviewConfigurationChange } from '../../model/previewConfigurationChanges';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu';
import { DecisionBlock } from '../DecisionBlock';
import { basename, CopyPath, DisclosureSummary, expected, GroupLabel, message, parentPath, PreviewRunReview, Row, shortenPath, usePreviewNotify } from './previewPresentation';
import { PreviewSecretDialog } from './PreviewSecretDialog';

/** The worktree is gone, broken or not yet created: the block carries the consent the restore needs. The primary is in the status row. */
export function PreviewWorktreeBlock({ worktree, availability }: { worktree?: WorktreeRecord; availability: Exclude<PreviewWorktreeAvailability, { state: 'available' }> }) {
  const commit = (worktree?.headSha ?? worktree?.baseSha)?.slice(0, 7);
  const external = availability.state !== 'absent' && availability.external;
  const kind = availability.state === 'absent' ? 'Worktree not prepared' : external ? 'Checkout unavailable' : availability.state === 'failed' ? 'Worktree setup failed' : 'Worktree missing';
  const title = availability.state === 'absent'
    ? 'Prepare the task worktree to run Preview'
    : external
      ? 'Reconnect the checkout to run Preview'
      : availability.state === 'failed'
        ? 'Retry the worktree setup to run Preview'
        : 'Restore the task worktree to run Preview';
  const summary = availability.state === 'absent'
    ? 'Preview runs from the task’s own checkout. Preparing it chooses a base branch and creates an isolated worktree; nothing in the source checkout changes.'
    : external
      ? `The connected checkout at ${worktree?.worktreePath ?? 'its folder'} is unavailable. Reconnect chooses its folder again; nothing is copied or changed.`
      : `${availability.state === 'failed' && worktree?.error ? `${worktree.error.replace(/\.?$/, '.')} ` : ''}${availability.state === 'failed' ? 'Retry runs the checkout again' : 'Restore checks the branch out again'}${commit ? ` at commit ${commit}` : ''}. Uncommitted files cannot be recovered; the preview configuration file was in that folder. Secrets and retained data are kept. Git checkout hooks and content filters can run local commands.`;
  return (
    <DecisionBlock
      kind={kind}
      tone={availability.pending ? 'info' : 'error'}
      meta={worktree ? `${commit ?? ''}${commit ? ' · ' : ''}${worktree.branchName}` : undefined}
      title={title}
      summary={summary}
      details={
        worktree ? (
          <ul className="tm-preview-facts">
            <li><span className="tm-preview-facts__key">Branch</span><code>{worktree.branchName}</code></li>
            <li><span className="tm-preview-facts__key">Base</span><code>{worktree.baseRef ?? 'Detached HEAD'} @ {worktree.baseSha.slice(0, 12)}</code></li>
            {worktree.headSha ? <li><span className="tm-preview-facts__key">Commit</span><code>{worktree.headSha.slice(0, 12)}</code></li> : null}
            <li><span className="tm-preview-facts__key">Folder</span><code title={worktree.worktreePath}>{worktree.worktreePath}</code></li>
          </ul>
        ) : undefined
      }
    />
  );
}

/** Only what blocks a start, each as one row with its own control. */
export function PreviewRequirementsBlock({ taskId, requirements, status, busy, run, onEditFile, secretReferences, onSecretReferences, refresh }: {
  taskId: string;
  requirements: NonNullable<ApplicationPreviewSnapshot['requirements']>;
  status?: PreviewStatus;
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<void>;
  onEditFile(): void;
  /** References the secret form is open for; an empty list opens the storage unlock. */
  secretReferences?: string[];
  onSecretReferences(references: string[] | undefined): void;
  refresh(): void;
}) {
  const notify = usePreviewNotify();
  const [chosenFolders, setChosenFolders] = useState<Record<string, string>>({});
  const [allSecrets, setAllSecrets] = useState(false);
  // "Add all values" decides the form once: saving one value makes it available on the next poll,
  // and the form must keep stepping through the list it opened with.
  const [sequenceFor, setSequenceFor] = useState<string>();
  const folders = new Map<string, { source: (typeof requirements.sources)[number]; services: string[] }>();
  for (const source of requirements.sources) {
    if (source.connected) continue;
    const key = `${source.declaration}\0${source.directory}`;
    const group = folders.get(key);
    if (group) group.services.push(source.service);
    else folders.set(key, { source, services: [source.service] });
  }
  const spec = requirements.description?.spec;
  const typeOf = (service: string) => (spec?.type === 'environment' ? spec.services[service]?.type : spec?.type);
  const unavailable = requirements.secrets.filter((secret) => secret.availability !== 'available');
  const storage = requirements.storage;
  const storageNeeded = (!!storage && storage.state !== 'unlocked') || unavailable.some((secret) => secret.availability !== 'missing');
  const storageFor = [
    ...(storage && storage.state !== 'unlocked' && storage.services.length ? ['database credentials'] : []),
    ...unavailable.filter((secret) => secret.availability !== 'missing').map((secret) => secret.id)
  ];
  const storageSecrets = storageFor.filter((item) => item.includes('/')).length;
  const storageNeeds = [
    ...(storageFor.length > storageSecrets ? ['database credentials'] : []),
    ...(storageSecrets ? [`${storageSecrets} ${storageSecrets === 1 ? 'secret' : 'secrets'}`] : [])
  ].join(' and ');
  const missingSecrets = unavailable.filter((secret) => secret.availability === 'missing');
  const prerequisites = requirements.description?.prerequisites ?? [];
  const missingTools = prerequisites.filter((item) => item.status === 'missing');
  const unverified = prerequisites.filter((item) => item.status !== 'missing');
  const recipients = (secret: (typeof requirements.secrets)[number]) =>
    secret.bindings.map((binding) => `${binding.service ?? 'Application'} · ${binding.key}`).join(', ');
  const openSecret = secretReferences?.length === 1 ? secretReferences[0] : undefined;
  const inlineSecret = secretReferences && (secretReferences.length === 0
    ? storageNeeded
    : !!openSecret && missingSecrets.some((secret) => secret.id === openSecret));
  // Several missing values are entered one after another in one form.
  const sequence = !!secretReferences && secretReferences.length > 1 && secretReferences.join('\0') === sequenceFor;
  const shownSecrets = allSecrets || missingSecrets.findIndex((secret) => secret.id === openSecret) >= 4 ? missingSecrets : missingSecrets.slice(0, 4);
  const offersConnect = [...folders.values()].some(({ source }) => !source.missing || chosenFolders[`${source.service}:${source.declaration}`]);
  const secretForm = secretReferences ? (
    <PreviewSecretDialog
      key={secretReferences.join('\0')}
      inline
      sequence={sequence}
      references={secretReferences}
      recipients={Object.fromEntries(requirements.secrets.map((secret) => [secret.id, secret.bindings.map((binding) => `${binding.service ?? 'Application'} · ${binding.key}`)]))}
      labels={Object.fromEntries(requirements.secrets.map((secret) => [secret.id, [...new Set(secret.bindings.map((binding) => binding.key))].join(', ')]))}
      onClose={() => {
        onSecretReferences(undefined);
        refresh();
      }}
      onSaved={() => {
        // The row leaves the block; when it was the last one, the toast is the only confirmation.
        notify(secretReferences.length === 0 ? 'Secret storage unlocked' : secretReferences.length === 1 ? 'Secret saved' : 'Secrets saved', 'success');
        onSecretReferences(undefined);
        refresh();
      }}
    />
  ) : null;
  return (
    <DecisionBlock kind="Before this runs" tone="action">
      {folders.size ? (
        <div className="tm-preview-requirement-group">
          <GroupLabel>Folders</GroupLabel>
          <div className="tm-preview-rows tm-preview-source-rows">
            {[...folders.values()].map(({ source, services }) => {
              const key = `${source.service}:${source.declaration}`;
              const directory = chosenFolders[key] ?? source.directory;
              const missing = source.missing && !chosenFolders[key];
              return (
                <Row
                  key={key}
                  name={<code>{basename(directory)}</code>}
                  title={directory}
                  detail={<span className="tm-preview-path" title={directory}>{missing ? 'Not found · ' : ''}{shortenPath(parentPath(directory))}</span>}
                  end={
                    missing ? (
                      <button
                        className="outline-button tm-preview-row-button"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const selected = await api.chooseRepositoryFolder();
                            if (selected) setChosenFolders((value) => ({ ...value, [key]: selected }));
                          })
                        }
                      >
                        Choose folder
                      </button>
                    ) : (
                      <button
                        className="outline-button tm-preview-row-button"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.connectApplicationPreviewSource({ taskId, service: source.service, directory, expected: expected(status) }))
                        }
                      >
                        Connect
                      </button>
                    )
                  }
                >
                  <span title={services.join(', ')}>{previewFolderUsage(services, typeOf)}</span>
                </Row>
              );
            })}
          </div>
          {offersConnect ? <p className="tm-preview-help">Connected folders stay writable by preview commands until Task Monki quits.</p> : null}
        </div>
      ) : null}
      {storageNeeded || missingSecrets.length ? (
        <div className="tm-preview-requirement-group">
          <div className="tm-preview-group-head">
            <GroupLabel>Secrets</GroupLabel>
            {missingSecrets.length >= 2 && !storageNeeded ? (
              <button
                className="ghost-button tm-preview-row-button"
                aria-expanded={sequence}
                onClick={() => {
                  const references = missingSecrets.map((secret) => secret.id);
                  setSequenceFor(references.join('\0'));
                  onSecretReferences(references);
                }}
              >
                Add all values
              </button>
            ) : null}
          </div>
          <div className="tm-preview-rows tm-preview-secret-rows">
            {storageNeeded ? (
              <Row
                className="tm-preview-row--line"
                name="Secret storage"
                expansion={secretReferences?.length === 0 ? secretForm : undefined}
                detail={<span title={storageFor.length ? `Needed for ${storageFor.join(', ')}` : undefined}>{storage?.state === 'new' ? 'Not set up on this Mac' : 'Locked'}{storageNeeds ? ` · needed for ${storageNeeds}` : ''}</span>}
                end={
                  <button className="outline-button tm-preview-row-button" onClick={() => onSecretReferences([])}>
                    {storage?.state === 'new' ? 'Set up storage' : 'Unlock storage'}
                  </button>
                }
              />
            ) : null}
            {shownSecrets.map((secret) => (
              <Row
                key={secret.id}
                className="tm-preview-row--line"
                name={<code title={secret.id}>{secret.id}</code>}
                detail={<span className="tm-preview-row__muted" title={recipients(secret)}>{recipients(secret)}</span>}
                end={<button className="outline-button tm-preview-row-button" aria-label={`Add value for ${secret.id}`} aria-expanded={openSecret === secret.id} onClick={() => onSecretReferences([secret.id])}>Add</button>}
                expansion={openSecret === secret.id && inlineSecret ? secretForm : undefined}
              />
            ))}
          </div>
          {shownSecrets.length < missingSecrets.length ? (
            <button className="ghost-button tm-preview-more" onClick={() => setAllSecrets(true)}>Show {missingSecrets.length - shownSecrets.length} more</button>
          ) : null}
          {secretReferences && !inlineSecret ? secretForm : null}
        </div>
      ) : secretReferences && !inlineSecret ? secretForm : null}
      {requirements.connections.length ? (
        <div className="tm-preview-requirement-group">
          <GroupLabel>Connections</GroupLabel>
          <div className="tm-preview-rows">
            {requirements.connections.map((service) => (
              <Row key={service} name={service} detail="Needs the address of the running service" end={<button className="outline-button tm-preview-row-button" onClick={onEditFile}>Set address</button>} />
            ))}
          </div>
        </div>
      ) : null}
      {missingTools.length ? (
        <div className="tm-preview-requirement-group">
          <GroupLabel>Tools</GroupLabel>
          <div className="tm-preview-rows">
            {missingTools.map((item, i) => <Row key={i} name={item.service ?? item.requirement} detail={item.message} />)}
          </div>
        </div>
      ) : null}
      {unverified.length ? (
        <details className="tm-preview-disclosure">
          <DisclosureSummary>Other checks · {unverified.length}</DisclosureSummary>
          <div className="tm-preview-rows">
            {unverified.map((item, i) => <Row key={i} name={item.service ?? item.requirement} detail={item.message} end="Checked at start" />)}
          </div>
        </details>
      ) : null}
    </DecisionBlock>
  );
}

/** The one explicit approval, bound to this attempt: what runs, where, and what a restart rewrites while something is live. */
export function PreviewRunApprovalBlock({ review, restart, projectDirectory, busy, changes, onViewChanges }: {
  review: NonNullable<ApplicationPreviewSnapshot['approval'] | ApplicationPreviewSnapshot['restartReview']>;
  restart: boolean;
  projectDirectory?: string;
  busy: boolean;
  /** Service-level changes since the serving run started; absent when the texts cannot be compared. */
  changes?: PreviewConfigurationChange[];
  onViewChanges(): void;
}) {
  const affected = review.affected ?? [];
  const everything = <PreviewRunReview description={review.description} projectDirectory={projectDirectory} />;
  return (
    <DecisionBlock
      kind={restart ? 'Restart review' : 'Approve this run'}
      tone="action"
      summary={restart ? 'Approving stops the serving app until the new version is ready.' : undefined}
      actions={restart && !changes ? <button className="ghost-button" disabled={busy} onClick={onViewChanges}>View changes</button> : undefined}
    >
      {restart && changes ? (
        <>
          <GroupLabel>Changes</GroupLabel>
          <div className="tm-preview-rows">
            {changes.length ? (
              changes.map((change, i) => (
                <Row key={i} name={change.service} detail={change.change} end={change.concealed ? 'value concealed' : <button className="ghost-button" onClick={onViewChanges}>View</button>} />
              ))
            ) : (
              <Row name="preview.yaml" detail="Runs the same configuration; only comments or formatting differ." end={<button className="ghost-button" onClick={onViewChanges}>View</button>} />
            )}
          </div>
        </>
      ) : null}
      {affected.length ? (
        <>
          <GroupLabel>Rewrites live folders</GroupLabel>
          <div className="tm-preview-rows">
            {affected.map((row) => (
              <Row key={row.job} name={row.job} detail={<code className="tm-preview-path" title={row.directory}>{shortenPath(row.directory)}</code>} end={<CopyPath path={row.directory} />}>
                Shared with {row.previews.join(', ')}; this step can change files they use.
              </Row>
            ))}
          </div>
        </>
      ) : null}
      {restart ? (
        <details className="tm-preview-disclosure">
          <DisclosureSummary>Everything that will run</DisclosureSummary>
          {everything}
        </details>
      ) : (
        everything
      )}
    </DecisionBlock>
  );
}

/** What failed, from the evidence, with the recommended next step first. */
export function PreviewDiagnosisBlock({ diagnosis, meta, primary, secondary, more, onOpenLogs }: {
  diagnosis: PreviewDiagnosis;
  meta: string;
  primary: { label: string; onSelect(): void; disabled?: boolean; disabledReason?: string };
  secondary?: { label: string; onSelect(): void; disabled?: boolean; disabledReason?: string };
  more: ActionMenuItem[];
  onOpenLogs(): void;
}) {
  return (
    <DecisionBlock
      kind={`${diagnosis.service ?? 'Application'} failed`}
      meta={meta}
      tone="error"
      title={diagnosis.title}
      summary={diagnosis.summary}
      actions={
        <>
          <button className="outline-button" disabled={primary.disabled} title={primary.disabledReason} onClick={primary.onSelect}>{primary.label}</button>
          {secondary ? <button className="ghost-button" disabled={secondary.disabled} title={secondary.disabledReason} onClick={secondary.onSelect}>{secondary.label}</button> : null}
          <ActionMenu label="More recovery actions" trigger={<>More<ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" /></>} items={more} />
        </>
      }
      details={
        <ul className="tm-preview-facts">
          <li><span className="tm-preview-facts__key">Observed</span><span>{diagnosis.observed}</span></li>
          <li><span className="tm-preview-facts__key">Unknown</span><span>{diagnosis.unknown}</span></li>
          <li><span className="tm-preview-facts__key">Runtime</span><span>{diagnosis.guarantee}</span></li>
          {!diagnosis.excerpt ? <li><span className="tm-preview-facts__key">Logs</span><span><button className="ghost-button" onClick={onOpenLogs}>Open in Logs</button></span></li> : null}
        </ul>
      }
    >
      {diagnosis.excerpt ? (
        <div className="tm-preview-excerpt">
          <div className="tm-preview-excerpt__bar">
            <span>{diagnosis.service ?? 'Application'} · last output</span>
            <button className="ghost-button" onClick={onOpenLogs}>Open in Logs</button>
          </div>
          <pre>{diagnosis.excerpt}</pre>
        </div>
      ) : null}
    </DecisionBlock>
  );
}

/** What the project files say, before anything runs. */
export function PreviewProjectFacts({ taskId, lead }: { taskId: string; lead: ReactNode }) {
  const [facts, setFacts] = useState<PreviewProjectFact[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    api.inspectApplicationPreviewSetup({ taskId }).then(
      (setup) => {
        if (!disposed) setFacts(setup.facts);
      },
      (cause) => {
        if (!disposed) setError(message(cause));
      }
    );
    return () => {
      disposed = true;
    };
  }, [taskId]);
  return (
    <div className="tm-preview-setup">
      <p className="tm-preview-help">{lead}</p>
      {facts?.length ? (
        <>
          <GroupLabel>From the project files</GroupLabel>
          <div className="tm-preview-rows">
            {facts.map((fact, i) => <Row key={i} name={fact.label} detail={fact.detail} end={<code>{fact.source}</code>} />)}
          </div>
        </>
      ) : null}
      {error ? <p className="tm-preview-help">The project files could not be read: {error}</p> : null}
    </div>
  );
}
