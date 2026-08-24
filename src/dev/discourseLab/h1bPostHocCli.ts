import path from 'node:path';
import {
  buildH1bV3PostHocAudit,
  writeH1bV3PostHocAudit
} from './h1bPostHocAudit';

async function main(): Promise<void> {
  const [archivedReportPath, outputPath] = process.argv.slice(2);
  if (!archivedReportPath || !outputPath) {
    throw new Error('Usage: h1bPostHocCli ARCHIVED_REPORT OUTPUT_REPORT');
  }
  const report = await buildH1bV3PostHocAudit({
    fixtureRoot: path.resolve('evaluation/discourse-lab'),
    archivedReportPath: path.resolve(archivedReportPath)
  });
  await writeH1bV3PostHocAudit(path.resolve(outputPath), report);
  process.stdout.write(`${JSON.stringify({ outputPath: path.resolve(outputPath), report })}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
