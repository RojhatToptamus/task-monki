interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_VERSION_SOURCE =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)' +
  '(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?' +
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';

const CODEX_VERSION_OUTPUT_PATTERN = new RegExp(
  `codex(?:-cli)?\\s+(${SEMVER_VERSION_SOURCE})(?:\\s|$)`
);

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseCodexVersionOutput(stdout: string): string {
  const match = CODEX_VERSION_OUTPUT_PATTERN.exec(stdout);
  if (!match) {
    throw new Error(`Could not parse Codex runtime version from: ${stdout.trim()}`);
  }
  parseSemver(match[1]);
  return match[1];
}

export function compareCodexVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = a[key] - b[key];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function parseSemver(version: string): ParsedSemver {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(
      `Invalid Codex runtime version "${version}". Expected semantic version ` +
        'major.minor.patch with optional prerelease/build metadata.'
    );
  }
  const prerelease = match[4]?.split('.') ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(
        `Invalid Codex runtime version "${version}". Prerelease numeric ` +
          'identifiers must not contain leading zeroes.'
      );
    }
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    if (a === b) {
      continue;
    }
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      return Math.sign(Number.parseInt(a, 10) - Number.parseInt(b, 10));
    }
    if (aNumeric) {
      return -1;
    }
    if (bNumeric) {
      return 1;
    }
    return a < b ? -1 : 1;
  }
  return 0;
}
