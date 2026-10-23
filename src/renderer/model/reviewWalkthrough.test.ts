import { describe, expect, it } from 'vitest';
import { REVIEW_WALKTHROUGH_SCHEMA, type ReviewWalkthrough } from '../../shared/reviewWalkthrough';
import type { ReviewComment } from '../../shared/reviewDraft';
import { inspectGitDiffEvidence } from './diffEvidence';
import { buildGuide, filesByFolder, guideReadingOrder, guideReveal, stageProgress, type GuideModel } from './reviewWalkthrough';
import { anchorReviewComments, anchorReviewDiscussions, anchorReviewFindings, lineAnchor, type ReviewFindingView } from './reviewWorkspace';

/** The change a review read, as `git diff-tree -p` writes it: one block per file. */
const DIFF = [
  'diff --git a/src/remote/service.ts b/src/remote/service.ts',
  '--- a/src/remote/service.ts',
  '+++ b/src/remote/service.ts',
  '@@ -1,4 +1,5 @@',
  " import { a } from './a';",
  "+import { b } from './b';",
  ' ',
  ' export class RemoteService {',
  '   constructor() {}',
  '@@ -20,7 +21,9 @@ export class RemoteService {',
  '   async fetchRevisions(head: string) {',
  '     const base = await this.base();',
  '-    const objects = await fetch(head);',
  '+    const objects = await fetch(head, base);',
  "+    if (!objects) throw new Error('missing');",
  '+    return objects;',
  '   }',
  ' ',
  '   private base() {',
  '     return this.cached;',
  '@@ -40,4 +43,5 @@ export class RemoteService {',
  '   clear() {',
  '     this.cache = undefined;',
  '+    this.pending = undefined;',
  '   }',
  ' }',
  'diff --git a/src/remote/reader.ts b/src/remote/reader.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/remote/reader.ts',
  '@@ -0,0 +1,6 @@',
  '+export function read(snapshot: string) {',
  '+  const text = snapshot.trim();',
  '+  return text;',
  '+}',
  '+',
  '+export const LIMIT = 10;',
  'diff --git a/src/remote/service.test.ts b/src/remote/service.test.ts',
  '--- a/src/remote/service.test.ts',
  '+++ b/src/remote/service.test.ts',
  '@@ -1,2 +1,3 @@',
  " it('fetches', () => {",
  "+  expect(snapshot()).toBe('x');",
  ' });',
  'diff --git a/docs/remote.md b/docs/remote.md',
  '--- a/docs/remote.md',
  '+++ b/docs/remote.md',
  '@@ -1,2 +1,2 @@',
  ' # Remote work',
  '-Old words.',
  '+New words.',
  'diff --git a/package.json b/package.json',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -1,1 +1,1 @@',
  '-{"name": "a"}',
  '+{"name": "b"}',
  ''
].join('\n');

const files = inspectGitDiffEvidence(DIFF).files;
const SERVICE = 'src/remote/service.ts';
const READER = 'src/remote/reader.ts';
const TEST = 'src/remote/service.test.ts';
const DOCS = 'docs/remote.md';

const walkthrough: ReviewWalkthrough = {
  schema: REVIEW_WALKTHROUGH_SCHEMA,
  reviewRunId: 'review-1',
  base: 'b'.repeat(40),
  tree: 'c'.repeat(40),
  summary: 'Tasks start from `remote` work. The reader shows what the service fetched.',
  attention: [
    { text: 'Clearing leaves the cache in place', section: 0, finding: 'cache' },
    { text: '`reader.ts` reads the snapshot once', section: 0, path: READER },
    { text: 'Settings now require the glab path', section: 1 }
  ],
  sections: [
    {
      title: 'Fetch remote work',
      explanation: 'Tasks fetch with the `merge base` and keep a reader for the snapshot. Tests follow.',
      files: [SERVICE, READER, TEST, DOCS],
      excerpts: [
        { path: SERVICE, side: 'NEW', line: 23, endLine: 25, caption: 'Fetch with the merge base' },
        { path: READER, side: 'NEW', line: 2, endLine: 3 }
      ],
      terms: [
        { text: '`merge base`', path: SERVICE, side: 'NEW', line: 23, endLine: 24 },
        { text: 'reader', path: READER, side: 'NEW', line: 6 },
        { text: 'snapshot', path: TEST, side: 'NEW', line: 2 }
      ]
    },
    { title: 'Other changes', explanation: '', files: ['package.json'], excerpts: [], terms: [] }
  ]
};

