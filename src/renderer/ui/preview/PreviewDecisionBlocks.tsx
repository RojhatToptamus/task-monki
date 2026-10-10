import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { PreviewStatus } from 'previewhost';
import type { ApplicationPreviewSnapshot, PreviewDiagnosis, PreviewProjectFact } from '../../../shared/applicationPreview';
import type { WorktreeRecord } from '../../../shared/contracts';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import type { PreviewWorktreeAvailability } from '../../model/applicationPreviewPanel';
import type { PreviewConfigurationChange } from '../../model/previewConfigurationChanges';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu';
import { DecisionBlock } from '../DecisionBlock';
import { CopyPath, DisclosureSummary, expected, GroupLabel, message, PreviewRunReview, Row, shortenPath } from './previewPresentation';
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
  const [chosenFolders, setChosenFolders] = useState<Record<string, string>>({});
  const folders = new Map<string, { source: (typeof requirements.sources)[number]; services: string[] }>();
  for (const source of requirements.sources) {
    if (source.connected) continue;
    const key = `${source.declaration}\0${source.directory}`;
    const group = folders.get(key);
    if (group) group.services.push(source.service);
    else folders.set(key, { source, services: [source.service] });
  }
  const unavailable = requirements.secrets.filter((secret) => secret.availability !== 'available');
  const storage = requirements.storage;
  const storageNeeded = (!!storage && storage.state !== 'unlocked') || unavailable.some((secret) => secret.availability !== 'missing');
  const storageFor = [
    ...(storage && storage.state !== 'unlocked' && storage.services.length ? ['database credentials'] : []),
    ...unavailable.filter((secret) => secret.availability !== 'missing').map((secret) => secret.id)
  ];
  const missingSecrets = unavailable.filter((secret) => secret.availability === 'missing');
  const prerequisites = requirements.description?.prerequisites ?? [];
  const missingTools = prerequisites.filter((item) => item.status === 'missing');
  const unverified = prerequisites.filter((item) => item.status !== 'missing');
  const recipients = (secret: (typeof requirements.secrets)[number]) =>
    secret.bindings.map((binding) => `${binding.service ?? 'Application'} → ${binding.key}`).join(', ');
  const inlineSecret = secretReferences && (secretReferences.length === 0
    ? storageNeeded
    : secretReferences.length === 1 && missingSecrets.some(secret => secret.id === secretReferences[0]));
  const secretForm = secretReferences ? (
    <PreviewSecretDialog
      key={secretReferences.join('\0')}
      inline
      references={secretReferences}
      recipients={Object.fromEntries(requirements.secrets.map((secret) => [secret.id, secret.bindings.map((binding) => `${binding.service ?? 'Application'} → ${binding.key}`)]))}
      onClose={() => {
        onSecretReferences(undefined);
        refresh();
      }}
      onSaved={() => {
        onSecretReferences(undefined);
        refresh();
      }}
    />
  ) : null;
  return (
    <DecisionBlock kind="Before this runs" tone="action">
      {folders.size ? (
        <>
          <GroupLabel>Folders</GroupLabel>
          <div className="tm-preview-rows tm-preview-source-rows">
            {[...folders.values()].map(({ source, services }) => {
              const key = `${source.service}:${source.declaration}`;
              const directory = chosenFolders[key] ?? source.directory;
              const missing = source.missing && !chosenFolders[key];
              return (
                <Row
                  key={key}
                  name={services.join(', ')}
                  title={services.join(', ')}
                  detail={<span className="tm-preview-path">{missing ? 'Not found: ' : ''}{directory}</span>}
                  end={
                    missing ? (
                      <button
                        className="outline-button"
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
                        className="outline-button"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.connectApplicationPreviewSource({ taskId, service: source.service, directory, expected: expected(status) }))
                        }
                      >
                        Connect
                      </button>
                    )
                  }
                />
              );
            })}
          </div>
          <p className="tm-preview-help">
            Read/write access lasts until Task Monki quits, across tasks. Commands run as you, without a sandbox.
          </p>
        </>
      ) : null}
      {storageNeeded || missingSecrets.length ? (
        <>
          <GroupLabel>Secrets</GroupLabel>
          <div className="tm-preview-rows tm-preview-secret-rows">
            {storageNeeded ? (
              <Row
                name="Secret storage"
                expansion={secretReferences?.length === 0 ? secretForm : undefined}
                detail={storage?.state === 'new' ? 'Not set up on this Mac yet' : 'Locked'}
                end={
                  <button className="outline-button" onClick={() => onSecretReferences([])}>
                    {storage?.state === 'new' ? 'Set up storage' : 'Unlock storage'}
                  </button>
                }
              >
                {storageFor.length ? <>Needed for {storageFor.map((item, i) => <span key={item}>{i ? ', ' : ''}{item.includes('/') ? <code>{item}</code> : item}</span>)}</> : undefined}
              </Row>
            ) : null}
            {missingSecrets.map((secret) => (
              <Row
                key={secret.id}
                name={<code title={secret.id}>{secret.id}</code>}
                detail={`Used by ${recipients(secret)}`}
                end={<button className="outline-button" aria-label={`Add value for ${secret.id}`} aria-expanded={secretReferences?.length === 1 && secretReferences[0] === secret.id} onClick={() => onSecretReferences([secret.id])}>Add value</button>}
                expansion={secretReferences?.length === 1 && secretReferences[0] === secret.id ? secretForm : undefined}
              />
            ))}
          </div>
          <p className="tm-preview-help">Values stay in secret storage on this Mac and are never written to the file.</p>
        </>
      ) : null}
      {secretReferences && !inlineSecret ? secretForm : null}
      {requirements.connections.length ? (
        <>
          <GroupLabel>Connections</GroupLabel>
          <div className="tm-preview-rows">
            {requirements.connections.map((service) => (
              <Row key={service} name={service} detail="Needs the address of the running service" end={<button className="outline-button" onClick={onEditFile}>Set address</button>} />
            ))}
          </div>
        </>
      ) : null}
      {missingTools.length ? (
        <>
          <GroupLabel>Tools</GroupLabel>
          <div className="tm-preview-rows">
            {missingTools.map((item, i) => <Row key={i} name={item.service ?? item.requirement} detail={item.message} />)}
          </div>
        </>
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
      summary={restart ? 'Approving stops the serving app first; it is unavailable until the new version is ready. Cancel changes nothing.' : undefined}
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
              <Row name="preview.yaml" detail="No service changes; only comments or ordering differ." end={<button className="ghost-button" onClick={onViewChanges}>View</button>} />
            )}
          </div>
        </>
      ) : null}
      {affected.length ? (
        <>
          <GroupLabel>Rewrites live folders</GroupLabel>
          <div className="tm-preview-rows">
            {affected.map((row) => (
              <Row key={row.job} name={row.job} detail={<code title={row.directory}>{shortenPath(row.directory)}</code>} end={<CopyPath path={row.directory} />}>
                Shared with {row.previews.join(', ')}. The step can change files there or interrupt those previews.
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
      <p className="tm-preview-help">Commands run with your account; folder access does not sandbox them. Saving or connecting never approves a run.</p>
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
