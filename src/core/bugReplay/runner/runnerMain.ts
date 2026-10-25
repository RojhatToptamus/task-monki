import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseBugCase } from '../../../shared/bugCase';
import { chromeEnvironment, startChromeOverPipe } from './chromePipe';
import { interpretBugCase } from './runnerInterpreter';
import { BUG_REPLAY_PLAN_SCHEMA, type BugReplayFrame, type BugReplayRunPlan } from './protocol';

/**
 * Entry point of the owned replay runner process:
 *   runner <plan.json> <plan sha256> <nonce> <playwright-core package directory>
 * It re-hashes the plan, starts Chrome over a private pipe, interprets the case and writes one
 * frame per line to stdout. Anything it cannot do becomes a `fatal` frame and a non-zero exit.
 */

async function main(): Promise<number> {
  const [planPath, planSha256, nonce, playwrightPath] = process.argv.slice(2);
  let seq = 0;
  const emit = (frame: BugReplayFrame) => {
    process.stdout.write(`${JSON.stringify({ ...frame, nonce, seq: seq++ })}\n`);
  };
  if (!planPath || !planSha256 || !nonce || !playwrightPath) {
    emit({ type: 'fatal', detail: 'The runner was started without its plan.' });
    return 2;
  }
  let chrome: ReturnType<typeof startChromeOverPipe> | undefined;
  try {
    const bytes = fs.readFileSync(planPath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== planSha256) throw new Error('The run plan changed after it was written.');
    const plan = JSON.parse(bytes.toString('utf8')) as BugReplayRunPlan;
    if (plan.schema !== BUG_REPLAY_PLAN_SCHEMA) throw new Error('The run plan has an unsupported schema.');
    plan.document = parseBugCase(plan.document);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const playwright = require(playwrightPath) as typeof import('playwright-core');
    chrome = startChromeOverPipe({
      executablePath: plan.browser.executablePath,
      userDataDir: plan.browser.userDataDir,
      env: chromeEnvironment(process.env, plan.browser.userDataDir)
    });
    const browser = await withDeadline(playwright.chromium.connectOverCDP(chrome.transport), 30_000, 'The browser did not start.');
    emit({ type: 'run-started', planSha256: actual, browserVersion: browser.version() });
    const deadline = setTimeout(() => {
      const limit = plan.timeouts.runMs >= 120_000 ? `${Math.round(plan.timeouts.runMs / 60_000)} minutes` : `${Math.round(plan.timeouts.runMs / 1000)} seconds`;
      emit({ type: 'fatal', detail: `The run took longer than ${limit}.` });
      chrome?.process.kill('SIGKILL');
      process.exit(3);
    }, plan.timeouts.runMs);
    const counts = await interpretBugCase(browser, plan, emit);
    clearTimeout(deadline);
    emit({ type: 'run-finished', steps: counts.steps, assertions: counts.assertions, frames: seq + 1 });
    await withDeadline(browser.close(), 5_000, 'The browser did not close.').catch(() => undefined);
    return 0;
  } catch (error) {
    emit({ type: 'fatal', detail: (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300) });
    return 1;
  } finally {
    chrome?.transport.close();
    chrome?.process.kill('SIGKILL');
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

void main().then(
  (code) => {
    process.exitCode = code;
    // Flush stdout before exiting so the last frames are never lost.
    process.stdout.write('', () => process.exit(code));
  },
  () => process.exit(1)
);
