import { spawn, type ChildProcess } from 'node:child_process';
import type { ConnectOverCDPTransport } from 'playwright-core';

/**
 * Starts Chrome for Testing as a child of the current process, in its process group, with the
 * DevTools protocol on a private pipe (fds 3 and 4). There is no debugging port, so nothing else
 * on the machine, including the app under test, can drive this browser. Killing the runner's
 * process group ends Chrome too.
 */

/** Playwright 1.63.0's launch switches (`chromiumSwitches`), kept verbatim for the pinned version. */
export const PLAYWRIGHT_163_CHROMIUM_SWITCHES: readonly string[] = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-edgeupdater',
  '--disable-extensions',
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion',
  '--enable-features=CDPScreenshotNewSurface',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-updater-scheduler',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--export-tagged-pdf',
  '--disable-search-engine-choice-screen',
  '--unsafely-disable-devtools-self-xss-warnings',
  '--edge-skip-compat-layer-relaunch',
  '--disable-infobars',
  '--disable-sync'
];

export interface ChromeOverPipe {
  process: ChildProcess;
  transport: ConnectOverCDPTransport;
  /** Recent stderr lines, for diagnostics only. */
  stderrTail(): string;
}

export function startChromeOverPipe(options: {
  executablePath: string;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
}): ChromeOverPipe {
  const child = spawn(
    options.executablePath,
    [
      ...PLAYWRIGHT_163_CHROMIUM_SWITCHES,
      '--headless',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-startup-window',
      '--remote-debugging-pipe',
      // WebRTC could reach hosts the request guard never sees.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      `--user-data-dir=${options.userDataDir}`
    ],
    {
      // Chrome stays in this process's group, so the owned launcher's group kill reaches it.
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: options.env
    }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-8192);
  });
  const writer = child.stdio[3] as NodeJS.WritableStream;
  const reader = child.stdio[4] as NodeJS.ReadableStream;
  let pending: Buffer = Buffer.alloc(0);
  let closed = false;
  const transport: ConnectOverCDPTransport = {
    send(message: object) {
      if (closed) return;
      writer.write(`${JSON.stringify(message)}\0`);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        writer.end();
      } catch {
        // Chrome may already be gone.
      }
    }
  };
  reader.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let end: number;
    while ((end = pending.indexOf(0)) >= 0) {
      const text = pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1);
      if (!text) continue;
      try {
        transport.onmessage?.(JSON.parse(text) as object);
      } catch {
        // A malformed protocol message is dropped; Playwright times the command out.
      }
    }
  });
  const onClose = () => {
    if (closed) return;
    closed = true;
    transport.onclose?.('Chrome closed its DevTools pipe.');
  };
  reader.on('close', onClose);
  reader.on('error', onClose);
  child.on('exit', onClose);
  return { process: child, transport, stderrTail: () => stderr };
}

/** Only these variables reach Chrome; everything else, including ELECTRON_RUN_AS_NODE, is dropped. */
export function chromeEnvironment(source: NodeJS.ProcessEnv, tmpdir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TMPDIR: tmpdir };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ']) {
    if (source[key]) env[key] = source[key];
  }
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}
