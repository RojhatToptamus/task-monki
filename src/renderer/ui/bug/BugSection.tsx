import { useRef, useState, type RefObject } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { BugCaseAction, BugCaseView, BugCheckResult, BugReplayGateProjection, BugReplaySnapshot } from '../../../shared/bugReplay';
import { DEFAULT_BUG_CASE_ENVIRONMENT } from '../../../shared/bugReplay';
import { bugReason } from '../../../shared/bugReplayClaims';
import { taskManagerApi } from '../../api/taskManagerClient';
import {
  bugActionLabel,
  bugActionPendingLabel,
  bugGateOf,
  bugReplaysSummary,
  bugResultsTable,
  bugRunRows,
  describeBugStatus,
  formatDuration,
  layoutBugActions
} from '../../model/bugReplay';
import { formatAttachmentBytes } from '../../model/taskAttachmentDraft';
import { formatShortAge } from '../../model/timeAgo';
import { ActionMenu } from '../ActionMenu';
import { DisclosureChevron } from '../DisclosureChevron';
import { StatusGlyph, statusGlyphFor } from '../StatusBadge';
import { DecisionSlot, OverviewSection, SlotActions, SlotContent, type SlotAction } from '../TaskOverview';
import { PreviewSecretDialog } from '../preview/PreviewSecretDialog';
import { BugConfirmDialog } from './BugConfirmDialog';
import { BugExpectationsDrawer } from './BugExpectationsDrawer';
import { BugLeaseFacts } from './BugLeaseBlock';
import { BugRunDrawer, ResultMark } from './BugRunDrawer';
import { BugCompareDialog, BugPicture, shotCaption, type BugShotSide } from './BugShots';
import { BugStepIcon } from './BugStepIcon';
import { useArrivals } from '../arrivals';
import { Presence } from '../presence';

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
  const [editing, setEditing] = useState(false);
  // A dialog gives focus back to what opened it: the menu's trigger for a menu item (the item is
  // gone once the menu closes), else the button itself.
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
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
  const perform = (action: BugCaseAction, from: 'menu' | 'button' = 'button') => {
    const gate = snapshot?.activeCase?.gate;
    setOpener(from === 'menu' ? menuTriggerRef.current : document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
      case 'always-allow-runs': {
        // Approving names exactly what the sheet states, so nothing else is approved or kept.
        const approvalDigest = snapshot?.pendingLease?.approvalDigest;
        return approvalDigest
          ? void run(action, () => taskManagerApi.allowBugReplayRuns({ taskId, approvalDigest, keep: action === 'always-allow-runs' }))
          : undefined;
      }
      case 'unlock-secrets':
        return setUnlocking(true);
      case 'cancel-run':
        return gate?.activeRun ? void run(action, () => taskManagerApi.cancelBugReplayRun({ taskId, runId: gate.activeRun!.runId })) : undefined;
      case 'remove':
        return setConfirmRemove(true);
      case 'edit-expectations':
        return setEditing(true);
      default:
        return void run(action, () => taskManagerApi.applyBugCaseAction({ taskId, action }));
    }
  };
  const dialogs = (
    <>
      <Presence>{confirmRemove && snapshot?.activeCase ? (
        <BugConfirmDialog
          title={`Remove “${snapshot.activeCase.title}”?`}
          body="Task Monki stops replaying it and the review no longer shows it. Its recording stays in Debug, under Earlier bugs."
          keepLabel="Keep bug"
          confirmLabel="Remove bug"
          busyLabel="Removing…"
          busy={busy === 'remove'}
          returnFocus={opener}
          returnFocusRef={host.returnFocusRef}
          onKeep={() => setConfirmRemove(false)}
          onConfirm={() => void run('remove', async () => {
            await taskManagerApi.removeBug({ taskId });
            setConfirmRemove(false);
          })} />
      ) : null}</Presence>
      {unlocking ? (
        <PreviewSecretDialog references={[]} inPreview={false} onClose={() => setUnlocking(false)}
          onSaved={() => {
            setUnlocking(false);
            refresh();
          }} />
      ) : null}
      <Presence>{editing && snapshot?.activeCase?.version ? (
        // Keyed by the version it edits: a version saved elsewhere opens a fresh editor.
        <BugExpectationsDrawer key={snapshot.activeCase.version.id} taskId={taskId} version={snapshot.activeCase.version}
          returnFocus={opener}
          returnFocusRef={host.returnFocusRef}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }} />
      ) : null}</Presence>
    </>
  );
  /** Why an offered action cannot run right now: the task's own pause, or the bug's reason. */
  const reasonFor = (action: BugCaseAction, view: BugCaseView): string | undefined =>
    (action === 'send-to-agent' ? host.blockedReason : undefined) ?? view.unavailable?.[action];
  const asSlotAction = (action: BugCaseAction, view: BugCaseView): SlotAction => {
    const reason = reasonFor(action, view);
    return {
      label: bugActionLabel(action, view),
      pendingLabel: bugActionPendingLabel(action),
      pending: busy === action,
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
      onSelect: () => perform(action, 'menu')
    };
  };
  return { busy, perform, dialogs, asSlotAction, asMenuItem, menuTriggerRef, modalOpen: confirmRemove || unlocking || editing };
}

