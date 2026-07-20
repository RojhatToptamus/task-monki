import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiffTreeNode } from '../model/diffEvidence';
import { DiffFileTree, DiffScopeControls } from './EvidencePanel';

describe('Evidence composite controls', () => {
  it('uses ordinary pressed buttons for diff scope instead of an incomplete tab contract', () => {
    const html = renderToStaticMarkup(
      <DiffScopeControls value="committed" onChange={() => {}} />
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Diff scope"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
  });

  it('uses a nested list of ordinary buttons instead of an incomplete tree contract', () => {
    const html = renderToStaticMarkup(
      <DiffFileTree
        nodes={diffTreeNodes()}
        selectedFileId="src/index.ts"
        collapsedDirectoryIds={new Set()}
        onToggleDirectory={() => {}}
        onSelectFile={() => {}}
      />
    );

    expect(html).toContain('<ul class="tm-diffbrowser__tree" aria-label="Changed files">');
    expect(html).toContain('<li class="tm-difftree__group">');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-label="Modified"');
    expect(html).not.toContain('role="tree"');
    expect(html).not.toContain('role="treeitem"');
  });
});

function diffTreeNodes(): DiffTreeNode[] {
  const file = {
    id: 'src/index.ts',
    path: 'src/index.ts',
    status: 'modified' as const,
    additions: 2,
    deletions: 1,
    blocks: []
  };
  return [
    {
      type: 'directory',
      id: 'src',
      name: 'src',
      path: 'src',
      additions: 2,
      deletions: 1,
      fileCount: 1,
      children: [
        {
          type: 'file',
          id: file.id,
          name: 'index.ts',
          path: file.path,
          additions: 2,
          deletions: 1,
          fileCount: 1,
          file
        }
      ]
    }
  ];
}
