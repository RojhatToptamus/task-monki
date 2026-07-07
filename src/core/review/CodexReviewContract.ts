import type {
  CodexReviewFinding,
  CodexReviewFindingSeverity,
  CodexReviewGateStatus,
  CodexReviewResult
} from '../../shared/contracts';

const SEVERITIES: CodexReviewFindingSeverity[] = ['BLOCKER', 'MAJOR', 'MINOR', 'NIT'];

export const CODEX_REVIEW_RESULT_SCHEMA_VERSION = 'codex-review/v1' as const;

export function parseCodexReviewResult(text: string | undefined): CodexReviewResult | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const jsonText = extractJsonBlock(text) ?? extractBareJson(text);
  if (!jsonText) {
    return parseNativeCodexReviewResult(text);
  }
  try {
    return normalizeReviewResult(JSON.parse(jsonText));
  } catch {
    return parseNativeCodexReviewResult(text);
  }
}

export function codexReviewStatusFromResult(
  result: CodexReviewResult | undefined
): Extract<CodexReviewGateStatus, 'PASSED' | 'NEEDS_CHANGES' | 'INCONCLUSIVE'> | undefined {
  if (!result) {
    return undefined;
  }
  if (
    result.verdict === 'NEEDS_CHANGES' ||
    result.findings.some(
      (finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR'
    )
  ) {
    return 'NEEDS_CHANGES';
  }
  if (result.verdict === 'PASSED') {
    return 'PASSED';
  }
  return 'INCONCLUSIVE';
}

export function normalizeReviewResult(value: unknown): CodexReviewResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const verdict = normalizeVerdict(value.verdict ?? value.status);
  const findingsValue = Array.isArray(value.findings) ? value.findings : [];
  const findings = findingsValue
    .map((finding, index) => normalizeFinding(finding, index))
    .filter((finding): finding is CodexReviewFinding => Boolean(finding));
  const summary =
    typeof value.summary === 'string' && value.summary.trim()
      ? value.summary.trim()
      : defaultSummary(verdict, findings);
  return {
    schemaVersion: CODEX_REVIEW_RESULT_SCHEMA_VERSION,
    verdict,
    summary,
    findings
  };
}

function extractJsonBlock(text: string): string | undefined {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

function extractBareJson(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1).trim();
}

function normalizeVerdict(value: unknown): CodexReviewResult['verdict'] {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (normalized === 'PASSED' || normalized === 'PASS') {
    return 'PASSED';
  }
  if (normalized === 'NEEDS_CHANGES' || normalized === 'CHANGES_REQUESTED') {
    return 'NEEDS_CHANGES';
  }
  return 'INCONCLUSIVE';
}

function normalizeFinding(value: unknown, index: number): CodexReviewFinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const severity = normalizeSeverity(value.severity);
  const title = stringValue(value.title) ?? stringValue(value.message);
  const explanation =
    stringValue(value.explanation) ??
    stringValue(value.rationale) ??
    stringValue(value.detail) ??
    stringValue(value.body);
  if (!severity || !title || !explanation) {
    return undefined;
  }
  const path = stringValue(value.path) ?? stringValue(value.file);
  const line = numberValue(value.line) ?? numberValue(value.startLine);
  return {
    id: stringValue(value.id) ?? stableFindingId(severity, title, index),
    severity,
    title,
    explanation,
    path,
    line,
    endLine: numberValue(value.endLine),
    recommendation: stringValue(value.recommendation) ?? stringValue(value.fix)
  };
}

function normalizeSeverity(value: unknown): CodexReviewFindingSeverity | undefined {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return SEVERITIES.includes(normalized as CodexReviewFindingSeverity)
    ? (normalized as CodexReviewFindingSeverity)
    : undefined;
}