const major: ReviewFindingView = {
  id: 'cache', severity: 'MAJOR', title: 'Clearing leaves the cache in place', explanation: 'The cache outlives clear().', path: SERVICE, line: 44, state: 'OPEN'
};
const thread = { id: 'docs-thread', path: DOCS, side: 'NEW' as const, line: 2, outdated: false, open: true };

function guideOf(findings: readonly ReviewFindingView[] = [major], discussions = [thread], comments: readonly ReviewComment[] = [], of = walkthrough): GuideModel {
  return buildGuide(of, files, {
    findings: anchorReviewFindings(files, findings),
    discussions: anchorReviewDiscussions(files, discussions, true),
    comments: anchorReviewComments(files, comments)
  });
}

/** The symbol a key change at `line` of a new file of `code` sits in, as its run reads it. */
function symbolAt(code: readonly string[], line: number, heading = ''): string | undefined {
  const path = 'src/symbols.ts';
  const diff = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -10,${code.length - 1} +10,${code.length} @@${heading ? ` ${heading}` : ''}`,
    ...code.map((text, index) => (index + 10 === line ? `+${text}` : ` ${text}`)),
    ''
  ].join('\n');
  const changed = inspectGitDiffEvidence(diff).files;
  const guide = buildGuide(
    { ...walkthrough, attention: [], sections: [{ title: 'Symbols', explanation: '', files: [path], excerpts: [{ path, side: 'NEW', line }], terms: [] }] },
    changed,
    { findings: anchorReviewFindings(changed, []), discussions: anchorReviewDiscussions(changed, [], true), comments: anchorReviewComments(changed, []) }
  );
  const label = guide.stages[0]!.files[0]!.runs[0]!.label;
  return label.kind === 'key' ? label.symbol : undefined;
}

describe('the Guide model', () => {
  it('shows a file with a key change or open feedback, in the walkthrough\'s order, and folds the rest behind "N more files"', () => {
    const [stage, other] = guideOf().stages;
    expect(stage!.shown).toEqual([SERVICE, READER, DOCS]);
    // A test with neither a key change nor feedback waits with the rest.
    expect(stage!.folded).toEqual([TEST]);
    // Nothing points into Other changes, so its one file is folded.
    expect(other!.shown).toEqual([]);
    expect(other!.folded).toEqual(['package.json']);

    // Feedback that no longer asks for anything does not show a file.
    expect(guideOf([{ ...major, state: 'DISMISSED' }], [{ ...thread, open: false }]).stages[0]!.shown).toEqual([SERVICE, READER]);
    // The person's own comment does.
    const comment: ReviewComment = { id: 'c1', path: TEST, side: 'NEW', line: 2, text: 'Assert the trim.' };
    expect(guideOf([], [], [comment]).stages[0]!.shown).toEqual([SERVICE, READER, TEST]);
  });

  it('leads a file with its key change, the lines it replaces included, under the caption and the symbol it sits in', () => {
    const service = guideOf([]).stages[0]!.files[0]!;
    expect(service.runs[0]).toEqual({
      blockId: expect.any(String),
      // The removed line the first added one replaces reads with it.
      start: 'o22',
      end: 'n25',
      label: { kind: 'key', caption: 'Fetch with the merge base', symbol: 'fetchRevisions()' }
    });
    // Everything else that changed is one row, in file order; lines around the key change with no change of their own drop.
    expect(service.rest.map((run) => [run.start, run.end, run.label])).toEqual([
      ['n1', 'n5', { kind: 'place', lines: 'Lines 1–5' }],
      ['n43', 'n47', { kind: 'place', lines: 'Lines 43–47', heading: 'export class RemoteService {' }]
    ]);
    expect(service.more).toBe('2 more changes');
  });

  it('shows the lines open feedback is about after the key change, never a row twice, and leaves the rest behind one row', () => {
    const service = guideOf().stages[0]!.files[0]!;
    expect(service.runs.map((run) => [run.start, run.end, run.label.kind])).toEqual([['o22', 'n25', 'key'], ['n43', 'n47', 'place']]);
    expect(service.rest.map((run) => [run.start, run.end])).toEqual([['n1', 'n5']]);
    expect(service.more).toBe('1 more change');
    // A new file's other changes are counted in lines.
    const reader = guideOf().stages[0]!.files[1]!;
    expect(reader.runs.map((run) => [run.start, run.end])).toEqual([['n2', 'n3']]);
    expect(reader.rest.map((run) => [run.start, run.end])).toEqual([['n1', 'n1'], ['n4', 'n6']]);
    expect(reader.more).toBe('4 more lines');
  });

  it('ties each term to its lines and opens whatever hides them first', () => {
    const guide = guideOf();
    const [stage] = guide.stages;
    expect(stage!.explanation.map((span) => (span.kind === 'term' ? `[${span.inlines.map((part) => part.text).join('')}]` : span.inlines.map((part) => part.text).join('')))).toEqual([
      'Tasks fetch with the ', '[merge base]', ' and keep a ', '[reader]', ' for the ', '[snapshot]', '. Tests follow.'
    ]);
    const terms = stage!.explanation.flatMap((span) => (span.kind === 'term' ? [span] : []));
    expect(terms[0]!.inlines).toEqual([{ kind: 'code', text: 'merge base' }]);
    expect(terms[0]!.target).toEqual({ fileId: SERVICE, anchors: [lineAnchor(SERVICE, 'NEW', 23), lineAnchor(SERVICE, 'NEW', 24)], label: 'service.ts, lines 23–24' });
    expect(terms[1]!.target.label).toBe('reader.ts, line 6');
    // In the key change, nothing opens; among the file's other changes, they open; in a folded file, its stage's other files do.
    expect(guideReveal(guide, SERVICE, terms[0]!.target.anchors[0])).toEqual({});
    expect(guideReveal(guide, READER, terms[1]!.target.anchors[0])).toEqual({ more: READER });
    expect(guideReveal(guide, TEST, terms[2]!.target.anchors[0])).toEqual({ group: 0 });
    expect(guideReveal(guide, 'src/elsewhere.ts')).toBeUndefined();
  });

  it('lands an attention fact on the open finding or the file it names, or else on its stage', () => {
    const guide = guideOf();
    expect(guide.attention).toEqual([
      {
        text: [{ kind: 'text', text: 'Clearing leaves the cache in place' }],
        stage: 0,
        target: { kind: 'finding', findingId: 'cache', severity: 'MAJOR', place: 'service.ts:44' }
      },
      { text: [{ kind: 'code', text: 'reader.ts' }, { kind: 'text', text: ' reads the snapshot once' }], stage: 0, target: { kind: 'file', fileId: READER } },
      { text: [{ kind: 'text', text: 'Settings now require the glab path' }], stage: 1 }
    ]);
    expect(guide.stages[0]!.attention).toHaveLength(2);
    // A fact names a finding only while it still asks for something, and only one the files hold.
    expect(guideOf([{ ...major, state: 'DISMISSED' }]).attention[0]!.target).toBeUndefined();
    expect(guideOf([{ ...major, path: 'src/elsewhere.ts' }]).attention[0]!.target).toBeUndefined();
  });

  it('reads key changes that share lines as one, under the first one\'s caption', () => {
    const [section, other] = walkthrough.sections;
    const overlapping: ReviewWalkthrough = {
      ...walkthrough,
      sections: [{
        ...section!,
        excerpts: [
          { path: SERVICE, side: 'NEW', line: 23, endLine: 25, caption: 'Fetch with the merge base' },
          { path: SERVICE, side: 'NEW', line: 25, endLine: 28, caption: 'Return what was fetched' }
        ]
      }, other!]
    };
    const service = guideOf([], [], [], overlapping).stages[0]!.files[0]!;
    expect(service.runs.map((run) => [run.start, run.end, run.label])).toEqual([
      ['o22', 'n28', { kind: 'key', caption: 'Fetch with the merge base', symbol: 'fetchRevisions()' }]
    ]);
  });

  it('counts viewed files per stage, and steps J and K through shown files, then a stage\'s others while they are open', () => {
    const guide = guideOf();
    expect(stageProgress(guide.stages[0]!, new Set([SERVICE, TEST]))).toEqual({ viewed: 2, total: 4 });
    expect(guideReadingOrder(guide, new Set())).toEqual([SERVICE, READER, DOCS]);
    expect(guideReadingOrder(guide, new Set([0, 1]))).toEqual([SERVICE, READER, DOCS, TEST, 'package.json']);
  });

  it('keeps a one-intent change to one stage with its summary and explanation', () => {
    const single = buildGuide({ ...walkthrough, attention: [], sections: [walkthrough.sections[0]!] }, files, {
      findings: anchorReviewFindings(files, []), discussions: anchorReviewDiscussions(files, [], true), comments: anchorReviewComments(files, [])
    });
    expect(single.stages).toHaveLength(1);
    expect(single.summary[1]).toEqual({ kind: 'code', text: 'remote' });
    expect(single.stages[0]!.lead.map((part) => part.text).join('')).toBe('Tasks fetch with the merge base and keep a reader for the snapshot.');
  });
});

describe('reading the walkthrough\'s words', () => {
  it('ends a stage\'s lead at its first stop, never inside a code span', () => {
    const [section] = walkthrough.sections;
    const of = { ...walkthrough, attention: [], sections: [{ ...section!, explanation: 'Runs `a.b. c` once. Then more.', terms: [] }] };
    expect(guideOf([], [], [], of).stages[0]!.lead).toEqual([
      { kind: 'text', text: 'Runs ' }, { kind: 'code', text: 'a.b. c' }, { kind: 'text', text: ' once.' }
    ]);
  });

  it('names the symbol a key change sits in by indentation, then by the hunk\'s heading, and nothing at the top level', () => {
    const service = guideOf([], [], [], {
      ...walkthrough,
      sections: [{
        ...walkthrough.sections[0]!,
        excerpts: [
          { path: SERVICE, side: 'NEW', line: 45 },
          // From the hunk's first line, the run reads the hunk's heading.
          { path: SERVICE, side: 'NEW', line: 43 }
        ]
      }, walkthrough.sections[1]!]
    }).stages[0]!.files[0]!;
    expect(service.runs.map((run) => run.label)).toEqual([
      { kind: 'key', symbol: 'clear()' },
      { kind: 'key', symbol: 'RemoteService' }
    ]);
    expect(symbolAt(['export const LIMIT = 10;'], 10)).toBeUndefined();
    expect(symbolAt(["describe('the Guide', () => {", "  it('opens', () => {});", '});'], 11)).toBe('the Guide');
    expect(symbolAt(['func (s *Server) Handle(w Writer) {', '\tif err := s.load(); err != nil {', '\t\treturn', '\t}', '}'], 12)).toBe('Handle()');
    expect(symbolAt(['def load(path):', '    if path:', '        read(path)', '    elif (fallback):', '        use(fallback)'], 14)).toBe('load()');
    // A line that comments declares nothing, whatever it mentions.
    expect(symbolAt(['def load(path):', '    if path:', '# def legacy(): see history', '        read(path)'], 13)).toBe('load()');
    // A statement taken for the heading calls; it declares nothing.
    expect(symbolAt(['  run(options);'], 10, 'main();')).toBeUndefined();
  });

  it('groups a change\'s files by folder in path order', () => {
    expect(filesByFolder(files)).toEqual([
      { folder: '', fileIds: ['package.json'] },
      { folder: 'docs', fileIds: [DOCS] },
      { folder: 'src/remote', fileIds: [READER, TEST, SERVICE] }
    ]);
  });
});
