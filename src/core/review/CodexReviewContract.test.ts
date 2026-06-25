import { describe, expect, it } from 'vitest';
import {
  codexReviewStatusFromResult,
  parseCodexReviewResult
} from './CodexReviewContract';

describe('CodexReviewContract', () => {
  it('parses the fenced structured review result', () => {
    const result = parseCodexReviewResult(`
Review found one blocker.

\`\`\`json
{
  "schemaVersion": "codex-review/v1",
  "verdict": "NEEDS_CHANGES",
  "summary": "Keyboard shortcut handling leaks listeners.",
  "findings": [
    {
      "id": "listener-leak",
      "severity": "BLOCKER",
      "title": "Keydown listener is never cleaned up",
      "explanation": "Every navigation adds another listener.",
      "path": "src/renderer/ui/App.tsx",
      "line": 142,
      "recommendation": "Remove the listener in the effect cleanup."
    }
  ]
}
\`\`\`
`);

    expect(result?.summary).toBe('Keyboard shortcut handling leaks listeners.');
    expect(result?.findings[0]?.severity).toBe('BLOCKER');
    expect(result?.findings[0]?.path).toBe('src/renderer/ui/App.tsx');
    expect(codexReviewStatusFromResult(result)).toBe('NEEDS_CHANGES');
  });

  it('derives needs-changes from blocker or major findings even with a passing verdict', () => {
    const result = parseCodexReviewResult(`{
      "verdict": "PASSED",
      "summary": "Provider verdict is inconsistent with findings.",
      "findings": [
        {
          "severity": "MAJOR",
          "title": "Shortcut shadows reload",
          "explanation": "The shortcut swallows a browser reload shortcut."
        }
      ]
    }`);

    expect(result?.findings[0]?.id).toBe('major-shortcut-shadows-reload');
    expect(codexReviewStatusFromResult(result)).toBe('NEEDS_CHANGES');
  });

  it('parses native Codex review comments when no JSON result is returned', () => {
    const result = parseCodexReviewResult(`
The patch introduces review-flow regressions that can bypass the review gate.

Full review comments:

- [P2] Pause source-run controls while reviews run — /Users/rojhat/Documents/task-manager/src/renderer/ui/AgentControlPanel.tsx:44-45
  The selected run remains the completed implementation run while a detached review is running.

- [P3] Allow change requests from unstructured reviews — /Users/rojhat/Documents/task-manager/src/renderer/ui/taskView.ts:96-99
  The predicate hides Request changes even though the drawer can build a follow-up from raw output.
`);

    expect(result?.verdict).toBe('NEEDS_CHANGES');
    expect(result?.summary).toBe(
      'The patch introduces review-flow regressions that can bypass the review gate.'
    );
    expect(result?.findings).toHaveLength(2);
    expect(result?.findings[0]).toMatchObject({
      severity: 'MAJOR',
      title: 'Pause source-run controls while reviews run',
      path: 'src/renderer/ui/AgentControlPanel.tsx',
      line: 44,
      endLine: 45
    });
    expect(result?.findings[1]).toMatchObject({
      severity: 'MINOR',
      path: 'src/renderer/ui/taskView.ts',
      line: 96,
      endLine: 99
    });
    expect(codexReviewStatusFromResult(result)).toBe('NEEDS_CHANGES');
  });
});
