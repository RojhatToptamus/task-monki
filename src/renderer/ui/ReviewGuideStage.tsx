import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { DiffFile } from '../model/diffEvidence';
import { pluralize } from '../model/formatting';
import { stageProgress, type GuideFile, type GuideRun, type GuideStage } from '../model/reviewWalkthrough';
import type { OrderedReviewFile } from '../model/reviewOrder';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { GeneralBands } from './ReviewBands';
import { ReviewFileList, ReviewFileRow } from './ReviewFileRow';
import { ReviewFileUnit, fileUnitProps, type ReviewFileSegment } from './ReviewFileUnit';
import { GuideAttentionList, GuideByline, GuideExplanation, GuideInlines, GuideRunLabel } from './ReviewGuideParts';
import { Tooltip } from './Tooltip';
import { AgentMark } from './UiIcons';
import type { ReviewModel } from './useReviewModel';

/** A stage lists this many files at most; the rest are one row, "N more files", which never grows the column. */
const LISTED_FILES = 10;

/** What a stage's parts share: the files by id with their place in the reading order, and what is said about each. */
export interface GuideScope {
  model: ReviewModel;
  entries: ReadonlyMap<string, OrderedReviewFile>;
  notes: ReadonlyMap<string, { count: number; blocking: boolean }>;
}

/**
 * One stage: a sticky column with the intent's title, its place among the
 * stages (the menu of stages), the explanation with its terms, what deserves
 * attention and the stage's files; beside it, the code of the files that hold
 * its key changes or open feedback, then the rest behind one row. Stacked, the
 * column is a block above the code, and a line holds the stage and the file
 * being read once the block has scrolled away.
 * A one-intent change is one stage: the account and the summary lead it, and
 * it needs no title, counter or list of one file.
 */
export function GuideStageSection({ scope, stage, count }: { scope: GuideScope; stage: GuideStage; count: number }) {
  const { model } = scope;
  const { actions, guide } = model;
  const single = count === 1;
  const titleId = useId();
  const columnRef = useRef<HTMLDivElement>(null);
  return (
    <section className="tm-review-guide__stage" data-stage={stage.section} aria-labelledby={single ? undefined : titleId} aria-label={single ? 'Walkthrough' : undefined}>
      <div ref={columnRef} className="tm-review-guide__column">
        {single ? (
          <>
            <GuideByline author={guide.author} />
            <blockquote className="tm-review-guide__summary"><GuideInlines parts={guide.model!.summary} /></blockquote>
          </>
        ) : (
          <>
            <header className="tm-review-guide__head">
              <h2 id={titleId} className="tm-review-guide__title">{stage.title}</h2>
              {model.props.onAskAboutStage ? (
                <Tooltip label="Ask about this intent">
                  <button type="button" className="tm-iconbtn tm-review__mini tm-review-guide__ask" aria-label="Ask about this intent" onClick={() => actions.askAboutStage(stage.section)}>
                    <AgentMark />
                  </button>
                </Tooltip>
              ) : null}
            </header>
            <div className="tm-review-guide__meta">
              <StageMenu model={model} stage={stage} count={count} />
              <FilesMenu model={model} stage={stage} />
            </div>
          </>
        )}
        {stage.explanation.length ? <GuideExplanation spans={stage.explanation} actions={actions} /> : null}
        {stage.attention.length ? <GuideAttentionList items={stage.attention} actions={actions} /> : null}
        {!single || stage.files.length > 1 ? <GuideFileList scope={scope} stage={stage} /> : null}
      </div>
      {single ? null : <StageLine model={model} stage={stage} count={count} block={columnRef} />}
      <div className="tm-review-guide__code">
        {/* With no overview, what is said about the whole change leads the code. */}
        {single ? <GeneralBands findings={guide.outside.findings} discussions={guide.outside.discussions} /> : null}
        <GuideStageFiles scope={scope} stage={stage} />
      </div>
    </section>
  );
}

