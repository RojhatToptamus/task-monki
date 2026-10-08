import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  analyzePreviewFrameworkCapabilities,
  inspectPreviewFrameworkRepositoryFacts
} from './generation/PreviewFrameworkCapabilities';
import path from 'node:path';
import type {
  PreviewRuntime,
  PreviewStatus,
  PreviewDescription
} from 'previewhost';
import type { PreviewDiagnosis } from '../../shared/applicationPreview';

/** Recommendations are evidence, not permission to change or execute configuration. */
export async function diagnosePreviewFailure(
  runtime: PreviewRuntime,
  name: string,
  status: PreviewStatus,
  file?: PreviewDescription
): Promise<PreviewDiagnosis | undefined> {
  const attempt = status.latest;
  if (!attempt || attempt.state !== 'failed') return;
  const service = Object.entries(attempt.services ?? {}).find(
    ([, node]) => node.state === 'failed'
  )?.[0];
  const error = service
    ? (attempt.services?.[service]?.error ?? attempt.error)
    : attempt.error;
  const logs = await runtime
    .logs(name, attempt.id, { source: service, maxBytes: 4096 })
    .catch(() => undefined);
  const description = await runtime
    .describe(name, attempt.id)
    .catch(() => file);
  const spec = description?.spec;
  const node =
    spec?.type === 'environment'
      ? spec.services[service ?? spec.primary]
      : spec;
  const observed = error?.message ?? 'The preview stopped before it was ready.';
  const text = `${observed}\n${logs?.text ?? ''}`;
  const result: PreviewDiagnosis = {
    attemptId: attempt.id,
    service,
    title: `${service ?? 'Application'} could not start`,
    summary:
      status.active && status.url
        ? 'The runtime still reports the previous preview serving. Shared files and data may have changed.'
        : 'Nothing is serving. Review the failure before starting again.',
    action: 'agent',
    actionLabel: 'Investigate with Preview agent',
    observed,
    unknown:
      'Commands that ran may have changed files or data. Stopping or retrying does not undo those changes.',
    guarantee:
      spec?.type === 'compose'
        ? 'Compose stops the previous application before replacement. Data is retained across Stop.'
        : 'Routes switch after readiness. Shared files and databases are not rolled back.',
    excerpt: logs?.text.trim().split('\n').slice(-2).join('\n') || undefined
  };
  if (error?.code === 'SUPERVISOR_FAILED') {
    result.title = 'The packaged process supervisor could not start';
    result.action = 'logs';
    result.actionLabel = 'Open startup diagnostics';
    result.summary =
      'Check the startup diagnostics. This failure occurs before the project command can run.';
  } else if (error?.code?.startsWith('SECRET_')) {
    result.title = 'Secret storage needs attention';
    result.action = 'secrets';
    result.actionLabel = 'Resolve required secrets';
  } else if (error?.code === 'SOURCE_DENIED') {
    result.title = 'A source folder needs connection';
    result.action = 'source';
    result.actionLabel = 'Review folder access';
  } else if (error?.code === 'CLEANUP_INCOMPLETE') {
    result.title = 'Previous resources could not be stopped';
    result.action = 'cleanup';
    result.actionLabel = 'Retry cleanup';
  } else if (
    /(?:no such image|image .*not found|image .*missing|pull access denied)/i.test(
      text
    )
  ) {
    result.title = 'A required container image is unavailable';
    const image =
      /(?:image[ :]+)["']?([a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?)/i.exec(
        text
      )?.[1];
    if (image) {
      result.action = 'image';
      result.actionLabel = 'Copy image download command';
      result.command = `docker pull ${image}`;
    }
  } else if (
    /docker.*(?:socket|daemon|connect|unavailable)|connect.*docker/i.test(text)
  ) {
    result.title = 'Docker is unavailable';
    result.action = 'docker';
    result.actionLabel = 'Start again';
    result.summary =
      'Start Docker Desktop, wait for its engine to be ready, then start Preview again.';
  } else if (
    /relation .*already exists|migration.*failed|Traceback|SyntaxError|TypeError|ReferenceError/i.test(
      text
    )
  ) {
    result.title = `${service ?? 'Application'} reported an application error`;
    result.action = 'task-agent';
    result.actionLabel = 'Send to task agent';
  } else if (
    /ENOENT|exited \(127\)|exit(?:ed)?(?: with code)? 127|command not found/i.test(
      text
    ) &&
    node &&
    'command' in node &&
    node.command &&
    'cwd' in node &&
    node.cwd
  ) {
    const command = node.command;
    const projectCommand =
      command[0]?.includes('node_modules/.bin/') ||
      (/^(npm|pnpm|yarn)$/.test(command[0] ?? '') && command.includes('run'));
    const manifest = await fs.access(path.join(node.cwd, 'package.json')).then(
      () => true,
      () => false
    );
    const lock = (
      await Promise.all(
        ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map((file) =>
          fs.access(path.join(node.cwd!, file)).then(
            () => true,
            () => false
          )
        )
      )
    ).some(Boolean);
    const hasInstall =
      spec?.type === 'environment' &&
      Object.values(spec.services).some(
        (other) =>
          other.type === 'job' &&
          other.cwd === node.cwd &&
          other.command?.some((arg) => ['ci', 'install'].includes(arg))
      );
    if (projectCommand && manifest && lock && !hasInstall) {
      result.title = 'Project dependencies need an install step';
      result.action = 'install';
      result.actionLabel = 'Add install step';
    } else result.title = 'The configured command could not be found';
  } else if (
    error?.code === 'TIMEOUT' &&
    /connection refused|ECONNREFUSED|closed before headers/i.test(text)
  ) {
    result.title = 'The service did not answer on its allocated port';
    result.unknown =
      'The last readiness probe could not connect. Check whether the command honors PORT and HOST; the output does not establish why it stopped listening.';
  } else if (error?.code === 'TIMEOUT' && /\b50[0-9]\b/.test(text)) {
    result.title = 'The service answered with an error during readiness';
    result.unknown =
      'The last readiness response was a server error. The response alone does not establish its cause.';
  } else if (error?.code === 'TIMEOUT' && /\b404\b/.test(text)) {
    result.title = 'The readiness URL was not found';
    result.action = 'readiness';
    result.actionLabel = 'Review readiness path';
  }
  if (
    result.action !== 'install' &&
    node &&
    'command' in node &&
    node.command &&
    'cwd' in node &&
    node.cwd &&
    /^(npm|pnpm|yarn)$/.test(node.command[0] ?? '') &&
    node.command.includes('dev')
  ) {
    const manifest = await fs
      .open(
        path.join(node.cwd, 'package.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW
      )
      .catch(() => undefined);
    if (manifest) {
      try {
        const bytes = Buffer.alloc(65_537);
        const { bytesRead } = await manifest.read(bytes, 0, bytes.length, 0);
        if (bytesRead <= 65_536) {
          const facts = await inspectPreviewFrameworkRepositoryFacts(node.cwd);
          const capability = analyzePreviewFrameworkCapabilities(
            [
              {
                path: 'package.json',
                content: bytes.subarray(0, bytesRead).toString('utf8')
              }
            ],
            facts
          ).analyses[0];
          if (
            capability?.compatiblePreviewCommand &&
            capability.conflicts.some(
              (conflict) =>
                conflict.code === 'FIXED_PORT' ||
                conflict.code === 'HTTPS_LISTENER'
            )
          ) {
            result.title = 'The development script conflicts with Preview';
            result.action = 'command';
            result.actionLabel = 'Use compatible command';
            result.observed +=
              '\n' +
              capability.conflicts.map((conflict) => conflict.detail).join(' ');
            result.command = capability.compatiblePreviewCommand.join(' ');
            result.summary =
              'Review a command that uses HTTP and the port allocated by Preview.';
          }
        }
      } catch {
        // Missing or unreadable project evidence must not hide the runtime failure.
      } finally {
        await manifest.close();
      }
    }
  }
  return result;
}
