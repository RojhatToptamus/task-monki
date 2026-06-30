import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "@remotion/renderer";
import {
  DEFAULT_DEMO_API_PORT,
  startDemoApiServer,
} from "./serve-remotion-demo-api.mjs";
import {
  DEMO_REPOSITORY_PATH,
  FOCAL_TASK_TITLE,
  REFINED_PROMPT,
  ROUGH_PROMPT,
} from "./remotion-demo-data.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const captureDir = path.join(rootDir, "public", "remotion-captures");
const viteBin = path.join(rootDir, "node_modules", ".bin", "vite");
const rendererPort = Number(process.env.TASK_MONKI_DEMO_RENDERER_PORT ?? 43110);
const apiPort = Number(
  process.env.TASK_MONKI_DEMO_API_PORT ?? DEFAULT_DEMO_API_PORT,
);
const appUrl = `http://127.0.0.1:${rendererPort}`;
const titleDrafts = [
  "Protect delivery actions",
  "Protect delivery actions during review follow-up",
];

async function main() {
  await rm(captureDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });

  const apiServer = await startDemoApiServer({ port: apiPort });
  const vite = spawn(
    viteBin,
    ["--host", "127.0.0.1", "--port", String(rendererPort), "--strictPort"],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        VITE_TASK_MANAGER_API_URL: apiServer.url,
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
      chromiumOptions: {
        darkMode: true,
        headless: true,
      },
      forceDeviceScaleFactor: 1,
      logLevel: "error",
    });

    const page = await browser.newPage({
      context: () => null,
      logLevel: "error",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => {},
    });

    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument((repositoryPath) => {
      window.localStorage.setItem("task-monki-theme", "dark");
      window.localStorage.setItem("task-monki-sidebar-collapsed", "0");
      window.localStorage.setItem(
        "task-monki-selected-repository",
        repositoryPath,
      );
      window.localStorage.setItem(
        "task-monki-repositories",
        JSON.stringify([repositoryPath]),
      );
      window.localStorage.setItem(
        "task-monki-app-settings",
        JSON.stringify({
          defaultModel: "gpt-5-codex",
          defaultReasoningEffort: "medium",
          promptRefinementModel: "gpt-5-codex-fast",
          reviewModel: "gpt-5-codex-review",
          reviewReasoningEffort: "low",
        }),
      );
    }, DEMO_REPOSITORY_PATH);

    await page.goto({ url: appUrl, timeout: 60_000 });
    await waitForText(page, "Board");
    await waitForText(page, FOCAL_TASK_TITLE);
    await settle(page);
    await capture(page, "01-board");

    await clickByText(page, "+ New task");
    await waitForText(page, "New task");
    await waitForText(page, "Title");
    await settle(page);
    await capture(page, "02-new-task-empty");

    await focusSelector(
      page,
      '.slideover input[placeholder="Add settings validation"]',
    );
    await setTaskTitle(page, titleDrafts[0]);
    await settle(page);
    await capture(page, "03-new-task-title-start");

    await setTaskTitle(page, titleDrafts[1]);
    await settle(page);
    await capture(page, "04-new-task-title-full");

    await focusSelector(page, "#task-description");
    await setTaskDescription(page, ROUGH_PROMPT);
    await settle(page);
    await capture(page, "05-new-task-description-full");

    await clickByText(page, "Refine");
    await waitForText(page, "Refining...");
    await settle(page);
    await capture(page, "06-new-task-refining");
    await waitForText(page, "Implement review follow-up delivery guards");
    await waitForText(page, "Run configuration");
    await waitForPredicate(
      page,
      () => document.body.textContent?.includes("Task Monki") ?? false,
    );
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await settle(page);
    await capture(page, "07-new-task-refined");

    await clickByText(page, "Create task");
    await waitForPredicate(page, () => !document.querySelector(".slideover"));
    await waitForText(page, FOCAL_TASK_TITLE);
    await waitForText(page, "Task created.");
    await settle(page);
    await capture(page, "08-created-task-notifier");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await settle(page);
    await capture(page, "09-created-task-board");

    await clickFirstTaskCard(page, FOCAL_TASK_TITLE);
    await waitForText(page, "Prepare worktree");
    await settle(page);
    await capture(page, "10-created-task-open");

    await clickByText(page, "Prepare worktree");
    await waitForText(page, "Worktree prepared.");
    await waitForText(page, "Start implementation");
    await settle(page);
    await capture(page, "11-prepare-worktree-notifier");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await settle(page);
    await capture(page, "12-worktree-ready");

    await clickByText(page, "Start implementation");
    await waitForText(page, "Agent run started.");
    await waitForText(page, "Running");
    await settle(page);
    await capture(page, "13-start-task-notifier");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await waitForText(page, "Running");
    await settle(page);
    await capture(page, "14-created-task-running");

    await postDemo(apiServer.url, "/api/demo/created-task-state", {
      state: "completed",
    });
    await waitForText(page, "Run Codex review");
    await settle(page);
    await capture(page, "15-created-task-finished");

    await clickByText(page, "Run Codex review");
    await waitForText(page, "Reviewing the current diff");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await settle(page);
    await capture(page, "16-review-running-a");
    await delay(520);
    await capture(page, "17-review-running-b");
    await delay(520);
    await capture(page, "18-review-running-c");

    await postDemo(apiServer.url, "/api/demo/review-state", {
      state: "complete",
    });
    await waitForText(page, "Codex review");
    await waitForText(page, "Delivery actions stay enabled");
    await settle(page);
    await capture(page, "19-review-complete");

    await clickByText(page, "Request changes");
    await waitForText(page, "Findings to attach");
    await waitForText(page, "Send to agent");
    await settle(page);
    await capture(page, "20-request-changes-open");

    await clickReviewFinding(page, "Paused actions need one consistent reason");
    await waitForText(page, "3 selected");
    await settle(page);
    await capture(page, "21-request-changes-checkboxes");
    await capture(page, "22-request-changes-submit");

    await clickByText(page, "Send to agent");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-reviewdrawer"),
    );
    await waitForText(page, "Follow-up run started.");
    await waitForText(page, "Review follow-up in progress");
    await settle(page);
    await capture(page, "23-followup-started-overview");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await settle(page);
    await capture(page, "24-followup-overview");

    await capture(page, "25-evidence-tab-click");
    await clickByText(page, "Evidence");
    await waitForText(page, "Changed files");
    await waitForText(page, "TaskDetail.tsx");
    await settle(page);
    await capture(page, "26-evidence-all");

    await clickByText(page, "Uncommitted");
    await waitForText(page, "UNCOMMITTED");
    await settle(page);
    await capture(page, "27-evidence-uncommitted");

    await clickByText(page, "Committed");
    await waitForText(page, "COMMITTED");
    await settle(page);
    await capture(page, "28-evidence-committed");

    await capture(page, "29-debug-tab-click");
    await clickByText(page, "Debug");
    await waitForText(page, "Provider activity");
    await waitForText(page, "Reported by Codex");
    await settle(page);
    await capture(page, "30-debug");

    await capture(page, "31-settings-click");
    await clickByText(page, "Settings");
    await waitForText(page, "Workspace defaults");
    await waitForText(page, "Codex review model");
    await settle(page);
    await capture(page, "32-settings");

    await capture(page, "33-board-click");
    await clickByText(page, "Board");
    await waitForText(page, "Accept repository switcher polish");
    await settle(page);
    await capture(page, "34-closing-board");

    console.log(
      `Captured real app frames in ${path.relative(rootDir, captureDir)}`,
    );
  } finally {
    if (browser) {
      await browser.close({ silent: true });
    }
    await stopProcess(vite);
    await apiServer.close();
  }
}