function parseNativeCodexReviewResult(text: string): CodexReviewResult | undefined {
  const findings = parseNativeCodexFindings(text);
  if (findings.length > 0) {
    const verdict = findings.some(
      (finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR'
    )
      ? 'NEEDS_CHANGES'
      : 'PASSED';
    return {
      schemaVersion: CODEX_REVIEW_RESULT_SCHEMA_VERSION,
      verdict,
      summary: nativeSummary(text, findings),
      findings
    };
  }

  if (/\bno findings\b/i.test(text) || /\bno actionable findings\b/i.test(text)) {
    return {
      schemaVersion: CODEX_REVIEW_RESULT_SCHEMA_VERSION,
      verdict: 'PASSED',
      summary: nativeSummary(text, []),
      findings: []
    };
  }

  return undefined;
}

function parseNativeCodexFindings(text: string): CodexReviewFinding[] {
  const lines = text.split(/\r?\n/);
  const findings: CodexReviewFinding[] = [];
  let current:
    | {
        priority: string;
        title: string;
        location: string;
        body: string[];
      }
    | undefined;

  const flush = () => {
    if (!current) {
      return;
    }
    const severity = severityFromPriority(current.priority);
    if (!severity) {
      current = undefined;
      return;
    }
    const location = parseNativeLocation(current.location);
    const explanation = current.body.join('\n').trim() || current.title;
    findings.push({
      id: stableFindingId(severity, current.title, findings.length),
      severity,
      title: current.title.trim(),
      explanation,
      path: location.path,
      line: location.line,
      endLine: location.endLine
    });
    current = undefined;
  };

  for (const line of lines) {
    const header = line.match(/^\s*-\s+\[(P[0-5])\]\s+(.+?)\s+(?:—|--|-)\s+(.+?)\s*$/);
    if (header) {
      flush();
      current = {
        priority: header[1],
        title: header[2],
        location: header[3],
        body: []
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed) {
      current.body.push(trimmed);
    }
  }
  flush();

  return findings;
}

function severityFromPriority(priority: string): CodexReviewFindingSeverity | undefined {
  switch (priority) {
    case 'P0':
    case 'P1':
      return 'BLOCKER';
    case 'P2':
      return 'MAJOR';
    case 'P3':
      return 'MINOR';
    case 'P4':
    case 'P5':
      return 'NIT';
    default:
      return undefined;
  }
}

function parseNativeLocation(location: string): {
  path?: string;
  line?: number;
  endLine?: number;
} {
  const trimmed = location.trim();
  const match = trimmed.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!match) {
    return { path: normalizeNativePath(trimmed) };
  }
  const line = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : undefined;
  return {
    path: normalizeNativePath(match[1]),
    line: Number.isFinite(line) ? line : undefined,
    endLine: endLine !== undefined && Number.isFinite(endLine) ? endLine : undefined
  };
}

function normalizeNativePath(path: string): string | undefined {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    return undefined;
  }
  const relativeMatch = normalized.match(
    /(?:^|\/)((?:src|test|tests|packages|apps|lib|server|renderer|core|shared)\/.+)$/
  );
  return relativeMatch?.[1] ?? normalized;
}

function nativeSummary(text: string, findings: CodexReviewFinding[]): string {
  const beforeComments = text.split(/Full review comments:/i)[0]?.trim();
  if (beforeComments) {
    return beforeComments;
  }
  return defaultSummary(
    findings.some((finding) => finding.severity === 'BLOCKER' || finding.severity === 'MAJOR')
      ? 'NEEDS_CHANGES'
      : 'PASSED',
    findings
  );
}

function defaultSummary(
  verdict: CodexReviewResult['verdict'],
  findings: CodexReviewFinding[]
): string {
  if (findings.length === 0 && verdict === 'PASSED') {
    return 'Codex review passed with no findings.';
  }
  if (findings.length > 0) {
    return `Codex review found ${findings.length} finding${findings.length === 1 ? '' : 's'}.`;
  }
  return 'Codex review completed without a structured summary.';
}

function stableFindingId(
  severity: CodexReviewFindingSeverity,
  title: string,
  index: number
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${severity.toLowerCase()}-${slug || `finding-${index + 1}`}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