/**
 * The Now panel when the bug holds the next step: the state, the one fact that drives the step,
 * and its actions; the Bug section below names the bug. Approving replays states what waits on
 * it in one line; what will run sits under Details, read before anything runs. Declining comes
 * first, as every approval does, then keeping the approval for the repository, then approving
 * for now.
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
  const reason = bugReason(view.gate);
  const detail = approval ? waitingLine(snapshot) : reason ?? bugReplaysSummary(view.gate).join(', ');
  const decline = approval && view.actions.includes('cancel-run') ? actions.asSlotAction('cancel-run', view) : undefined;
  const secondary = layout.secondary.filter((action) => !(decline && action === 'cancel-run'));
  return (
    <DecisionSlot>
      <SlotContent
        headline={status.word}
        detail={detail || undefined}
        decline={decline}
        primary={layout.primary ? actions.asSlotAction(layout.primary, view) : undefined}
        secondary={secondary.map((action) => actions.asSlotAction(action, view))}
      >
        {lease ? (
          <details className="tm-bug__details">
            <summary>
              <DisclosureChevron />
              What runs
            </summary>
            <BugLeaseFacts lease={lease} />
          </details>
        ) : null}
      </SlotContent>
    </DecisionSlot>
  );
}

/** What waits on approval, by what the replays will check: "2 replays wait to check the fix". */
function waitingLine(snapshot: BugReplaySnapshot): string {
  const waiting = snapshot.runs.filter((run) => run.state === 'WAITING' && run.waitingFor === 'APPROVAL');
  const count = Math.max(1, waiting.length);
  const fix = waiting.some((run) => run.kind === 'CANDIDATE');
  const purpose = fix ? 'check the fix' : 'reproduce the bug';
  return count === 1 ? `1 replay waits to ${purpose}` : `${count} replays wait to ${purpose}`;
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
 * The task's bug on the Overview, verdict first: its name and state, the page before the fix
 * and after it framed on the checked element, what each expectation showed on either side, then
 * the replays behind it (each opens) and the steps. When the Now panel holds the bug's step, the
 * section keeps only the record.
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
  const [compare, setCompare] = useState<BugShotSide>();
  const [openRun, setOpenRun] = useState<string>();
  const runRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const arrivedRun = useArrivals(snapshot.runs.map((run) => run.id));
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
  const runs = bugRunRows(snapshot.runs, view.version?.id);
  const lease = view.gate.activeRun?.waitingFor === 'APPROVAL' ? snapshot.pendingLease : undefined;
  // Approving replays puts declining first, as every approval does.
  const approvalDecline = Boolean(lease) && view.actions.includes('cancel-run');
  const reason = bugReason(view.gate);
  const results = bugResultsTable(view);
  const summary = bugReplaysSummary(view.gate);
  const viewport = DEFAULT_BUG_CASE_ENVIRONMENT.viewport;
  const shots = view.shots;
  const run = openRun ? snapshot.runs.find((candidate) => candidate.id === openRun) : undefined;
  const keptFixed = view.version?.protectedPaths ?? [];
  return (
    <OverviewSection
      title="Bug"
      inset
      className="tm-bug"
      aside={
        <>
          {recording ? <button type="button" className="tm-osection__link" onClick={onOpenRecording}>Open recording</button> : null}
          {menu.length ? (
            <ActionMenu className="tm-bug__menu" label="More bug actions" tooltip="More actions" side="bottom" triggerRef={actions.menuTriggerRef}
              trigger={<MoreHorizontal size={13} aria-hidden="true" />} items={menu} />
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
      {!stateAbove && reason ? <p className="tm-bug__fact">{reason}</p> : null}
      {view.partial ? <p className="tm-notice" data-tone="waiting">{view.partial}</p> : null}
      {view.changedProtectedPaths?.length ? (
        <p className="tm-notice" data-tone="waiting">Setup files changed since the recording: {view.changedProtectedPaths.join(', ')}</p>
      ) : null}
      {view.changedSharedSetup?.length ? (
        <p className="tm-bug__fact">Also changed setup code the app shares: {view.changedSharedSetup.join(', ')}</p>
      ) : null}
      {lease && !nowPanelHoldsBug ? <BugLeaseFacts lease={lease} /> : null}

      {shots.before || shots.after ? (
        <div className="tm-bug__pair">
          {(['before', 'after'] as const).map((side) => {
            const shot = shots[side];
            if (!shot) return null;
            const caption = shotCaption(side, shot);
            return (
              <button key={side} type="button" className="tm-bug__shot" aria-label={`${caption.name}: open the page`} onClick={() => setCompare(side)}>
                <BugPicture taskId={taskId} shot={shot} viewport={viewport} aspect={2} label="" />
                <span className="tm-bug__caption" aria-hidden="true">
                  <span className="tm-bug__captionname">{caption.name}</span>
                  <time dateTime={caption.at}>{formatShortAge(caption.at)}</time>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {results ? (
        <div className="tm-table tm-bugtable">
          <table>
            <thead>
              <tr>
                <th scope="col">Expected</th>
                <th scope="col" className="tm-bugtable__side">Before</th>
                {results.hasAfter ? (
                  <th scope="col" className="tm-bugtable__side">
                    After{results.afterEarlier ? <span className="tm-bugtable__earlier">earlier code</span> : null}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {results.rows.map((row) => (
                <tr key={row.id}>
                  <td className="tm-bugtable__statement">{row.statement}</td>
                  <td className="tm-bugtable__side"><ResultCell result={row.before} quiet /></td>
                  {results.hasAfter ? <td className="tm-bugtable__side"><ResultCell result={row.after} quiet={results.afterEarlier} /></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {runs.length ? (
        <details className="tm-bug__more">
          <summary>
            <DisclosureChevron />
            Replays
            {summary.map((part) => <span key={part} className="tm-bug__summary">{part}</span>)}
          </summary>
          <div className="tm-table tm-bugruns">
            <table>
              <thead>
                <tr>
                  <th scope="col">Replay</th>
                  <th scope="col">Result</th>
                  <th scope="col" className="tm-table__num">Took</th>
                  <th scope="col" className="tm-table__num">When</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((row) => {
                  const runGlyph = statusGlyphFor(row.tone, row.inFlight);
                  return (
                    <tr key={row.id} className="tm-bugruns__row" data-arrived={arrivedRun(row.id) ? '' : undefined}>
                      <td className="tm-table__primary">
                        {/* The row opens its replay; the button names it for the keyboard and stretches over the row. */}
                        <button ref={(element) => {
                          if (element) runRowRefs.current.set(row.id, element);
                          else runRowRefs.current.delete(row.id);
                        }}
                        type="button" className="tm-bugruns__open" onClick={() => setOpenRun(row.id)}>
                          {row.kind}
                        </button>
                        {row.earlier ? <span className="tm-bugruns__earlier">earlier expectations</span> : null}
                      </td>
                      <td>
                        <span className={`tm-bug__runword tm-bug__state--${row.tone}`}>
                          {runGlyph ? <StatusGlyph kind={runGlyph} /> : null}
                          {row.word}
                        </span>
                      </td>
                      <td className="tm-table__num tm-table__quiet">{row.durationMs !== undefined ? formatDuration(row.durationMs) : ''}</td>
                      <td className="tm-table__num tm-table__quiet">
                        <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>{formatShortAge(row.at)}</time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
          <ol className="tm-bugsteps">
            {view.steps.map((step, index) => (
              <li key={`${index}:${step.text}`} className="tm-bugstep" data-kind={step.kind}>
                <span className="tm-bugstep__number" aria-hidden="true">{index + 1}</span>
                <BugStepIcon kind={step.kind} />
                <span className="tm-bugstep__text" title={step.text}>{step.text}</span>
              </li>
            ))}
          </ol>
          {keptFixed.length ? <p className="tm-bug__scope">Setup kept as recorded: {keptFixed.join(', ')}</p> : null}
          {view.version?.envFiles.length ? <p className="tm-bug__scope">Env files: {view.version.envFiles.join(', ')}</p> : null}
        </details>
      ) : null}

      {!nowPanelHoldsBug && (layout.primary || layout.secondary.length) ? (
        <SlotActions quiet
          decline={approvalDecline ? actions.asSlotAction('cancel-run', view) : undefined}
          primary={layout.primary ? actions.asSlotAction(layout.primary, view) : undefined}
          secondary={layout.secondary.filter((action) => !(approvalDecline && action === 'cancel-run')).map((action) => actions.asSlotAction(action, view))} />
      ) : null}
      <Presence>{compare ? <BugCompareDialog taskId={taskId} title={view.title} shots={shots} viewport={viewport} initial={compare} onClose={() => setCompare(undefined)} /> : null}</Presence>
      <Presence>{run ? (
        <BugRunDrawer taskId={taskId} run={run} view={view} viewport={viewport}
          onClose={() => {
            const trigger = runRowRefs.current.get(run.id);
            setOpenRun(undefined);
            trigger?.focus({ preventScroll: true });
          }} />
      ) : null}</Presence>
    </OverviewSection>
  );
}

/** One side of an expectation: whether it held, by its mark, and what was seen. */
function ResultCell({ result, quiet }: { result: BugCheckResult | undefined; quiet: boolean }) {
  if (!result) return <span className="tm-bugtable__none">Not run</span>;
  const reload = result.afterReload;
  return (
    <span className="tm-bugtable__cell">
      <ResultMark held={result.held && (reload?.held ?? true)} quiet={quiet} />
      <span className="tm-bugtable__value" title={result.value}>{result.value ?? (result.held ? 'Held' : 'Did not hold')}</span>
      {reload && !reload.held ? <span className="tm-bugtable__reload">after reload {reload.value ?? 'did not hold'}</span> : null}
    </span>
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
      <Presence>{confirming ? (
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
      ) : null}</Presence>
    </section>
  );
}