/** The counter, "3/8": the menu of stages, each with its files viewed, the overview first. */
function StageMenu({ model, stage, count }: { model: ReviewModel; stage: GuideStage; count: number }) {
  const { actions } = model;
  const items: ActionMenuItem[] = [
    { id: 'overview', lead: '', label: 'Overview', onSelect: () => actions.showStage('overview') },
    ...model.guide.model!.stages.map((candidate) => {
      const progress = stageProgress(candidate, model.viewedIds);
      return {
        id: String(candidate.section),
        lead: String(candidate.section + 1),
        label: candidate.title,
        meta: `${progress.viewed}/${progress.total}`,
        current: candidate === stage,
        separated: candidate.section === 0,
        onSelect: () => actions.showStage(candidate.section)
      };
    })
  ];
  return (
    <ActionMenu
      className="tm-review-guide__stages"
      label={`Intent ${stage.section + 1} of ${count}`}
      side="bottom"
      align="start"
      wide
      trigger={<><span>{stage.section + 1}/{count}</span><ChevronDown size={13} aria-hidden="true" /></>}
      items={items}
    />
  );
}

/** Stacked, the stage's files fold into a menu on its meta row: the file being read of them all. */
function FilesMenu({ model, stage }: { model: ReviewModel; stage: GuideStage }) {
  const { actions, activeFileId } = model;
  const position = stage.files.findIndex((file) => file.file.id === activeFileId);
  const label = position < 0 ? pluralize(stage.files.length, 'file') : `File ${position + 1} of ${stage.files.length}`;
  const items: ActionMenuItem[] = stage.files.map(({ file }) => {
    const { folder, name } = pathParts(file);
    return { id: file.id, label: name, ...(folder ? { description: folder } : {}), current: file.id === activeFileId, onSelect: () => actions.showFile(file.id, { open: true }) };
  });
  return (
    <ActionMenu
      className="tm-review-guide__files-menu"
      label={label}
      side="bottom"
      align="start"
      trigger={<><span>{label}</span><ChevronDown size={13} aria-hidden="true" /></>}
      items={items}
    />
  );
}

/**
 * Every file of the stage as the navigator's rows, those the code shows first,
 * the file being read under the plane that slides. A file among the stage's
 * others opens them and goes there. Past the first few, one row for the rest,
 * which goes to them and holds the plane while one of them is read.
 */
function GuideFileList({ scope, stage }: { scope: GuideScope; stage: GuideStage }) {
  const { model, notes } = scope;
  const { actions, activeFileId } = model;
  const showFile = useCallback((fileId: string) => actions.showFile(fileId, { open: true }), [actions]);
  const files = [...stage.shown, ...stage.folded];
  const listed = files.slice(0, LISTED_FILES);
  const rest = files.slice(LISTED_FILES);
  const restCurrent = Boolean(activeFileId && rest.includes(activeFileId));
  const filesById = new Map(stage.files.map((file) => [file.file.id, file.file]));
  return (
    <div className="tm-review-guide__files" role="group" aria-label="Files">
      <ReviewFileList current={restCurrent ? 'rest' : activeFileId}>
        {listed.map((fileId) => (
          <ReviewFileRow
            key={fileId}
            file={filesById.get(fileId)!}
            current={activeFileId === fileId}
            viewed={model.viewedIds.has(fileId)}
            feedback={notes.get(fileId)?.count ?? 0}
            blocking={notes.get(fileId)?.blocking ?? false}
            onSelect={showFile}
          />
        ))}
        {rest.length ? (
          <button
            type="button"
            className="tm-review__index-file tm-review-guide__rest"
            aria-current={restCurrent ? 'true' : undefined}
            onClick={() => showFile(rest[0]!)}
          >
            <span className="tm-review__index-path">{pluralize(rest.length, 'more file')}</span>
          </button>
        ) : null}
      </ReviewFileList>
    </div>
  );
}

/**
 * Stacked, a 28px line holds the stage, its place and the file being read once
 * the stage's block has scrolled away. It takes no room in the flow, and the
 * file heads stick under it.
 */
