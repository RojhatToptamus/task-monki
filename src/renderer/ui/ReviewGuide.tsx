import { useId, useMemo, useState } from 'react';
import { stageProgress } from '../model/reviewWalkthrough';
import { ReviewBands } from './ReviewBands';
import { useFileNotes } from './ReviewFileRow';
import { GuideFileUnit, GuideStageSection, type GuideScope } from './ReviewGuideStage';
import { GuideAttentionList, GuideByline, GuideInlines } from './ReviewGuideParts';
import { StatusGlyph } from './StatusBadge';
import type { ReviewModel } from './useReviewModel';

/**
 * The Guide: the walkthrough the review wrote, intent by intent, over the code
 * it read. One scroll of stages: the overview (the account, what deserves
 * attention, and the map of intents), then each stage beside its code. Before a
 * walkthrough, the change's files by folder, and the one step that writes one.
 */
export function ReviewGuide({ model }: { model: ReviewModel }) {
  const { guide } = model;
  // Disclosures the person opens in this visit fade in; those open before show still.
  const [opened] = useState(() => new Set<string>());
  const entries = useMemo(() => new Map(model.ordered.map((entry) => [entry.file.id, entry])), [model.ordered]);
  const notes = useFileNotes(model);
  const scope: GuideScope = { model, entries, notes, opened };
  if (guide.status === 'loading') return <div className="tm-review-guide"><p className="tm-review-guide__loading">Loading walkthrough…</p></div>;
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
  const outside = guide.outside.findings.length > 0 || guide.outside.discussions.length > 0;
  return (
    <section className="tm-review-guide__stage tm-review-guide__stage--overview" data-stage="overview" aria-label="Overview">
      <div className="tm-review-guide__column">
        <GuideByline author={guide.author} />
        <blockquote className="tm-review-guide__summary"><GuideInlines parts={walkthrough.summary} /></blockquote>
        {walkthrough.attention.length ? <GuideAttentionList items={walkthrough.attention} actions={actions} /> : null}
      </div>
      <div className="tm-review-guide__code">
        <nav className="tm-review-guide__map" aria-labelledby={mapLabel}>
          <h2 className="tm-review-guide__map-head" id={mapLabel}>
            <span>{walkthrough.stages.length} intents</span>
            <span className="tm-review-guide__map-viewed">Viewed</span>
          </h2>
          <ol>
            {walkthrough.stages.map((stage) => {
              const progress = stageProgress(stage, model.viewedIds);
              return (
                <li key={stage.section}>
                  <button type="button" className="tm-review-guide__map-row" data-done={progress.viewed === progress.total ? '' : undefined}
                    aria-label={`${stage.section + 1}. ${stage.title}`} onClick={() => actions.showStage(stage.section)}>
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
        {outside ? (
          <section className="tm-review-guide__outside" aria-label="Outside the change">
            <h3 className="tm-review-guide__label">Outside the change</h3>
            <div className="tm-review-general">
              <ReviewBands place="general" findings={guide.outside.findings} discussions={guide.outside.discussions} />
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Before a walkthrough: the change from facts alone, its files by folder, each
 * folded to its head, and the one step that writes the walkthrough. Nothing
 * runs on the code until the person asks. While a review writes it, the step
 * says so; when one could not be kept, the step says why and runs it again.
 */
function GuideBeforeWalkthrough({ scope }: { scope: GuideScope }) {
  const { model } = scope;
  const { guide, props } = model;
  const reasonId = useId();
  const run = props.runReview;
  const step = guide.status === 'running' ? (
    <p className="tm-review-guide__state"><StatusGlyph kind="working" />Writing walkthrough</p>
  ) : guide.reason || run ? (
    <>
      {guide.reason ? <p className="tm-review-guide__state">{guide.reason}</p> : null}
      {run ? (
        <div className="tm-review-guide__step">
          <button type="button" className="outline-button button--sm" disabled={Boolean(run.disabledReason) || run.busy}
            aria-describedby={run.disabledReason ? reasonId : undefined} onClick={run.onRun}>
            {guide.status === 'none' ? 'Write walkthrough' : run.label}
          </button>
          {run.disabledReason ? <span id={reasonId} className="tm-review-guide__reason">{run.disabledReason}</span> : null}
        </div>
      ) : null}
    </>
  ) : null;
  return (
    <div className="tm-review-guide">
      <section className={`tm-review-guide__stage tm-review-guide__stage--folders${step ? '' : ' tm-review-guide__stage--code'}`} aria-label="The change by folder">
        {step ? <div className="tm-review-guide__column">{step}</div> : null}
        <div className="tm-review-guide__code">
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
