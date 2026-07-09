import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OverviewActivityRow } from '../model/overviewRunActivity';
import { RunActivityTimeline } from './RunActivityTimeline';

describe('RunActivityTimeline', () => {
  it('renders grouped commands as an expandable Overview timeline row', () => {
    const html = renderToStaticMarkup(
      <RunActivityTimeline
        rows={[
          rowFixture({
            key: 'commands',
            kind: 'command',
            icon: 'terminal',
            label: 'Ran',
            detail: '3 commands',
            detailKind: 'count',
            grouped: true,
            defaultOpen: true,
            children: [
              rowFixture({
                key: 'git',
                label: 'Ran',
                detail: 'git diff --check',
                detailKind: 'command'
              }),
              rowFixture({
                key: 'test',
                label: 'Ran',
                detail: 'npm test -- reviewActivity',
                detailKind: 'command'
              }),
              rowFixture({
                key: 'typecheck',
                label: 'Ran',
                detail: 'npm run typecheck',
                detailKind: 'command',
                metric: 'for 2s'
              })
            ]
          })
        ]}
        outputSummary="show full output · 128 lines"
      />
    );

    expect(html).toContain('Activity');
    expect(html).toContain('Ran');
    expect(html).toContain('3 commands');
    expect(html).toContain('git diff --check');
    expect(html).toContain('npm run typecheck');
    expect(html).toContain('for 2s');
    expect(html).toContain('tm-run-activity__detail--command');
    expect(html).toContain('show full output · 128 lines');
    expect(html).not.toContain('Bash');
  });
});

function rowFixture(overrides: Partial<OverviewActivityRow>): OverviewActivityRow {
  return {
    key: overrides.key ?? 'row',
    category: overrides.category ?? 'bash',
    kind: overrides.kind ?? 'command',
    icon: overrides.icon ?? 'terminal',
    label: overrides.label ?? 'Ran',
    detail: overrides.detail,
    detailKind: overrides.detailKind,
    metric: overrides.metric,
    tone: overrides.tone ?? 'neutral',
    status: overrides.status ?? 'completed',
    at: overrides.at ?? '2026-07-07T10:00:00.000Z',
    sourceItemIds: overrides.sourceItemIds ?? [],
    sourceInteractionIds: overrides.sourceInteractionIds ?? [],
    grouped: overrides.grouped,
    defaultOpen: overrides.defaultOpen,
    children: overrides.children
  };
}