function StageLine({ model, stage, count, block }: { model: ReviewModel; stage: GuideStage; count: number; block: RefObject<HTMLElement | null> }) {
  const [shown, setShown] = useState(false);
  const { actions } = model;
  useEffect(() => {
    const element = block.current;
    const root = actions.scroller();
    if (!element || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setShown(!entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0));
    }, { root });
    observer.observe(element);
    return () => observer.disconnect();
  }, [actions, block]);
  const reading = stage.files.find((file) => file.file.id === model.activeFileId);
  return (
    <div className="tm-review-guide__line-anchor" aria-hidden="true">
      <div className="tm-review-guide__line" data-shown={shown ? '' : undefined}>
        <span className="tm-review-guide__line-title">{stage.title}</span>
        <span className="tm-review-guide__line-place">{stage.section + 1}/{count}</span>
        {reading ? <span className="tm-review-guide__line-file">{pathParts(reading.file).name}</span> : null}
      </div>
    </div>
  );
}

/**
 * A stage's code: its shown files, then the rest behind one row that opens them
 * as folded files. What the press opens fades in once; open before, it is still.
 */
function GuideStageFiles({ scope, stage }: { scope: GuideScope; stage: GuideStage }) {
  const { model } = scope;
  const open = model.guide.openGroups.has(stage.section);
  const [entering, setEntering] = useState(false);
  return (
    <>
      {stage.shown.map((fileId) => <GuideFileUnit key={fileId} scope={scope} fileId={fileId} />)}
      {stage.folded.length ? (
        <>
          <button
            type="button"
            className="tm-review-guide__more-files"
            aria-expanded={open}
            onClick={() => {
              setEntering(!open);
              model.actions.toggleStageFiles(stage.section);
            }}
          >
            <ChevronRight size={13} aria-hidden="true" />
            <span>{pluralize(stage.folded.length, 'more file')}</span>
          </button>
          {open ? (
            <div className="tm-review-guide__group" data-entering={entering ? '' : undefined}
              onAnimationEnd={(event) => { if (event.target === event.currentTarget) setEntering(false); }}>
              {stage.folded.map((fileId) => <GuideFileUnit key={fileId} scope={scope} fileId={fileId} />)}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * A file of the Guide: the Diff's own file unit. A shown file holds its key
 * changes first, then the lines open feedback is about, and one row for the
 * rest that opens below them, so nothing above moves. Before a walkthrough, and
 * among a stage's other files, it is the whole file, folded to its head.
 */
export function GuideFileUnit({ scope, fileId }: { scope: GuideScope; fileId: string }) {
  const { model, entries } = scope;
  const { actions } = model;
  const entry = entries.get(fileId);
  const guideFile: GuideFile | undefined = model.guide.model?.files.get(fileId)?.file;
  const moreOpen = model.guide.openMore.has(fileId);
  // The rest fades in once, as it is opened; rendered again later, as the view comes back to it, it is still.
  const [entering, setEntering] = useState(false);
  const segments = useMemo(() => (guideFile?.shown
    ? [...guideFile.runs.map((run) => segmentOf(run)), ...(moreOpen ? guideFile.rest.map((run) => segmentOf(run, entering ? () => setEntering(false) : undefined)) : [])]
    : undefined), [entering, guideFile, moreOpen]);
  const more = useMemo(() => (guideFile?.shown && guideFile.more && !moreOpen ? {
    label: guideFile.more,
    onOpen: () => {
      setEntering(true);
      actions.openMoreChanges(fileId);
    }
  } : undefined), [actions, fileId, guideFile, moreOpen]);
  if (!entry) return null;
  return <ReviewFileUnit {...fileUnitProps(model, entry)} plain={entry.file.status === 'added'} segments={segments} more={more} />;
}

function segmentOf(run: GuideRun, entered?: () => void): ReviewFileSegment {
  return { blockId: run.blockId, start: run.start, end: run.end, caption: <GuideRunLabel label={run.label} />, entered };
}

function pathParts(file: DiffFile): { folder: string; name: string } {
  const at = file.path.lastIndexOf('/');
  return { folder: at < 0 ? '' : file.path.slice(0, at), name: file.path.slice(at + 1) };
}