async function waitForHttp(url, timeoutMs, onAttempt) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    onAttempt?.();
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

async function waitForText(page, text, timeoutMs = 15_000) {
  await waitForPredicate(
    page,
    (expected) => document.body.textContent?.includes(expected) ?? false,
    text,
    timeoutMs,
  );
}

async function waitForPredicate(page, predicate, arg, timeoutMs = 15_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await page.evaluate(predicate, arg)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for browser predicate.");
}

async function clickByText(page, text, selector = "button") {
  const clicked = await page.evaluate(
    ({ expectedText, selectorText }) => {
      const normalize = (value) => value.replace(/\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll(selectorText));
      const target = candidates.find((candidate) => {
        const aria = candidate.getAttribute("aria-label") ?? "";
        return (
          normalize(candidate.textContent ?? "").includes(expectedText) ||
          normalize(aria).includes(expectedText)
        );
      });
      if (!target) {
        return false;
      }
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return true;
    },
    { expectedText: text, selectorText: selector },
  );
  if (!clicked) {
    throw new Error(`Could not click ${selector} containing "${text}".`);
  }
  await settle(page);
}

async function clickSelector(page, selector) {
  const clicked = await page.evaluate((selectorText) => {
    const target = document.querySelector(selectorText);
    if (!target) {
      return false;
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, selector);
  if (!clicked) {
    throw new Error(`Could not click selector "${selector}".`);
  }
  await settle(page);
}

async function clickFirstTaskCard(page, title) {
  const clicked = await page.evaluate((expectedTitle) => {
    const buttons = Array.from(document.querySelectorAll("button[aria-label]"));
    const target = buttons.find((button) => {
      const label = button.getAttribute("aria-label") ?? "";
      return label.includes(`Open ${expectedTitle}`);
    });
    if (!target) {
      return false;
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, title);
  if (!clicked) {
    throw new Error(`Could not click task card for "${title}".`);
  }
  await settle(page);
}

async function clickReviewFinding(page, title) {
  const clicked = await page.evaluate((expectedTitle) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const findings = Array.from(
      document.querySelectorAll(".tm-reviewdrawer__finding"),
    );
    const target = findings.find((finding) =>
      normalize(finding.textContent ?? "").includes(expectedTitle),
    );
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, title);
  if (!clicked) {
    throw new Error(`Could not click review finding "${title}".`);
  }
  await settle(page);
}

async function focusSelector(page, selector) {
  const focused = await page.evaluate((selectorText) => {
    const target = document.querySelector(selectorText);
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus();
    return true;
  }, selector);
  if (!focused) {
    throw new Error(`Could not focus selector "${selector}".`);
  }
  await settle(page);
}

async function captureReviewInstruction(page, fraction, name) {
  const updated = await page.evaluate((valueFraction) => {
    const textarea = document.querySelector(".tm-reviewdrawer textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }
    const fullValue = textarea.dataset.demoFullValue || textarea.value;
    textarea.dataset.demoFullValue = fullValue;
    const length = Math.max(1, Math.round(fullValue.length * valueFraction));
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, fullValue.slice(0, length));
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, fraction);
  if (!updated) {
    throw new Error("Could not update request changes instruction.");
  }
  await settle(page);
  await capture(page, name);
}

async function setTaskTitle(page, value) {
  const updated = await page.evaluate((nextValue) => {
    const input = document.querySelector(
      '.slideover input[placeholder="Add settings validation"]',
    );
    if (!(input instanceof HTMLInputElement)) {
      return false;
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, value);
  if (!updated) {
    throw new Error("Could not set task title.");
  }
  await settle(page);
}

async function setTaskDescription(page, value) {
  const updated = await page.evaluate((nextValue) => {
    const textarea = document.querySelector("#task-description");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, nextValue);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, value);
  if (!updated) {
    throw new Error("Could not set task description.");
  }
  await settle(page);
}

async function postDemo(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Demo API ${route} failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function capture(page, name) {
  await settle(page);
  const result = await page._client().send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(
    path.join(captureDir, `${name}.png`),
    Buffer.from(result.value.data, "base64"),
  );
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const fontsReady = document.fonts?.ready ?? Promise.resolve();
        fontsReady.then(() => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
      }),
  );
  await delay(180);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
