import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBrowser } from "@remotion/renderer";
import { startDemoApiServer } from "./serve-remotion-demo-api.mjs";
import {
  ROUGH_PROMPT,
  SHOWCASE_TASK_ID,
  SHOWCASE_TASKS,
} from "./showcase-demo-data.mjs";
import { startShowcasePreviewApp } from "./showcase-preview-app.mjs";

const sceneFile = new URL("./showcase-scenes.json", import.meta.url);
let browserPageIndex = 0;

export async function runShowcaseCapture({
  rootDir,
  outputDir,
  apiPort,
  rendererPort,
  previewPort = 43130,
}) {
  const sceneSource = await readFile(sceneFile);
  const scenes = JSON.parse(sceneSource);
  validateSceneContract(scenes);

  await runCommand("npm", ["run", "dev:seed"], rootDir);
  await clearCaptureFiles(outputDir);

  const preview = await startShowcasePreviewApp({ port: previewPort });
  const apiServer = await startDemoApiServer({
    port: apiPort,
    previewUrl: preview.url,
    previewEvidence: preview.evidence,
  });
  const viteBin = path.join(rootDir, "node_modules", ".bin", "vite");
  const appUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = spawn(
    viteBin,
    ["--host", "127.0.0.1", "--port", String(rendererPort), "--strictPort"],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        TASK_MANAGER_API_PORT: String(apiPort),
        TASK_MANAGER_RENDERER_PORT: String(rendererPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let viteLog = "";
  vite.stdout.on("data", (chunk) => {
    viteLog += chunk.toString();
  });
  vite.stderr.on("data", (chunk) => {
    viteLog += chunk.toString();
  });

  let browser;
  try {
    await waitForHttp(appUrl, 60_000, () => {
      if (vite.exitCode !== null) {
        throw new Error(`Vite exited before becoming ready.\n${viteLog}`);
      }
    });

    browser = await openBrowser("chrome", {
      chromiumOptions: { darkMode: true, headless: true },
      forceDeviceScaleFactor: 1,
      logLevel: "error",
    });
    const mainPage = await createPage(browser);
    await mainPage.evaluateOnNewDocument(() => {
      window.localStorage.setItem("task-monki-theme", "dark");
      window.open = (url) => {
        window.__taskMonkiShowcaseOpenedUrl = String(url ?? "");
        return null;
      };
    });
    await mainPage.goto({ url: appUrl, timeout: 60_000 });
    await waitForText(mainPage, "All tasks");
    await waitForText(mainPage, SHOWCASE_TASKS.ready);

    const revision = await runCommandCapture(
      "git",
      ["rev-parse", "HEAD"],
      rootDir,
    );
    const dirtyState = await runCommandCapture(
      "git",
      ["status", "--porcelain=v1"],
      rootDir,
    );
    const manifest = {
      schemaVersion: 1,
      runId: `showcase-${Date.now()}`,
      capturedAt: new Date().toISOString(),
      viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
      task: {
        id: SHOWCASE_TASK_ID,
        title: SHOWCASE_TASKS.atlas,
        repository: "Atlas Web",
        branch: preview.branch,
      },
      provenance: {
        gitRevision: revision.trim(),
        dirtyStateSha256: sha256(Buffer.from(dirtyState)),
        sceneSpecSha256: sha256(sceneSource),
        renderer: { origin: appUrl, pid: vite.pid },
        api: { origin: apiServer.url, pid: process.pid },
        preview: {
          origin: preview.url,
          pid: preview.pid,
          repositoryPath: preview.repositoryPath,
          baseSha: preview.evidence.baseSha,
          implementationSha: preview.evidence.implementationSha,
          finalSha: preview.evidence.finalSha,
          testCommand: "node --test dashboard.test.mjs",
          testSummary: preview.evidence.testSummary,
          testOutputSha256: sha256(Buffer.from(preview.evidence.testOutput)),
        },
      },
      scenes: [],
    };

    let previewPage;
    for (const scene of scenes) {
      if (scene.sourceKind === "preview-inset" && !previewPage) {
        await waitForPredicate(mainPage, () =>
          Boolean(window.__taskMonkiShowcaseOpenedUrl),
        );
        previewPage = await createPage(browser);
        await previewPage.goto({ url: preview.url, timeout: 60_000 });
      }
      const page =
        scene.sourceKind === "preview-inset" ? previewPage : mainPage;
      let record;
      try {
        record = await captureScene({
          page,
          scene,
          outputDir,
          appUrl,
          previewUrl: preview.url,
        });
      } catch (error) {
        const failureImage = path.join(outputDir, `failure-${scene.id}.png`);
        await writeFile(failureImage, await capturePng(page));
        const failureState = await inspectPage(page);
        throw new Error(
          `Scene ${scene.id} failed before capture. ` +
            `State: ${JSON.stringify(failureState)}. ` +
            `Failure image: ${failureImage}. ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      manifest.scenes.push(record);
      try {
        await performExitAction({
          page: mainPage,
          scene,
          record,
        });
      } catch (error) {
        const failureImage = path.join(outputDir, `failure-${scene.id}.png`);
        await writeFile(failureImage, await capturePng(mainPage));
        const failureState = await inspectPage(mainPage);
        throw new Error(
          `Scene ${scene.id} failed after capture. ` +
            `State: ${JSON.stringify(failureState)}. ` +
            `Failure image: ${failureImage}. ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    manifest.captureSetSha256 = sha256(
      Buffer.from(
        manifest.scenes
          .map((scene) => `${scene.image}:${scene.sha256}`)
          .join("\n"),
      ),
    );
    await writeFile(
      path.join(outputDir, "capture-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    return {
      outputDir,
      captures: manifest.scenes.length,
      manifestPath: path.join(outputDir, "capture-manifest.json"),
      previewRepositoryPath: preview.repositoryPath,
      previewBranch: preview.branch,
    };
  } finally {
    if (browser) await browser.close({ silent: true });
    await stopProcess(vite);
    await apiServer.close();
    await preview.close();
  }
}

async function createPage(browser) {
  const page = await browser.newPage({
    context: () => null,
    logLevel: "error",
    indent: false,
    pageIndex: browserPageIndex++,
    onBrowserLog: null,
    onLog: () => {},
  });
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  return page;
}

async function captureScene({ page, scene, outputDir, appUrl, previewUrl }) {
  for (const text of scene.requiredText ?? []) await waitForText(page, text);
  for (const text of scene.forbiddenText ?? []) {
    await waitForTextAbsent(page, text);
  }
  await waitForNoNotifiers(page);
  await settle(page);

  let action;
  if (["click", "fill"].includes(scene.exitAction?.kind)) {
    action = await prepareTarget(page, scene.exitAction);
    if (scene.exitAction.kind === "fill") {
      await dispatchRealClick(page, action.point);
    }
    await settle(page);
  }

  const state = await inspectPage(page);
  const expectedOrigin =
    scene.sourceKind === "preview-inset" ? previewUrl : appUrl;
  if (!state.url.startsWith(expectedOrigin)) {
    throw new Error(
      `Scene ${scene.id} came from ${state.url}, expected ${expectedOrigin}.`,
    );
  }
  if (
    scene.sourceKind === "task-monki" &&
    (state.title !== "Task Monki" || !state.hasTaskMonkiRoot)
  ) {
    throw new Error(`Scene ${scene.id} is not the Task Monki renderer.`);
  }
  if (
    scene.sourceKind === "preview-inset" &&
    (state.title !== "Atlas Launch Operations" ||
      state.appMarker !== "atlas-preview" ||
      !state.previewReady)
  ) {
    throw new Error(`Scene ${scene.id} is not the owned Atlas preview.`);
  }

  const imagePath = path.join(outputDir, scene.image);
  const buffer = await capturePng(page);
  await writeFile(imagePath, buffer);
  const dimensions = pngDimensions(buffer);
  if (dimensions.width !== 1920 || dimensions.height !== 1080) {
    throw new Error(
      `Scene ${scene.id} is ${dimensions.width}x${dimensions.height}; expected 1920x1080.`,
    );
  }

  return {
    id: scene.id,
    image: scene.image,
    sourceKind: scene.sourceKind,
    sha256: sha256(buffer),
    byteCount: buffer.length,
    dimensions,
    page: state,
    action,
  };
}

async function performExitAction({ page, scene, record }) {
  const action = scene.exitAction;
  if (!action) return;
  if (action.kind === "click" || action.kind === "fill") {
    await dispatchRealClick(page, record.action.point);
    if (action.kind === "fill") {
      await setInputValue(
        page,
        action.target.selector,
        action.value === "roughPrompt" ? ROUGH_PROMPT : action.value,
      );
    }
  } else if (action.kind === "advance") {
    await page.evaluate(
      async ({ taskId, to }) => {
        const response = await fetch("/api/showcase/advance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId, to }),
        });
        if (!response.ok) throw new Error(await response.text());
      },
      { taskId: SHOWCASE_TASK_ID, to: action.to },
    );
  } else if (action.kind !== "wait") {
    throw new Error(`Unsupported scene action ${action.kind}.`);
  }

  for (const text of action.resultText ?? []) await waitForText(page, text);
  if (scene.id === "preview-workspace") {
    await waitForPredicate(page, () =>
      Boolean(window.__taskMonkiShowcaseOpenedUrl),
    );
  }
  await settle(page);
}

async function prepareTarget(page, action) {
  const target = await page.evaluate((input) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll(input.selector));
    const matched = candidates.filter((candidate) => {
      if (!input.text) return true;
      const visibleText = normalize(candidate.textContent ?? "");
      const aria = normalize(candidate.getAttribute("aria-label") ?? "");
      return input.exact
        ? visibleText === input.text || aria === input.text
        : visibleText.includes(input.text) || aria.includes(input.text);
    });
    if (matched.length !== 1) {
      return {
        error: `Expected one target, found ${matched.length}`,
        candidates: candidates.map((candidate) => ({
          text: normalize(candidate.textContent ?? ""),
          aria: normalize(candidate.getAttribute("aria-label") ?? ""),
        })),
      };
    }
    const element = matched[0];
    element.scrollIntoView({ block: "center", inline: "center" });
    if (input.kind === "fill") element.focus({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const point = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    const hit = document.elementFromPoint(point.x, point.y);
    const hitMatches = hit === element || element.contains(hit);
    return {
      selector: input.selector,
      text: input.text,
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      point,
      hitMatches,
      hit: hit
        ? {
            tag: hit.tagName.toLowerCase(),
            text: normalize(hit.textContent ?? "").slice(0, 160),
            aria: hit.getAttribute("aria-label"),
          }
        : null,
    };
  }, action.target);
  if (target.error) {
    throw new Error(
      `Could not resolve ${action.label}: ${target.error}. ${JSON.stringify(target.candidates)}`,
    );
  }
  if (
    target.rect.width <= 0 ||
    target.rect.height <= 0 ||
    target.point.x < target.rect.x ||
    target.point.x > target.rect.x + target.rect.width ||
    target.point.y < target.rect.y ||
    target.point.y > target.rect.y + target.rect.height ||
    !target.hitMatches
  ) {
    throw new Error(
      `Target geometry for ${action.label} failed hit testing: ${JSON.stringify(target)}`,
    );
  }
  return { kind: action.kind, label: action.label, ...target };
}

async function dispatchRealClick(page, point) {
  const client = page._client();
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function inspectPage(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    appMarker: document.documentElement.dataset.app ?? null,
    previewReady: document.documentElement.dataset.dashboardReady === "true",
    hasTaskMonkiRoot: Boolean(
      document.querySelector("#root .tm-shell, #root .app-shell, #root main"),
    ),
    overlays: {
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(
        (element) =>
          element.getAttribute("aria-label") ??
          element.getAttribute("aria-labelledby") ??
          element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120),
      ),
      notifiers: Array.from(
        document.querySelectorAll(".tm-notifier__item"),
      ).map((element) => element.textContent?.replace(/\s+/g, " ").trim()),
    },
  }));
}

async function capturePng(page) {
  const result = await page._client().send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return Buffer.from(result.value.data, "base64");
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const fontsReady = document.fonts?.ready ?? Promise.resolve();
        fontsReady.then(() => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
      }),
  );
  let previous;
  for (let index = 0; index < 5; index += 1) {
    const sample = await page.evaluate(() => {
      const root = document.querySelector("#root") ?? document.body;
      const rect = root.getBoundingClientRect();
      return [
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.width),
        Math.round(rect.height),
        document.body.scrollWidth,
        document.body.scrollHeight,
      ].join(":");
    });
    if (sample === previous) return;
    previous = sample;
    await delay(100);
  }
  throw new Error("Page layout did not stabilize.");
}

