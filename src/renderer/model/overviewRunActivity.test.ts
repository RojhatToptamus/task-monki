import { describe, expect, it } from 'vitest';
import type { RunActivityRow } from './runActivity';
import {
  buildOverviewRunActivityRows,
  overviewActivitySummary
} from './overviewRunActivity';

describe('overview run activity projection', () => {
  it('formats active command copy without shell wrappers', () => {
    const rows = buildOverviewRunActivityRows([
      commandRow({
        key: 'verify',
        category: 'verify',
        label: 'Verify',
        detail: 'npm test',
        status: 'active',
        tone: 'action'
      })
    ]);

    expect(rows).toMatchObject([
      {
        kind: 'command',
        icon: 'terminal',
        label: 'Running',
        detail: 'npm test',
        detailKind: 'command',
        status: 'active'
      }
    ]);
    expect(overviewActivitySummary(rows[0])).toBe('Running npm test');
    expect(JSON.stringify(rows)).not.toContain('/bin/zsh');
  });

  it('formats completed command copy with a readable duration', () => {
    const rows = buildOverviewRunActivityRows([
      commandRow({
        key: 'verify',
        category: 'verify',
        label: 'Verify',
        detail: 'npm test',
        metric: '0:18'
      })
    ]);

    expect(rows).toMatchObject([
      {
        label: 'Ran',
        detail: 'npm test',
        metric: 'for 18s'
      }
    ]);
    expect(overviewActivitySummary(rows[0])).toBe('Ran npm test for 18s');
  });

  it('groups consecutive completed commands and keeps expandable child data', () => {
    const rows = buildOverviewRunActivityRows([
      commandRow({ key: 'git', category: 'git', detail: 'git diff --check' }),
      commandRow({ key: 'test', category: 'verify', detail: 'npm test -- reviewActivity' }),
      commandRow({
        key: 'typecheck',
        category: 'verify',
        detail: 'npm run typecheck',
        metric: '0:02'
      })
    ]);

    expect(rows).toMatchObject([
      {
        key: 'overview:commands:overview:git',
        label: 'Ran',
        detail: '3 commands',
        grouped: true,
        defaultOpen: true,
        children: [
          { label: 'Ran', detail: 'git diff --check' },
          { label: 'Ran', detail: 'npm test -- reviewActivity' },
          { label: 'Ran', detail: 'npm run typecheck', metric: 'for 2s' }
        ]
      }
    ]);
  });

  it('keeps command group keys stable when later activity is appended', () => {
    const initial = buildOverviewRunActivityRows([
      commandRow({ key: 'git', category: 'git', detail: 'git diff --check' }),
      commandRow({ key: 'test', category: 'verify', detail: 'npm test -- reviewActivity' })
    ]);
    const appended = buildOverviewRunActivityRows([
      commandRow({ key: 'git', category: 'git', detail: 'git diff --check' }),
      commandRow({ key: 'test', category: 'verify', detail: 'npm test -- reviewActivity' }),
      contextRow({ key: 'read', category: 'read', label: 'Read', detail: 'src/app.ts' })
    ]);

    expect(appended[0]?.key).toBe(initial[0]?.key);
  });

  it('includes useful agent messages but drops filler progress messages', () => {
    const rows = buildOverviewRunActivityRows([
      progressRow('filler', 'Working.'),
      progressRow(
        'intent',
        "I'm rerunning the focused review model test and typecheck after that cleanup."
      )
    ]);

    expect(rows).toMatchObject([
      {
        kind: 'prose',
        icon: 'message',
        label: "I'm rerunning the focused review model test and typecheck after that cleanup."
      }
    ]);
  });

  it('keeps context and file changes compact for Overview', () => {
    const rows = buildOverviewRunActivityRows([
      contextRow({
        key: 'read-group',
        category: 'read',
        label: 'Read',
        detail: '6 files',
        grouped: true,
        children: [
          contextRow({ key: 'read-a', category: 'read', label: 'Read', detail: 'src/a.ts' }),
          contextRow({ key: 'read-b', category: 'read', label: 'Read', detail: 'src/b.ts' })
        ]
      }),
      contextRow({
        key: 'search-group',
        category: 'search',
        label: 'Searched',
        detail: '3 times',
        grouped: true
      }),
      fileRow({
        key: 'edit',
        category: 'edit',
        label: 'Edit',
        detail: 'src/renderer/router.tsx',
        metric: '+6 -1'
      }),
      fileRow({
        key: 'write',
        category: 'write',
        label: 'Write',
        detail: 'src/renderer/pages/Home.tsx',
        metric: '+48'
      })
    ]);

    expect(rows.map(overviewActivitySummary)).toEqual([
      'Read 6 files',
      'Searched 3 times',
      'Edited src/renderer/router.tsx +6 -1',
      'Wrote src/renderer/pages/Home.tsx +48'
    ]);
    expect(rows[0]).toMatchObject({
      grouped: true,
      children: [
        { label: 'Read', detail: 'src/a.ts' },
        { label: 'Read', detail: 'src/b.ts' }
      ]
    });
  });
});

function commandRow(overrides: Partial<RunActivityRow>): RunActivityRow {
  return rowFixture({
    category: 'verify',
    label: 'Verify',
    detail: 'npm test',
    metric: undefined,
    status: 'completed',
    tone: 'success',
    ...overrides
  });
}

function contextRow(overrides: Partial<RunActivityRow>): RunActivityRow {
  return rowFixture({
    category: 'read',
    label: 'Read',
    detail: 'src/app.ts',
    status: 'completed',
    tone: 'neutral',
    ...overrides
  });
}

function fileRow(overrides: Partial<RunActivityRow>): RunActivityRow {
  return rowFixture({
    category: 'edit',
    label: 'Edit',
    detail: 'src/app.ts',
    status: 'completed',
    tone: 'neutral',
    ...overrides
  });
}

function progressRow(key: string, detail: string): RunActivityRow {
  return rowFixture({
    key,
    category: 'other',
    label: 'Progress',
    detail,
    status: 'completed',
    tone: 'neutral'
  });
}

function rowFixture(overrides: Partial<RunActivityRow>): RunActivityRow {
  return {
    key: overrides.key ?? 'row',
    category: overrides.category ?? 'other',
    label: overrides.label ?? 'Progress',
    detail: overrides.detail,
    metric: overrides.metric,
    tone: overrides.tone ?? 'neutral',
    status: overrides.status ?? 'completed',
    at: overrides.at ?? '2026-07-07T10:00:00.000Z',
    sourceItemIds: overrides.sourceItemIds ?? [overrides.key ?? 'row'],
    sourceInteractionIds: overrides.sourceInteractionIds ?? [],
    grouped: overrides.grouped,
    children: overrides.children
  };
}
