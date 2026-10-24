import { useId, useMemo } from 'react';
import { pluralize } from '../model/formatting';
import { stageProgress } from '../model/reviewWalkthrough';
import { DiffStat } from './DiffStat';
import { PendingLabel } from './StableLabel';
import { GeneralBands } from './ReviewBands';
import { GuideFileUnit, GuideStageSection, type GuideScope } from './ReviewGuideStage';
import { GuideAttentionList, GuideByline, GuideInlines } from './ReviewGuideParts';
import type { ReviewModel } from './useReviewModel';

/**
 * The Guide: the walkthrough the review wrote, intent by intent, over the code
 * it read. One scroll of stages: the overview (the account, what deserves
 * attention, and the map of intents), then each stage beside its code. Before a
 * walkthrough, its place, the review that writes it, and the change's files by folder.
 */
export function ReviewGuide({ model }: { model: ReviewModel }) {
  const { guide } = model;
  // Disclosures the person opens in this visit fade in; those open before show still.
  const entries = useMemo(() => new Map(model.ordered.map((entry) => [entry.file.id, entry])), [model.ordered]);
  const { notes } = model;
  const scope: GuideScope = { model, entries, notes };
  if (guide.status === 'loading') return <GuideReading author={guide.author} />;
  if (guide.status !== 'ready' || !guide.model) return <GuideBeforeWalkthrough scope={scope} />;
  const { stages } = guide.model;
  return (
    <div className="tm-review-guide">
      {stages.length > 1 ? <GuideOverview model={model} /> : null}
      {stages.map((stage) => <GuideStageSection key={stage.section} scope={scope} stage={stage} count={stages.length} />)}
    </div>
  );
}

/**
 * The overview: who wrote the walkthrough, its summary quoted, and what
 * deserves attention; beside them the map, one row per intent with its first
 * sentence and its files viewed. Feedback with no place in the change sits
 * under it, framed as the Diff frames it.
 */