async function waitForNoNotifiers(page, timeoutMs = 8_000) {
  await waitForPredicate(
    page,
    () => document.querySelectorAll(".tm-notifier__item").length === 0,
    undefined,
    timeoutMs,
  );
}

async function waitForText(page, text, timeoutMs = 15_000) {
  await waitForPredicate(
    page,
    (expected) => document.body.textContent?.includes(expected) ?? false,
    text,
    timeoutMs,
  );
}

async function waitForTextAbsent(page, text, timeoutMs = 15_000) {
  await waitForPredicate(
    page,
    (expected) => !document.body.textContent?.includes(expected),
    text,
    timeoutMs,
  );
}

async function waitForPredicate(page, predicate, arg, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await page.evaluate(predicate, arg)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for browser predicate.");
}

async function setInputValue(page, selector, value) {
  const updated = await page.evaluate(
    ({ selectorText, nextValue }) => {
      const input = document.querySelector(selectorText);
      if (
        !(
          input instanceof HTMLInputElement ||
          input instanceof HTMLTextAreaElement
        )
      ) {
        return false;
      }
      const prototype =
        input instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    { selectorText: selector, nextValue: value },
  );
  if (!updated) throw new Error(`Could not set value for "${selector}".`);
}

function validateSceneContract(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("Showcase scene contract is empty.");
  }
  const ids = new Set();
  const images = new Set();
  for (const scene of scenes) {
    if (!scene.id || !scene.image || !scene.duration || !scene.sourceKind) {
      throw new Error(`Invalid showcase scene: ${JSON.stringify(scene)}`);
    }
    if (ids.has(scene.id)) throw new Error(`Duplicate scene id ${scene.id}.`);
    if (images.has(scene.image)) {
      throw new Error(`Duplicate scene image ${scene.image}.`);
    }
    ids.add(scene.id);
    images.add(scene.image);
  }
}

async function clearCaptureFiles(outputDir) {
  await mkdir(outputDir, { recursive: true });
  const entries = await readdir(outputDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".png") ||
            entry.name === "capture-manifest.json"),
      )
      .map((entry) => rm(path.join(outputDir, entry.name))),
  );
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} ${args.join(" ")} exited with ${code}.`),
          ),
    );
  });
}

async function runCommandCapture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${command} ${args.join(" ")} exited with ${code}.\n${output}`,
            ),
          ),
    );
  });
}

async function waitForHttp(url, timeoutMs, onAttempt) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    onAttempt?.();
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

function pngDimensions(buffer) {
  if (buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Capture is not a PNG.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
