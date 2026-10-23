import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REVIEW_DRAFT, REVIEW_WALKTHROUGH_SCHEMA, type ArtifactRecord, type ReviewWalkthrough, type TaskReviewDraft } from '../../shared/contracts';
import { inspectGitDiffEvidence } from '../model/diffEvidence';
import type { DiscussionView } from '../model/pullRequestFeedback';
import { planReviewRequest } from '../model/reviewFollowUp';
import type { ReviewRoundView } from '../model/reviewRounds';
import { lineAnchor, type ReviewFindingView } from '../model/reviewWorkspace';
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace';

const api = vi.hoisted(() => ({ readArtifact: vi.fn(), readReviewChanges: vi.fn() }));
vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: { readArtifact: api.readArtifact, readReviewChanges: api.readReviewChanges } }));

const SERVICE = 'src/remote/service.ts';
const READER = 'src/remote/reader.ts';
const TEST = 'src/remote/service.test.ts';
const DOCS = 'docs/remote.md';
const PACKAGE = 'package.json';

/** The change the review read, as the reviewed diff gives it: one block per file. */
const DIFF = [
  `diff --git a/${SERVICE} b/${SERVICE}`, `--- a/${SERVICE}`, `+++ b/${SERVICE}`,
  '@@ -1,4 +1,5 @@', " import { a } from './a';", "+import { b } from './b';", ' ', ' export class RemoteService {', '   constructor() {}',
  '@@ -20,7 +21,9 @@ export class RemoteService {', '   async fetchRevisions(head: string) {', '     const base = await this.base();',
  '-    const objects = await fetch(head);', '+    const objects = await fetch(head, base);', "+    if (!objects) throw new Error('missing');",
  '+    return objects;', '   }', ' ', '   private base() {', '     return this.cached;',
  '@@ -40,4 +43,5 @@ export class RemoteService {', '   clear() {', '     this.cache = undefined;', '+    this.pending = undefined;', '   }', ' }',
  `diff --git a/${READER} b/${READER}`, 'new file mode 100644', '--- /dev/null', `+++ b/${READER}`,
  '@@ -0,0 +1,6 @@', '+export function read(snapshot: string) {', '+  const text = snapshot.trim();', '+  return text;', '+}', '+', '+export const LIMIT = 10;',
  `diff --git a/${TEST} b/${TEST}`, `--- a/${TEST}`, `+++ b/${TEST}`, '@@ -1,2 +1,3 @@', " it('fetches', () => {", "+  expect(snapshot()).toBe('x');", ' });',
  `diff --git a/${DOCS} b/${DOCS}`, `--- a/${DOCS}`, `+++ b/${DOCS}`, '@@ -1,2 +1,2 @@', ' # Remote work', '-Old words.', '+New words.',
  `diff --git a/${PACKAGE} b/${PACKAGE}`, `--- a/${PACKAGE}`, `+++ b/${PACKAGE}`, '@@ -1,1 +1,1 @@', '-{"name": "a"}', '+{"name": "b"}', ''
].join('\n');
/**
 * The same change as the Diff's capture holds it, in its Git layers: service.ts's
 * import was committed, the rest of its change is still in the worktree.
 */
function capture(pending = 'undefined'): string {
  const [service, rest] = [DIFF.slice(0, DIFF.indexOf(`diff --git a/${READER}`)), DIFF.slice(DIFF.indexOf(`diff --git a/${READER}`))];
  const committed = service.slice(0, service.indexOf('@@ -20,7'));
  const worktree = [`diff --git a/${SERVICE} b/${SERVICE}`, `--- a/${SERVICE}`, `+++ b/${SERVICE}`,
    ...service.slice(service.indexOf('@@ -20,7')).replace('@@ -20,7 +21,9 @@', '@@ -21,7 +21,9 @@').replace('@@ -40,4 +43,5 @@', '@@ -41,4 +43,5 @@')
      .replace('this.pending = undefined', `this.pending = ${pending}`).trimEnd().split('\n')].join('\n');
  return `# Git diff evidence\n\n## Committed diff\n\n${committed}${rest}\n## Staged diff\n\nNo staged diff.\n\n## Unstaged diff\n\n${worktree}\n`;
}
const files = inspectGitDiffEvidence(DIFF).files;

