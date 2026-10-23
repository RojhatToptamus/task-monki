import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isBlockingFinding } from '../../shared/contracts';
import { nextUnviewed, stepFeedback, stepThrough, type FeedbackRef } from '../model/reviewNavigation';
import { isExpandShortcut } from './ExpandToggle';
import type { ReviewModel } from './useReviewModel';

/**
 * The Review keys, for the tab's section: J/K files, [ and ] the Guide's stages,
 * N/P open findings and discussions, V viewed and on, G the other mode at the
 * same place, D/A/F the focused finding, R the focused discussion's reply, C
 * the selected lines, Escape the lines a move chose. The order they step
 * through is the mode's; a held key repeating arrives at once.
 */
export function useReviewKeys(model: ReviewModel) {
  const { actions, props, activeFileId, focusedFile, selection, commentDraft, sheetOpen, mode, fileIds: files } = model;
  const focusedFinding = props.findings.find((finding) => finding.id === model.focusedFindingId);
  const focusedDiscussion = model.discussions.find((discussion) => discussion.id === model.focusedDiscussionId);
  const canSubmit = Boolean(props.requestChanges && !props.requestChanges.disabledReason && !props.requestChanges.busy && props.plan.queued);
  const stages = model.guide.model?.stages;

  return (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"], [role="menu"]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (sheetOpen && canSubmit) actions.submitRequest();
      else actions.setSheetOpen(true);
      return;
    }
    if (isExpandShortcut(event)) {
      const fileId = focusedFile ? undefined : activeFileId ?? files[0];
      if (mode === 'diff' && (focusedFile || fileId)) { event.preventDefault(); actions.showFullScreen(fileId, false); }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const instant = event.repeat;
    const key = event.key.toLowerCase();
    if (key === 'j' || key === 'k') {
      const next = stepThrough(files, activeFileId, key === 'j' ? 1 : -1);
      if (next) { event.preventDefault(); actions.showFile(next, { instant }); }
    } else if (key === '[' || key === ']') {
      if (mode !== 'guide' || !stages?.length) return;
      event.preventDefault();
      // The overview leads when there is more than one stage.
      const order = [...(stages.length > 1 ? ['overview'] : []), ...stages.map((stage) => String(stage.section))];
      const current = model.activeStage === undefined ? undefined : String(model.activeStage);
      const scroller = actions.scroller();
      const top = current === undefined ? undefined : scroller?.querySelector(`[data-stage="${current}"]`)?.getBoundingClientRect().top;
      // [ reads the stage under way from its start before the one before it.
      const back = key === '[' && current !== undefined && scroller && top !== undefined && top < scroller.getBoundingClientRect().top - 4;
      const next = back ? current : stepThrough(order, current, key === ']' ? 1 : -1);
      if (next !== undefined) actions.showStage(next === 'overview' ? 'overview' : Number(next), { instant });
    } else if (key === 'g') {
      event.preventDefault();
      actions.setMode(mode === 'guide' ? 'diff' : 'guide');
    } else if (key === 'n' || key === 'p') {
      const current: FeedbackRef | undefined = model.focusedFindingId ? { kind: 'finding', id: model.focusedFindingId }
        : model.focusedDiscussionId ? { kind: 'discussion', id: model.focusedDiscussionId } : undefined;
      const next = stepFeedback(model.feedback, current, key === 'n' ? 1 : -1);
      if (next) {
        event.preventDefault();
        if (next.kind === 'finding') actions.showFinding(next.id, { instant });
        else actions.showDiscussion(next.id, { instant });
      }
    } else if (key === 'v') {
      const fileId = activeFileId ?? files[0];
      if (!fileId || !files.includes(fileId)) return;
      event.preventDefault();
      const nowViewed = !model.viewedIds.has(fileId);
      actions.setFileViewed(fileId, nowViewed);
      const next = nowViewed ? nextUnviewed(files, fileId, new Set([...model.viewedIds, fileId])) : undefined;
      if (next) actions.showFile(next, { instant });
    } else if (key === 'd' && focusedFinding?.state === 'OPEN' && model.findingsActionable && props.onDismissFinding) {
      event.preventDefault();
      actions.setDismissing(focusedFinding.id);
    } else if (key === 'a' && focusedFinding && model.findingsActionable && props.onAskAboutFinding) {
      event.preventDefault();
      actions.askAboutFinding(focusedFinding.id);
    } else if (key === 'r' && focusedDiscussion && !focusedDiscussion.resolved && props.onReplyToDiscussion) {
      // The reply row is under every open discussion; R puts the caret in it.
      if (actions.focusReply(focusedDiscussion.id)) event.preventDefault();
    } else if (key === 'f' && focusedDiscussion && !focusedDiscussion.resolved && model.canComment) {
      event.preventDefault();
      actions.toggleDiscussion(focusedDiscussion.id);
    } else if (key === 'f' && focusedFinding?.state === 'OPEN' && !isBlockingFinding(focusedFinding) && model.findingsActionable) {
      event.preventDefault();
      actions.toggleIncluded(focusedFinding.id);
    } else if (key === 'c' && selection && model.canComment) {
      event.preventDefault();
      actions.commentOnSelection();
    } else if (key === 'escape' && selection && !commentDraft) {
      actions.clearSelection();
    } else if (key === 'escape' && focusedFile && !sheetOpen) {
      event.preventDefault();
      actions.showFullScreen(undefined, false);
    } else if (key === 'escape' && actions.clearMarks()) {
      event.preventDefault();
    }
  };
}
