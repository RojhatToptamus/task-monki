import { describe, expect, it } from 'vitest';
import type { DiffFile } from './diffEvidence';
import { orderReviewFiles, reviewFileRole } from './reviewOrder';
import type { ReviewFindingView } from './reviewWorkspace';

function file(path: string, additions = 1, deletions = 0): DiffFile {
  return { id: path, path, status: 'modified', additions, deletions, blocks: [] };
}

function finding(severity: ReviewFindingView['severity'], state: ReviewFindingView['state'] = 'OPEN'): ReviewFindingView {
  return { id: `${severity}-${state}`, severity, title: 'A finding', explanation: 'Because.', state };
}

describe('review file order', () => {
  it('names each file by the part it plays in the change', () => {
    expect(reviewFileRole('server.js')).toBe('code');
    expect(reviewFileRole('test/http.test.js')).toBe('test');
    expect(reviewFileRole('pkg/store_test.go')).toBe('test');
    expect(reviewFileRole('src/style.css')).toBe('ui');
    expect(reviewFileRole('index.html')).toBe('ui');
    expect(reviewFileRole('preview.yaml')).toBe('config');
    expect(reviewFileRole('.github/workflows/ci.yml')).toBe('config');
    expect(reviewFileRole('README.md')).toBe('docs');
    expect(reviewFileRole('package-lock.json')).toBe('generated');
    expect(reviewFileRole('src/__snapshots__/view.test.ts.snap')).toBe('generated');
  });

  it('reads blocking findings first, then code with its tests, then styles, config, docs and generated files', () => {
    const files = [
      file('README.md', 2, 1), file('index.html', 1, 1), file('package-lock.json', 400), file('preview.yaml', 4),
      file('server.js', 1, 1), file('src/main.js', 3), file('src/style.css', 1), file('src/view.ts', 20, 5),
      file('src/view.test.ts', 9), file('test/http.test.js', 5, 1)
    ];
    const findings = new Map([['index.html', [finding('MAJOR')]], ['src/main.js', [finding('MINOR')]]]);
    expect(orderReviewFiles(files, findings).map((entry) => entry.file.path)).toEqual([
      'index.html',
      'src/main.js', 'src/view.ts', 'src/view.test.ts', 'server.js',
      'test/http.test.js',
      'src/style.css',
      'preview.yaml',
      'README.md',
      'package-lock.json'
    ]);
    expect(orderReviewFiles(files, findings).find((entry) => entry.file.path === 'src/view.test.ts')?.subject?.path).toBe('src/view.ts');
  });

  it('pairs a lone test with the lone code file, ignores settled findings, and can fall back to path order', () => {
    const files = [file('test/http.test.js', 5, 1), file('server.js', 1, 1), file('README.md')];
    const ordered = orderReviewFiles(files, new Map([['README.md', [finding('BLOCKER', 'DISMISSED')]]]));
    expect(ordered.map((entry) => entry.file.path)).toEqual(['server.js', 'test/http.test.js', 'README.md']);
    expect(ordered[1]?.subject?.path).toBe('server.js');
    expect(orderReviewFiles(files, new Map(), 'path').map((entry) => entry.file.path))
      .toEqual(['README.md', 'server.js', 'test/http.test.js']);
  });
});
