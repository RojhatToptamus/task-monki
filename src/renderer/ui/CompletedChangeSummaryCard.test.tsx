import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CompletedChangeSummary } from '../model/completedChangeSummary';
import { CompletedChangeSummaryCard } from './CompletedChangeSummaryCard';

describe('CompletedChangeSummaryCard', () => {
  it('renders a compact completed-run change summary with expandable remaining files', () => {
    const html = renderToStaticMarkup(
      <CompletedChangeSummaryCard summary={summaryFixture()} onReviewChanges={() => {}} />
    );

    expect(html).toContain('Edited 4 files');
    expect(html).toContain('+278');
    expect(html).toContain('-12');
    expect(html).toContain('src/core/app/TaskManagerService.progress.test.ts');
    expect(html).toContain('src/dev/seedData.test.ts');
    expect(html).toContain('src/renderer/model/overviewRunActivity.test.ts');
    expect(html).toContain('Show 1 more file');
    expect(html).toContain('src/renderer/ui/TaskDetail.tsx');
    expect(html).toContain('Review changes');
    expect(html).not.toContain('Undo');
  });

  it('omits the disclosure when the preview contains every changed file', () => {
    const html = renderToStaticMarkup(
      <CompletedChangeSummaryCard
        summary={{
          fileCount: 1,
          title: 'Edited 1 file',
          additions: 2,
          deletions: 1,
          previewFiles: [
            {
              path: 'src/app.ts',
              additions: 2,
              deletions: 1,
              status: 'modified'
            }
          ],
          hiddenFiles: [],
          hiddenFileCount: 0
        }}
        onReviewChanges={() => {}}
      />
    );

    expect(html).toContain('Edited 1 file');
    expect(html).not.toContain('Show 0 more files');
  });
});

function summaryFixture(): CompletedChangeSummary {
  return {
    fileCount: 4,
    title: 'Edited 4 files',
    additions: 278,
    deletions: 12,
    previewFiles: [
      {
        path: 'src/core/app/TaskManagerService.progress.test.ts',
        additions: 6,
        deletions: 6,
        status: 'modified'
      },
      {
        path: 'src/dev/seedData.test.ts',
        additions: 4,
        deletions: 4,
        status: 'modified'
      },
      {
        path: 'src/renderer/model/overviewRunActivity.test.ts',
        additions: 228,
        deletions: 0,
        status: 'modified'
      }
    ],
    hiddenFiles: [
      {
        path: 'src/renderer/ui/TaskDetail.tsx',
        additions: 40,
        deletions: 2,
        status: 'modified'
      }
    ],
    hiddenFileCount: 1
  };
}