const walkthrough: ReviewWalkthrough = {
  schema: REVIEW_WALKTHROUGH_SCHEMA,
  reviewRunId: 'review-1',
  base: 'b'.repeat(40),
  tree: 'c'.repeat(40),
  summary: 'Tasks start from `remote` work. The docs say how.',
  attention: [{ text: 'Clearing leaves the cache in place', section: 0, finding: 'cache' }],
  sections: [
    {
      title: 'Fetch remote work',
      explanation: 'Tasks fetch with the `merge base` and keep a reader for the snapshot.',
      files: [SERVICE, READER, TEST],
      excerpts: [{ path: SERVICE, side: 'NEW', line: 23, endLine: 25, caption: 'Fetch with the merge base' }, { path: READER, side: 'NEW', line: 2, endLine: 3 }],
      terms: [
        { text: '`merge base`', path: SERVICE, side: 'NEW', line: 23, endLine: 24 },
        { text: 'reader', path: READER, side: 'NEW', line: 6 },
        { text: 'snapshot', path: TEST, side: 'NEW', line: 2 }
      ]
    },
    {
      title: 'Document remote work',
      explanation: 'The docs say how.',
      files: [DOCS],
      excerpts: [{ path: DOCS, side: 'NEW', line: 2 }],
      terms: []
    },
    { title: 'Other changes', explanation: '', files: [PACKAGE], excerpts: [], terms: [] }
  ]
};
const STORED: NonNullable<ReviewWorkspaceProps['walkthrough']> = {
  state: { status: 'STORED', reviewRunId: 'review-1', artifactId: 'walkthrough-1' },
  view: { loading: false, walkthrough, files },
  author: 'Codex'
};
const major: ReviewFindingView = {
  id: 'cache', severity: 'MAJOR', title: 'Clearing leaves the cache in place', explanation: 'The cache outlives clear().', path: SERVICE, line: 44, state: 'OPEN'
};

function artifact(id: string): ArtifactRecord {
  return { id, taskId: 'task-1', kind: 'diff', path: `/tmp/${id}.md`, byteCount: 256, createdAt: '2026-07-07T10:10:00.000Z', updatedAt: '2026-07-07T10:10:00.000Z' };
}

function Harness({ taskId = 'task-guide', ...overrides }: Partial<ReviewWorkspaceProps>) {
  const [draft, setDraft] = useState<TaskReviewDraft>(EMPTY_REVIEW_DRAFT);
  const review = 'review' in overrides ? overrides.review : { status: 'NEEDS_CHANGES' as const, reviewedAt: '2026-07-07T10:12:00.000Z', runId: 'review-1' };
  const findings = overrides.findings ?? [major];
  const findingsSendable = review?.status !== 'STALE' && review?.status !== 'RUNNING';
  return (
    <ReviewWorkspace
      taskId={taskId}
      currentDiffArtifactId="diff-1"
      artifacts={[artifact('diff-1'), artifact('diff-2')]}
      draft={draft}
      onDraftChange={setDraft}
      plan={planReviewRequest(findings, draft, { runId: review?.runId, findingsSendable, asksForChanges: false }, overrides.discussions ?? [])}
      findingsSendable={findingsSendable}
      requestChanges={{ busy: false, instruction: () => 'Address the review.', onSubmit: () => undefined }}
      walkthrough={STORED}
      {...overrides}
      review={review}
      findings={findings}
    />
  );
}

/** Renders and lets the Diff's capture arrive, as it does while the Guide is read. */
async function open(element: React.ReactElement) {
  const result = render(element);
  await act(async () => undefined);
  return result;
}

const scroller = () => document.querySelector<HTMLElement>('.tm-review__scroller')!;
const press = (key: string) => fireEvent.keyDown(scroller(), { key });
const stage = (title: string) => screen.getByRole('region', { name: title });
/** The file a stage's list holds as the one being read. */
const reading = (title: string) => within(within(stage(title)).getByRole('navigation', { name: 'Files' })).queryAllByRole('button')
  .find((row) => row.getAttribute('aria-current') === 'true')?.querySelector('.tm-review__index-name')?.textContent;
const rows = (anchor: string) => [...document.querySelectorAll(`[data-line-anchor="${anchor}"]`)];
const modePressed = (mode: 'Guide' | 'Diff') => screen.getByRole('button', { name: mode }).getAttribute('aria-pressed') === 'true';