function GuideOverview({ model }: { model: ReviewModel }) {
  const { guide, actions } = model;
  const mapLabel = useId();
  const walkthrough = guide.model!;
  return (
    <section className="tm-review-guide__stage tm-review-guide__stage--overview" data-stage="overview" aria-label="Overview">
      <div className="tm-review-guide__column">
        <GuideByline author={guide.author} />
        <blockquote className="tm-review-guide__summary"><GuideInlines parts={walkthrough.summary} /></blockquote>
        {walkthrough.attention.length ? <GuideAttentionList items={walkthrough.attention} actions={actions} /> : null}
      </div>
      <div className="tm-review-guide__code">
        <nav className="tm-review-guide__map" aria-labelledby={mapLabel}>
          <h2 className="tm-review-guide__map-head">
            {/* The map is named by its count; the column's own header is not part of the name. */}
            <span id={mapLabel}>{walkthrough.stages.length} intents</span>
            <span className="tm-review-guide__map-viewed">Viewed</span>
          </h2>
          <ol>
            {walkthrough.stages.map((stage) => {
              const progress = stageProgress(stage, model.viewedIds);
              return (
                <li key={stage.section}>
                  <button type="button" className="tm-review-guide__map-row" data-done={progress.viewed === progress.total ? '' : undefined}
                    aria-label={`${stage.section + 1}. ${stage.title}, ${progress.viewed} of ${progress.total} viewed`} onClick={() => actions.showStage(stage.section)}>
                    <span className="tm-review-guide__map-number" aria-hidden="true">{stage.section + 1}</span>
                    <span className="tm-review-guide__map-title">{stage.title}</span>
                    <span className="tm-review-guide__map-progress">{progress.viewed}/{progress.total}</span>
                    {stage.lead.length ? <span className="tm-review-guide__map-lead"><GuideInlines parts={stage.lead} /></span> : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <GuideOutside guide={guide} />
      </div>
    </section>
  );
}

/**
 * Before a walkthrough, the column holds its place: the byline, then what the
 * change is from facts alone and the review that writes it; while a review
 * writes it, when it comes, the review's latest step and Stop; when none could
 * be kept, why, and the review again. Beside it, the change's files by folder,
 * each folded to its head, after any feedback with no place in them. Nothing
 * runs on the code until the person asks.
 */
function GuideBeforeWalkthrough({ scope }: { scope: GuideScope }) {
  const { model } = scope;
  const { guide, props } = model;
  const reasonId = useId();
  const run = props.runReview;
  const reviewing = guide.status === 'running' ? props.reviewing : undefined;
  const totals = useMemo(() => model.ordered.reduce(
    (sum, { file }) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 }
  ), [model.ordered]);
  return (
    <div className="tm-review-guide">
      <section className="tm-review-guide__stage tm-review-guide__stage--folders" aria-label="The change by folder">
        <div className="tm-review-guide__column">
          <GuideByline author={reviewing?.agent} />
          <h2 className="tm-review-guide__title tm-review-guide__title--pending">
            {guide.status === 'running' ? 'Arrives with the review' : guide.reason ?? 'Not written yet'}
          </h2>
          {guide.status === 'running' ? (
            <>
              {reviewing?.activity ? <p className="tm-review-guide__activity" title={reviewing.activity}>{reviewing.activity}</p> : null}
              {reviewing?.onStop ? (
                <div className="tm-review-guide__step">
                  <button type="button" className="ghost-button button--sm" disabled={reviewing.stopping} data-pending={reviewing.stopping || undefined} onClick={reviewing.onStop}>
                    <PendingLabel label="Stop review" pendingLabel="Stopping…" pending={Boolean(reviewing.stopping)} />
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {/* Without files, why: the capture is still read, could not be read, or holds none. */}
              {model.ordered.length === 0 && model.emptyText ? <p className="tm-review-guide__facts">{model.emptyText}</p> : (
                <p className="tm-review-guide__facts">
                  <span>{pluralize(model.ordered.length, 'file')} changed</span>
                  <DiffStat additions={totals.additions} deletions={totals.deletions} />
                </p>
              )}
              {run ? (
                <div className="tm-review-guide__step">
                  <button type="button" className="primary-button button--sm" disabled={Boolean(run.disabledReason) || run.busy}
                    data-pending={run.starting || undefined}
                    aria-describedby={run.disabledReason && !run.starting ? reasonId : undefined} onClick={run.onRun}>
                    <PendingLabel label={run.label} pendingLabel="Starting…" pending={Boolean(run.starting)} />
                  </button>
                  {run.disabledReason && !run.starting ? <span id={reasonId} className="tm-review-guide__reason">{run.disabledReason}</span> : null}
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="tm-review-guide__code">
          <GeneralBands findings={guide.outside.findings} discussions={guide.outside.discussions} />
          {guide.folders.map(({ folder, fileIds }) => (
            <section key={folder} className="tm-review-guide__folder" aria-label={folder || 'Top level'}>
              {folder ? <h3 className="tm-review-guide__folder-name">{folder}</h3> : null}
              {fileIds.map((fileId) => <GuideFileUnit key={fileId} scope={scope} fileId={fileId} />)}
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

/** While a walkthrough is read: its byline at once, and its summary and first files holding their places. */
function GuideReading({ author }: { author?: string }) {
  return (
    <div className="tm-review-guide" aria-busy="true">
      <section className="tm-review-guide__stage" aria-label="Reading the walkthrough">
        <div className="tm-review-guide__column">
          <GuideByline author={author} />
          <span className="tm-review-guide__placeholder" />
          <span className="tm-review-guide__placeholder" />
          <span className="tm-review-guide__placeholder" />
        </div>
        <div className="tm-review-guide__code">
          <span className="tm-review-guide__placeholder tm-review-guide__placeholder--file" />
          <span className="tm-review-guide__placeholder tm-review-guide__placeholder--file" />
          <span className="tm-review-guide__placeholder tm-review-guide__placeholder--file" />
        </div>
      </section>
    </div>
  );
}

/** Feedback with no place in the code the Guide reads, framed as the Diff frames it. */
function GuideOutside({ guide }: { guide: ReviewModel['guide'] }) {
  const { findings, discussions } = guide.outside;
  if (!findings.length && !discussions.length) return null;
  return (
    <div className="tm-review-guide__outside">
      <h3 className="tm-review-guide__label">Outside the change</h3>
      <GeneralBands findings={findings} discussions={discussions} label="Outside the change" />
    </div>
  );
}
