import { useId, useRef, useState, type RefObject } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { BugCaseAction, BugCaseView, BugReplayGateProjection, BugReplaySnapshot } from '../../../shared/bugReplay';
import { bugReason } from '../../../shared/bugReplayClaims';
import { taskManagerApi } from '../../api/taskManagerClient';
import {
  bugActionLabel,
  bugActionPendingLabel,
  bugGateOf,
  bugRunRows,
  describeBugStatus,
  layoutBugActions
} from '../../model/bugReplay';
import { formatAttachmentBytes } from '../../model/taskAttachmentDraft';
import { formatShortAge } from '../../model/timeAgo';
import { ActionMenu } from '../ActionMenu';
import { DisclosureChevron } from '../DisclosureChevron';
import { StatusGlyph, statusGlyphFor } from '../StatusBadge';
import { DecisionSlot, OverviewSection, SlotActions, SlotContent, type SlotAction } from '../TaskOverview';
import { useDialogFocusBoundary } from '../dialogFocus';
import { PreviewSecretDialog } from '../preview/PreviewSecretDialog';
import { BugConfirmDialog } from './BugConfirmDialog';
import { BugImage } from './BugImage';
import { BugLeaseFacts } from './BugLeaseBlock';

export interface BugActionHost {
  /** A recording started; show it where it happens. */
  onOpenRecording(): void;
  onError(message: string): void;
  /** Why task actions are paused right now, if they are. */
  blockedReason?: string;
  /** Where focus goes when a bug dialog closes and its trigger is gone. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Runs one of the bug's actions; the busy state stays on the control that started it. */
export function useBugActions(taskId: string, snapshot: BugReplaySnapshot | undefined, host: BugActionHost, refresh: () => void) {
  const [busy, setBusy] = useState<BugCaseAction>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const run = async (action: BugCaseAction, work: () => Promise<unknown>) => {
    setBusy(action);
    try {
      await work();
      refresh();
    } catch (cause) {
      host.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };
  const perform = (action: BugCaseAction) => {
    const gate = snapshot?.activeCase?.gate;
    switch (action) {
      case 'send-to-agent':
        return void run(action, () => taskManagerApi.sendBugToAgent({ taskId, clientOperationId: crypto.randomUUID() }));
      case 'verify-again':
        return void run(action, () => taskManagerApi.verifyBugFix({ taskId }));
      case 'run-again':
        return void run(action, () => taskManagerApi.runBugBaseline({ taskId }));
      case 'record-again':
        return void run(action, async () => {
          await taskManagerApi.startBugRecording({ taskId, clientOperationId: crypto.randomUUID() });
          host.onOpenRecording();
        });
      case 'allow-runs':
        return snapshot?.pendingLease
          ? void run(action, () => taskManagerApi.allowBugReplayRuns({ taskId, templateDigest: snapshot.pendingLease!.templateDigest }))
          : undefined;
      case 'unlock-secrets':
        return setUnlocking(true);
      case 'cancel-run':
        return gate?.activeRun ? void run(action, () => taskManagerApi.cancelBugReplayRun({ taskId, runId: gate.activeRun!.runId })) : undefined;
      case 'remove':
        return setConfirmRemove(true);
      default:
        return void run(action, () => taskManagerApi.applyBugCaseAction({ taskId, action }));
    }
  };
  const dialogs = (
    <>
      {confirmRemove && snapshot?.activeCase ? (
        <BugConfirmDialog
          title={`Remove “${snapshot.activeCase.title}”?`}
          body="Task Monki stops checking it and the review no longer shows it. Its recording stays in Debug, under Earlier bugs."
          keepLabel="Keep bug"
          confirmLabel="Remove bug"
          busyLabel="Removing…"
          busy={busy === 'remove'}
          returnFocusRef={host.returnFocusRef}
          onKeep={() => setConfirmRemove(false)}
          onConfirm={() => void run('remove', async () => {
            await taskManagerApi.removeBug({ taskId });
            setConfirmRemove(false);
          })} />
      ) : null}
      {unlocking ? (
        <PreviewSecretDialog references={[]} inPreview={false} onClose={() => setUnlocking(false)}
          onSaved={() => {
            setUnlocking(false);
            refresh();
          }} />
      ) : null}
    </>
  );
  /** Why an offered action cannot run right now: the task's own pause, or the bug's reason. */
  const reasonFor = (action: BugCaseAction, view: BugCaseView): string | undefined =>
    (action === 'send-to-agent' ? host.blockedReason : undefined) ?? view.unavailable?.[action];
  const asSlotAction = (action: BugCaseAction, view: BugCaseView): SlotAction => {
    const reason = reasonFor(action, view);
    const idle = bugActionLabel(action, view);
    return {
      label: busy === action ? bugActionPendingLabel(action) : idle,
      labels: [idle, bugActionPendingLabel(action)],
      disabled: Boolean(busy) || Boolean(reason),
      reason,
      onClick: () => perform(action)
    };
  };
  const asMenuItem = (action: BugCaseAction, view: BugCaseView) => {
    const reason = reasonFor(action, view);
    return {
      label: bugActionLabel(action, view),
      danger: action === 'remove',
      separated: action === 'remove',
      disabled: Boolean(busy) || Boolean(reason),
      ...(reason ? { disabledReason: reason } : {}),
      onSelect: () => perform(action)
    };
  };
  return { busy, perform, dialogs, asSlotAction, asMenuItem, modalOpen: confirmRemove || unlocking };
}

/**
 * The Now panel when the bug holds the next step: the state, the one fact that drives the step,
 * and its actions; the Bug section below names the bug. Approving clean runs shows what will run
 * before anything does, with declining first, as every approval does.
 */
export function BugNowPanel({ view, snapshot, actions }: {
  view: BugCaseView;
  snapshot: BugReplaySnapshot;
  actions: ReturnType<typeof useBugActions>;
}) {
  const status = describeBugStatus(view.gate);
  const layout = layoutBugActions(view.actions, view.gate.state);
  const approval = view.gate.activeRun?.waitingFor === 'APPROVAL';
  const lease = approval ? snapshot.pendingLease : undefined;
  const evidence = [...(view.before ?? []), ...(view.after ?? [])];
  const reason = bugReason(view.gate);
  const waiting = snapshot.runs.filter((run) => run.state === 'WAITING' && run.waitingFor === 'APPROVAL').length;
  const detail = approval
    ? waiting === 1 ? 'A clean run waits to start.' : waiting > 1 ? `${waiting} clean runs wait to start.` : 'Clean runs wait to start.'
    : reason && !evidence.includes(reason) ? reason : view.countsLine;
  const decline = approval && view.actions.includes('cancel-run') ? actions.asSlotAction('cancel-run', view) : undefined;
  const secondary = layout.secondary.filter((action) => !(decline && action === 'cancel-run'));
  return (
    <DecisionSlot>
      <SlotContent
        headline={status.word}
        detail={detail}
        decline={decline}
        primary={layout.primary ? actions.asSlotAction(layout.primary, view) : undefined}
        secondary={secondary.map((action) => actions.asSlotAction(action, view))}
      >
        {lease ? <BugLeaseFacts lease={lease} /> : null}
      </SlotContent>
    </DecisionSlot>
  );
}

/** The Now panel's bug step while the bug's record loads: the state from the task, no actions yet. */
export function BugNowPlaceholder({ gate }: { gate: BugReplayGateProjection | undefined }) {
  const bug = bugGateOf(gate);
  if (!gate || !bug) return null;
  return (
    <DecisionSlot>
      <SlotContent headline={describeBugStatus(bug).word} detail={bugReason(gate)} />
    </DecisionSlot>
  );
}

/**
 * The task's bug on the Overview: what is wrong, what Task Monki observed before and after the
 * agent's change, and the clean runs that observed it. When the Now panel holds the bug's step,
 * the section keeps only the record.
 */
export function BugSection({
  taskId,
  snapshot,
  actions,
  nowPanel,
  onOpenRecording
}: {
  taskId: string;
  snapshot: BugReplaySnapshot;
  actions: ReturnType<typeof useBugActions>;
  /**
   * What the Now panel already states about the bug: `step` when it holds the bug's step (its
   * state, reason and actions), `state` when its title is the bug's state word. The section
   * keeps the record and never says either twice.
   */
  nowPanel?: 'step' | 'state';
  onOpenRecording(): void;
}) {
  const view = snapshot.activeCase;
  const recording = snapshot.recording;
  const [lightbox, setLightbox] = useState<{ fileId: string; alt: string }>();
  if (!view) {
    if (!recording) return null;
    return (
      <OverviewSection title="Bug" inset aside={<button type="button" className="tm-osection__link" onClick={onOpenRecording}>Open recording</button>}>
        <p className="tm-bug__line">{recording.phase === 'FAILED' ? recording.failure?.title ?? "Recording couldn't start" : 'Recording a bug'}</p>
      </OverviewSection>
    );
  }
  const status = describeBugStatus(view.gate);
  const glyph = statusGlyphFor(status.tone, status.inFlight);
  const layout = layoutBugActions(view.actions, view.gate.state);
  const menu = layout.menu.map((action) => actions.asMenuItem(action, view));
  const stateAbove = Boolean(nowPanel);
  const nowPanelHoldsBug = nowPanel === 'step';
  const runs = bugRunRows(snapshot.runs);
  const lease = view.gate.activeRun?.waitingFor === 'APPROVAL' ? snapshot.pendingLease : undefined;
  // Approving clean runs puts declining first, as every approval does.
  const approvalDecline = Boolean(lease) && view.actions.includes('cancel-run');
  const evidence = [...(view.before ?? []), ...(view.after ?? [])];
  const reason = bugReason(view.gate);
  return (
    <OverviewSection
      title="Bug"
      inset
      className="tm-bug"
      aside={
        <>
          {recording ? <button type="button" className="tm-osection__link" onClick={onOpenRecording}>Open recording</button> : null}
          {menu.length ? (
            <ActionMenu className="tm-bug__menu" label="More bug actions" tooltip="More actions" side="bottom"
              trigger={<MoreHorizontal size={16} aria-hidden="true" />} items={menu} />
          ) : null}
        </>
      }
    >
      <div className="tm-bug__head">
        <span className="tm-bug__title">{view.title}</span>
        {stateAbove ? null : (
          <span className={`tm-bug__state tm-bug__state--${status.tone}`}>
            {glyph ? <StatusGlyph kind={glyph} /> : null}
            {status.word}
          </span>
        )}
      </div>
      {view.statement ? <p className="tm-bug__statement">{view.statement}</p> : null}
      {!stateAbove && reason && !evidence.includes(reason) ? <p className="tm-bug__fact">{reason}</p> : null}
      {evidence.length ? (
        <ul className="tm-bug__evidence">
          {evidence.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      {view.countsLine ? <p className="tm-bug__meta">{view.countsLine}</p> : null}
      {view.partial ? <p className="tm-bug__notice">{view.partial}</p> : null}
      {view.changedProtectedPaths?.length ? (
        <p className="tm-bug__notice">Setup files changed since the recording: {view.changedProtectedPaths.join(', ')}</p>
      ) : null}
      {view.changedSharedSetup?.length ? (
        <p className="tm-bug__fact">Also changed setup code the app shares: {view.changedSharedSetup.join(', ')}</p>
      ) : null}
      {lease && !nowPanelHoldsBug ? <BugLeaseFacts lease={lease} /> : null}

      {view.screenshotFileIds.length ? (
        <div className="tm-bug__screens">
          {view.screenshotFileIds.slice(0, 2).map((fileId, index) => {
            const alt = index === 0 ? 'The page when the bug was marked' : 'The page in the latest clean run';
            const caption = index === 0 ? 'Recorded' : 'Latest run';
            return (
              <button key={fileId} type="button" className="tm-bug__screen" aria-label={`${caption}: open ${alt.toLowerCase()}`}
                onClick={() => setLightbox({ fileId, alt })}>
                <BugImage taskId={taskId} fileId={fileId} alt="" />
                <span aria-hidden="true">{caption}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {view.version ? (
        <details className="tm-bug__more">
          <summary>
            <DisclosureChevron />
            Checks
            <span className="tm-bug__count">{view.version.checks.length}</span>
          </summary>
          <ul className="tm-bug__checks">
            {view.version.checks.map((check) => (
              <li key={check.id}>
                <span>{check.statement}</span>
                {check.recorded ? <span className="tm-bug__recorded">{check.recorded}</span> : null}
              </li>
            ))}
          </ul>
          {view.scopeLine ? <p className="tm-bug__scope">{view.scopeLine}</p> : null}
          {view.boundaryLine ? <p className="tm-bug__scope">{view.boundaryLine}</p> : null}
        </details>
      ) : null}

      {runs.length ? (
        <details className="tm-bug__more">
          <summary>
            <DisclosureChevron />
            Clean runs
            <span className="tm-bug__count">{Math.max(snapshot.runCount, runs.length)}</span>
          </summary>
          <ul className="tm-bug__runs">
            {runs.map((run) => {
              const runGlyph = statusGlyphFor(run.tone, run.inFlight);
              return (
                <li key={run.id} className="tm-bug__run">
                  <span className="tm-bug__runkind">{run.kind}</span>
                  <span className={`tm-bug__runword tm-bug__state--${run.tone}`}>
                    {runGlyph ? <StatusGlyph kind={runGlyph} /> : null}
                    {run.word}
                  </span>
                  <time className="tm-bug__runtime" dateTime={run.at} title={new Date(run.at).toLocaleString()}>{formatShortAge(run.at)}</time>
                  {run.detail ? <span className="tm-bug__rundetail">{run.detail}</span> : null}
                </li>
              );
            })}
          </ul>
          {snapshot.runCount > runs.length ? <p className="tm-bug__scope">Latest {runs.length} of {snapshot.runCount}</p> : null}
        </details>
      ) : null}

      {view.steps.length ? (
        <details className="tm-bug__more">
          <summary>
            <DisclosureChevron />
            Steps
            <span className="tm-bug__count">{view.steps.length}</span>
          </summary>
          <ol className="tm-bug__steps">
            {view.steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
          </ol>
          {view.version?.protectedPaths.length ? (
            <p className="tm-bug__scope">Kept fixed: {view.version.protectedPaths.join(', ')}</p>
          ) : null}
          {view.version?.envFiles.length ? <p className="tm-bug__scope">Env files: {view.version.envFiles.join(', ')}</p> : null}
        </details>
      ) : null}

      {view.startSendsBug ? <p className="tm-bug__meta">Starting the task sends this bug to the agent with it.</p> : null}
      {!nowPanelHoldsBug && (layout.primary || layout.secondary.length) ? (
        <SlotActions quiet
          decline={approvalDecline ? actions.asSlotAction('cancel-run', view) : undefined}
          primary={layout.primary ? actions.asSlotAction(layout.primary, view) : undefined}
          secondary={layout.secondary.filter((action) => !(approvalDecline && action === 'cancel-run')).map((action) => actions.asSlotAction(action, view))} />
      ) : null}
      {lightbox ? <BugScreenshotDialog taskId={taskId} fileId={lightbox.fileId} alt={lightbox.alt} onClose={() => setLightbox(undefined)} /> : null}
    </OverviewSection>
  );
}

function BugScreenshotDialog({ taskId, fileId, alt, onClose }: { taskId: string; fileId: string; alt: string; onClose(): void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocusBoundary({ dialogRef: panelRef, busy: false, onClose });
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="tm-modal__scrim" onClick={onClose} />
      <div ref={panelRef} className="tm-modal__panel tm-bugshot" tabIndex={-1}>
        <h3 id={titleId}>{alt}</h3>
        <BugImage taskId={taskId} fileId={fileId} alt={alt} className="tm-bugshot__image" />
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Debug's record of the task's bugs: earlier ones the person replaced or removed, with Delete
 * evidence to free their space. The current bug's evidence stays with it.
 */
export function BugEvidencePanel({ taskId, snapshot, onError, refresh }: {
  taskId: string;
  snapshot: BugReplaySnapshot;
  onError(message: string): void;
  refresh(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<BugReplaySnapshot['earlierCases'][number]>();
  const listRef = useRef<HTMLDivElement>(null);
  const deletedRef = useRef(false);
  if (snapshot.earlierCases.length === 0) return null;
  const remove = async (caseId: string) => {
    setBusy(true);
    try {
      await taskManagerApi.deleteBugEvidence({ taskId, caseId });
      // Its row menu is about to go; the list keeps focus instead.
      deletedRef.current = true;
      listRef.current?.focus({ preventScroll: true });
      setConfirming(undefined);
      refresh();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tm-bugearlier" aria-label="Earlier bugs">
      <h3 className="tm-bugearlier__title">Earlier bugs</h3>
      <p className="tm-bugearlier__meta">
        Bug evidence on this machine: {formatAttachmentBytes(snapshot.storage.usedBytes)} of {formatAttachmentBytes(snapshot.storage.limitBytes)}
      </p>
      <div ref={listRef} className="tm-table" tabIndex={-1}>
        <table>
          <thead>
            <tr>
              <th scope="col">Bug</th>
              <th scope="col">Ended</th>
              <th scope="col">When</th>
              <th scope="col" className="tm-table__num">Evidence</th>
              <th scope="col" className="tm-table__actions"><span className="tm-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {snapshot.earlierCases.map((item) => (
              <tr key={item.id}>
                <td className="tm-table__primary tm-bugearlier__name" title={item.title}>{item.title}</td>
                <td className="tm-table__quiet">{item.status === 'REMOVED' ? 'Removed' : 'Replaced'}</td>
                <td className="tm-table__quiet tm-bugearlier__ended">
                  <time dateTime={item.endedAt} title={new Date(item.endedAt).toLocaleString()}>{formatShortAge(item.endedAt)}</time>
                </td>
                <td className="tm-table__num tm-table__quiet">{item.evidenceBytes > 0 ? formatAttachmentBytes(item.evidenceBytes) : 'Deleted'}</td>
                <td className="tm-table__actions">
                  {item.evidenceBytes > 0 ? (
                    <ActionMenu
                      className="tm-table__menu"
                      label={`Actions for ${item.title}`}
                      tooltip="More actions"
                      side="bottom"
                      disabled={busy}
                      trigger={<MoreHorizontal size={16} aria-hidden="true" />}
                      items={[{
                        label: 'Delete evidence…',
                        danger: true,
                        onSelect: () => {
                          deletedRef.current = false;
                          setConfirming(item);
                        }
                      }]}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirming ? (
        <BugConfirmDialog
          title={`Delete the evidence of “${confirming.title}”?`}
          body={`Its recording, screenshots and run logs are deleted (${formatAttachmentBytes(confirming.evidenceBytes)}). The bug stays listed here.`}
          keepLabel="Keep evidence"
          confirmLabel="Delete evidence"
          busyLabel="Deleting…"
          busy={busy}
          returnFocusRef={listRef}
          shouldReturnFocus={() => !deletedRef.current}
          onKeep={() => setConfirming(undefined)}
          onConfirm={() => void remove(confirming.id)} />
      ) : null}
    </section>
  );
}