async function openMenu(trigger: HTMLElement, name: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  return screen.findByRole('menu', { name });
}

beforeEach(() => {
  // diff-2: the agent changed service.ts again after the review.
  api.readArtifact.mockReset().mockImplementation(async ({ artifactId }: { artifactId: string }) => capture(artifactId === 'diff-2' ? 'null' : 'undefined'));
  window.localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('the Guide', () => {
  it('opens on the walkthrough of the code shown and reads it intent by intent: key changes first, the rest one row away', async () => {
    await open(<Harness />);
    expect(modePressed('Guide')).toBe(true);

    const overview = stage('Overview');
    expect(within(overview).getByText('Codex')).toBeDefined();
    expect(within(overview).getByRole('button', { name: '1. Fetch remote work' }).textContent).toContain('0/3');
    // The fact names the finding, which leads it with its severity and lands on it.
    fireEvent.click(within(overview).getByRole('button', { name: /Clearing leaves the cache in place/ }));
    expect(document.activeElement).toBe(screen.getByRole('article', { name: 'Major finding: Clearing leaves the cache in place' }));

    const fetching = stage('Fetch remote work');
    const units = [...fetching.querySelectorAll('[data-file-id]')].map((unit) => unit.getAttribute('data-file-id'));
    // A test with neither a key change nor feedback waits behind "1 more file".
    expect(units).toEqual([SERVICE, READER]);
    const service = within(fetching).getByRole('region', { name: SERVICE });
    expect(within(service).getByText('Fetch with the merge base')).toBeDefined();
    expect(within(service).getByText('fetchRevisions()')).toBeDefined();
    // The finding no key change holds shows on its lines; the file's other change waits behind one row.
    expect(within(service).getByRole('article', { name: 'Major finding: Clearing leaves the cache in place' })).toBeDefined();
    expect(rows(lineAnchor(SERVICE, 'NEW', 2))).toHaveLength(0);
    fireEvent.click(within(service).getByRole('button', { name: '1 more change' }));
    expect(rows(lineAnchor(SERVICE, 'NEW', 2))).toHaveLength(1);
    expect(within(service).getByText('Lines 1–5')).toBeDefined();

    // A new file reads as plain code; a changed line elsewhere still says it was added.
    const codes = (region: HTMLElement) => [...region.querySelectorAll('code')].map((code) => code.textContent ?? '');
    expect(codes(within(fetching).getByRole('region', { name: READER })).some((text) => text.startsWith('Added: '))).toBe(false);
    expect(codes(service)).toContain('Added:     return objects;');

    // The stage's list names every file of the intent, those the code shows first; pressing one among
    // the others opens them and the file.
    const list = within(fetching).getByRole('navigation', { name: 'Files' });
    const listed = within(list).getAllByRole('button');
    expect(listed.map((row) => row.querySelector('.tm-review__index-name')?.textContent)).toEqual(['service.ts', 'reader.ts', 'service.test.ts']);
    fireEvent.click(listed[2]!);
    const test = within(fetching).getByRole('region', { name: TEST });
    expect(within(test).getByRole('button', { name: `Collapse ${TEST}` })).toBeDefined();
    expect(within(fetching).getByRole('button', { name: /more files?$/u }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the code where it is read when a comment is written there, laid out by what was said when the person arrived', async () => {
    await open(<Harness />);
    const fetching = stage('Fetch remote work');
    fireEvent.click(within(fetching).getByRole('button', { name: '1 more file' }));
    fireEvent.click(within(fetching).getByRole('button', { name: `Expand ${TEST}` }));
    const test = within(fetching).getByRole('region', { name: TEST });
    fireEvent.click(within(test).getByRole('button', { name: 'Comment on line 2' }));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Check the snapshot too.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    // The comment lands under its line, and its file stays among the stage's other files, still open.
    expect(within(test).getByText('Check the snapshot too.')).toBeDefined();
    expect([...fetching.querySelectorAll('[data-file-id]')].map((unit) => unit.getAttribute('data-file-id'))).toEqual([SERVICE, READER, TEST]);
    expect(within(fetching).getByRole('button', { name: '1 more file' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('lights a term\'s lines while it is pointed at, and pressed, opens what hides them and keeps them chosen until the next move', async () => {
    await open(<Harness />);
    const fetching = stage('Fetch remote work');
    const term = (name: string) => within(fetching).getByRole('button', { name });
    const lit = () => [...document.querySelectorAll('[data-lit]')].map((row) => row.getAttribute('data-line-anchor'));
    const marked = () => [...document.querySelectorAll('[data-marked]')].map((row) => row.getAttribute('data-line-anchor'));

    fireEvent.pointerOver(term('merge base'));
    expect(lit()).toEqual([lineAnchor(SERVICE, 'NEW', 23), lineAnchor(SERVICE, 'NEW', 24)]);
    fireEvent.pointerOut(term('merge base'));
    expect(lit()).toEqual([]);

    // Among the file's other changes: they open, and the line is chosen.
    expect(rows(lineAnchor(READER, 'NEW', 6))).toHaveLength(0);
    fireEvent.click(term('reader'));
    expect(marked()).toEqual([lineAnchor(READER, 'NEW', 6)]);
    // In a file among the stage's others: they open, and so does the file.
    fireEvent.click(term('snapshot'));
    expect(marked()).toEqual([lineAnchor(TEST, 'NEW', 2)]);
    expect(within(fetching).getByRole('region', { name: TEST })).toBeDefined();

    press('Escape');
    expect(marked()).toEqual([]);
  });

  it('lists the stages from the counter, with their files viewed, and goes to the one chosen', async () => {
    await open(<Harness />);
    const menu = await openMenu(within(stage('Fetch remote work')).getByRole('button', { name: 'Intent 1 of 3' }), 'Intent 1 of 3');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Overview', 'Fetch remote work', 'Document remote work', 'Other changes'
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Fetch remote work' }).getAttribute('aria-current')).toBe('true');
    expect(within(within(menu).getByRole('menuitem', { name: 'Document remote work' })).getByText('0/1')).toBeDefined();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Document remote work' }));
    expect(reading('Document remote work')).toBe('remote.md');
  });

  it('steps J and K through the files across stages, [ and ] through the stages, and V on to the next file not viewed', async () => {
    await open(<Harness />);
    press('j');
    expect(reading('Fetch remote work')).toBe('service.ts');
    press('j');
    press('j');
    // Past the stage's last file, J reads on into the next stage.
    expect(reading('Document remote work')).toBe('remote.md');
    expect(reading('Fetch remote work')).toBeUndefined();
    press('k');
    expect(reading('Fetch remote work')).toBe('reader.ts');

    press(']');
    expect(reading('Document remote work')).toBe('remote.md');
    press('[');
    expect(reading('Fetch remote work')).toBe('service.ts');

    press('v');
    const service = within(stage('Fetch remote work')).getByRole('region', { name: SERVICE });
    expect((within(service).getByRole('checkbox', { name: 'Viewed' }) as HTMLInputElement).checked).toBe(true);
    // Viewed folds the file, and its open finding stays as a row.
    expect(within(service).getByRole('button', { name: /Clearing leaves the cache in place/ })).toBeDefined();
    expect(reading('Fetch remote work')).toBe('reader.ts');
  });

  it('switches modes with G and keeps the file and line read, at the same height, both ways', async () => {
    await open(<Harness />);
    const element = scroller();
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 10_000 });
    const line24 = lineAnchor(SERVICE, 'NEW', 24);
    // Line 24 is the first under service.ts's stuck head: 50px down in the Guide, then 300px down in the Diff.
    let lineTop = { guide: 150, diff: 400 };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const mode = document.querySelector('.tm-review')?.getAttribute('data-review-mode') as 'guide' | 'diff';
      const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
      if (this === element) return box(100, 700);
      if (this.matches('.tm-review-file__head')) return box(100, 136);
      if (this.getAttribute('data-line-anchor') === line24) return box(lineTop[mode], lineTop[mode] + 20);
      return box(0, 0);
    });

    press('j');
    press('g');
    expect(modePressed('Diff')).toBe(true);
    // The Diff is the whole change, read from the same file.
    expect(screen.getByRole('button', { name: 'Changes to show' }).textContent).toContain('All changes');
    const navigator = within(screen.getByRole('navigation', { name: 'Files' })).getAllByRole('button');
    expect(navigator).toHaveLength(5);
    expect(navigator.find((row) => row.getAttribute('aria-current') === 'true')?.textContent).toContain('service.ts');
    // The line lands 50px under the scroller's top, as it was: 400 - 100 - 50.
    expect(element.scrollTop).toBe(250);

    lineTop = { guide: 600, diff: 400 };
    press('g');
    expect(modePressed('Guide')).toBe(true);
    expect(reading('Fetch remote work')).toBe('service.ts');
    // Back at 300px down: 250 + 600 - 100 - 300.
    expect(element.scrollTop).toBe(450);

    // On the overview no file is under way, whichever was read last: G opens the whole Diff at its top.
    lineTop = { guide: 800, diff: 400 };
    const stages = await openMenu(within(stage('Fetch remote work')).getByRole('button', { name: 'Intent 1 of 3' }), 'Intent 1 of 3');
    fireEvent.click(within(stages).getByRole('menuitem', { name: 'Overview' }));
    press('g');
    expect(screen.getByRole('button', { name: 'Changes to show' }).textContent).toContain('All changes');
    expect(element.scrollTop).toBe(0);
  });

  it('opens the Review tab in the mode last read for the task, else the Guide when its walkthrough is the code shown', async () => {
    const first = await open(<Harness taskId="task-a" />);
    expect(modePressed('Guide')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    first.unmount();

    const again = await open(<Harness taskId="task-a" />);
    expect(modePressed('Diff')).toBe(true);
    again.unmount();
    // A walkthrough of earlier code does not lead.
    const stale = await open(<Harness taskId="task-b" review={{ status: 'STALE', runId: 'review-1' }} />);
    expect(modePressed('Diff')).toBe(true);
    stale.unmount();
    await open(<Harness taskId="task-c" walkthrough={undefined} />);
    expect(modePressed('Diff')).toBe(true);
  });

  it('shows the change by folder before a walkthrough, with the one step that writes it, and says when one is being written or could not be', async () => {
    const onRun = vi.fn();
    const { rerender } = await open(<Harness walkthrough={undefined} runReview={{ label: 'Run review', busy: false, onRun }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    const folders = screen.getByRole('region', { name: 'The change by folder' });
    expect(within(folders).getByRole('region', { name: 'src/remote' })).toBeDefined();
    expect(within(within(folders).getByRole('region', { name: SERVICE })).getByRole('button', { name: `Expand ${SERVICE}` })).toBeDefined();
    // The Guide holds the step, so the bar does not repeat it.
    expect(screen.queryByRole('button', { name: 'Run review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Write walkthrough' }));
    expect(onRun).toHaveBeenCalledOnce();

    rerender(<Harness walkthrough={undefined} review={{ status: 'RUNNING', runId: 'review-2' }} />);
    expect(screen.getByText('Writing walkthrough')).toBeDefined();

    rerender(<Harness walkthrough={{ ...STORED, state: { status: 'UNAVAILABLE', reason: 'NOT_WRITTEN' } }} runReview={{ label: 'Run review again', busy: false, onRun }} />);
    expect(screen.getByText('The review wrote no walkthrough')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Run review again' }));
    expect(onRun).toHaveBeenCalledTimes(2);

    rerender(<Harness walkthrough={{ ...STORED, view: { loading: true } }} />);
    expect(screen.getByText('Loading walkthrough…')).toBeDefined();
  });

  it('keeps an out-of-date walkthrough as earlier context, with the answers to the request sent on its code', async () => {
    const onRun = vi.fn();
    const onDecide = vi.fn(async () => undefined);
    // The person commented on the walkthrough's code and sent it; the agent answered and changed the code.
    const round: ReviewRoundView = {
      instructionId: 'request-1',
      at: '2026-07-07T10:20:00.000Z',
      request: { reviewRunId: 'review-1', items: [{ number: 1, kind: 'COMMENT', path: READER, side: 'NEW', line: 3, text: 'Return the trimmed text.' }] },
      answers: [{ item: 1, outcome: 'FIXED', note: 'It returns the trimmed text now.' }],
      answeredAt: '2026-07-07T10:25:00.000Z',
      reviewRunId: 'review-1',
      accepted: new Set()
    };
    window.localStorage.clear();
    await open(<Harness review={{ status: 'STALE', runId: 'review-1' }} runReview={{ label: 'Run review again', busy: false, onRun }} answers={{ agent: 'Codex', round, onDecide }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    expect(stage('Fetch remote work')).toBeDefined();
    // The review's state says it is out of date, once, with the one step that refreshes it.
    expect(screen.getByText('Review out of date')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run review again' }));
    expect(onRun).toHaveBeenCalledOnce();

    // The answered comment sits on the line it was written on, and takes the person's decision here.
    const reader = within(stage('Fetch remote work')).getByRole('region', { name: READER });
    expect(within(reader).getByText('Return the trimmed text.')).toBeDefined();
    expect(within(reader).getByText('It returns the trimmed text now.')).toBeDefined();
    fireEvent.click(within(reader).getByRole('button', { name: 'Accept answer' }));
    expect(onDecide).toHaveBeenCalledWith(1, 'ACCEPT');
    // New comments are written on the code shown now, never on earlier code.
    expect(screen.queryByRole('button', { name: /^Comment on line/ })).toBeNull();
  });

  it('reads a file viewed in one mode as viewed in the other while the walkthrough is the code shown, and unviewed once its change moves on', async () => {
    const { rerender } = await open(<Harness />);
    const viewed = () => within(screen.getByRole('region', { name: SERVICE })).getByRole('checkbox', { name: 'Viewed' }) as HTMLInputElement;
    // In the Diff, service.ts sits in two Git layers; in the walkthrough, it is one change. One mark serves both.
    fireEvent.click(viewed());
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect(viewed().checked).toBe(true);

    // The agent changes it again: the Diff shows a change not read yet, while the walkthrough's earlier code was read.
    rerender(<Harness review={{ status: 'STALE', runId: 'review-1' }} currentDiffArtifactId="diff-2" />);
    await act(async () => undefined);
    expect(viewed().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    expect(viewed().checked).toBe(true);

    // Marked again on the earlier code, it says nothing of the code the Diff shows.
    fireEvent.click(viewed());
    fireEvent.click(viewed());
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect(viewed().checked).toBe(false);
  });

  it('asks about an intent, a file or a discussion with that subject', async () => {
    const onAskAboutStage = vi.fn();
    const onAskAboutFile = vi.fn();
    const onAskAboutDiscussion = vi.fn();
    const thread: DiscussionView = {
      id: 'd1', kind: 'THREAD', provider: 'GITHUB', path: DOCS, side: 'NEW', line: 2, resolvable: true, resolved: false, outdated: false, open: true,
      commentCount: 1, comments: [{ author: 'alice', body: 'Say which CLI.', truncated: false }]
    };
    await open(<Harness onAskAboutStage={onAskAboutStage} onAskAboutFile={onAskAboutFile} onAskAboutDiscussion={onAskAboutDiscussion}
      discussions={[thread]} discussionsOnLines />);

    fireEvent.click(within(stage('Document remote work')).getByRole('button', { name: 'Ask about this intent' }));
    expect(onAskAboutStage).toHaveBeenCalledWith(1);
    const menu = await openMenu(within(screen.getByRole('region', { name: SERVICE })).getByRole('button', { name: `Options for ${SERVICE}` }), `Options for ${SERVICE}`);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Ask about this file' }));
    expect(onAskAboutFile).toHaveBeenCalledWith(SERVICE);
    // The discussion sits on its line in the Guide too.
    fireEvent.click(within(screen.getByRole('article', { name: 'GitHub comment by alice' })).getByRole('button', { name: 'Ask about this discussion' }));
    expect(onAskAboutDiscussion).toHaveBeenCalledWith('d1');
  });

  it('tells a one-intent change as one stage, with no overview, counter or list of one file', async () => {
    const single: ReviewWalkthrough = { ...walkthrough, attention: [], sections: [walkthrough.sections[1]!] };
    await open(<Harness walkthrough={{ ...STORED, view: { loading: false, walkthrough: single, files } }} />);
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();
    const account = screen.getByRole('region', { name: 'Walkthrough' });
    expect(within(account).getByText('Tasks start from', { exact: false })).toBeDefined();
    expect(within(account).getByText('The docs say how.')).toBeDefined();
    expect(within(account).queryByRole('button', { name: /^Intent/ })).toBeNull();
    expect(within(account).queryByRole('navigation', { name: 'Files' })).toBeNull();
    expect(within(account).getByRole('region', { name: DOCS })).toBeDefined();
  });
});
