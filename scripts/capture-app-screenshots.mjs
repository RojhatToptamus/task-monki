import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "@remotion/renderer";
import { startDemoApiServer } from "./serve-remotion-demo-api.mjs";
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
const screenshotDir = path.join(rootDir, "screenshots");
const viteBin = path.join(rootDir, "node_modules", ".bin", "vite");
const rendererPort = Number(
  process.env.TASK_MONKI_SCREENSHOT_RENDERER_PORT ?? 43120,
);
const apiPort = Number(process.env.TASK_MONKI_SCREENSHOT_API_PORT ?? 43119);
const appUrl = `http://127.0.0.1:${rendererPort}`;
const title = "Protect delivery actions during review follow-up";

async function main() {
  await mkdir(screenshotDir, { recursive: true });

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

    await capture(page, "01-board-dark");
    await clickByText(page, "Inbox");
    await waitForText(page, "Decisions and runs waiting on you");
    await capture(page, "02-inbox-decisions");

    await clickByText(page, "Active runs");
    await waitForText(page, "tasks currently in flight");
    await capture(page, "03-active-runs");

    await clickByText(page, "Review queue");
    await waitForText(page, "tasks ready to verify and ship");
    await capture(page, "04-review-queue");

    await clickByText(page, "Done & Archive");
    await waitForText(page, "completed tasks");
    await capture(page, "05-done-and-archive");

    await clickByText(page, "Settings");
    await waitForText(page, "Workspace defaults and provider configuration");
    await waitForText(page, "Web search");
    await capture(page, "06-settings-dark");

    await clickByText(page, "Light");
    await settle(page);
    await capture(page, "07-settings-light-theme");
    await clickByText(page, "Dark");
    await settle(page);
    await setSelect(page, "Web search", "live");
    await setSelect(page, "MCP servers", "all");
    await setSelect(page, "Apps", "enabled");
    await settle(page);
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await capture(page, "08-settings-tools-enabled");

    await clickSelector(page, 'button[aria-label="Repository menu"]');
    await waitForText(page, "Add repository");
    await capture(page, "09-repository-menu");
    await page.goto({ url: appUrl, timeout: 60_000 });
    await waitForText(page, "Board");
    await waitForText(page, FOCAL_TASK_TITLE);
    await settle(page);

    await clickSelector(page, 'button[aria-label="Collapse sidebar"]');
    await settle(page);
    await capture(page, "10-sidebar-collapsed");
    await clickSelector(page, 'button[aria-label="Expand sidebar"]');
    await settle(page);

    await clickByText(page, "Board");
    await clickTaskOptions(
      page,
      "Confirm worktree cleanup before deleting a task",
    );
    await waitForText(page, "Delete...");
    await capture(page, "11-task-actions-menu");
    await clickByText(page, "Delete...");
    await waitForText(page, "Will be deleted");
    await capture(page, "12-delete-task-modal");
    await clickByText(page, "Cancel");
    await waitForPredicate(page, () => !document.querySelector(".tm-modal"));

    await clickByText(page, "+ New task");
    await waitForText(page, "New task");
    await capture(page, "13-new-task-empty");
    await setTaskTitle(page, title);
    await setTaskDescription(page, ROUGH_PROMPT);
    await capture(page, "14-new-task-filled");
    await clickByText(page, "Refine");
    await waitForText(page, "Refining...");
    await capture(page, "15-new-task-refining");
    await waitForText(page, "Implement review follow-up delivery guards");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await capture(page, "16-new-task-refined");

    await clickByText(page, "Create task");
    await waitForPredicate(page, () => !document.querySelector(".slideover"));
    await waitForText(page, "Task created.");
    await waitForText(page, FOCAL_TASK_TITLE);
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await clickFirstTaskCard(page, FOCAL_TASK_TITLE);
    await waitForText(page, "Prepare worktree");
    await capture(page, "17-task-ready-overview");

    await clickByText(page, "Prepare worktree");
    await waitForText(page, "Worktree prepared.");
    await waitForText(page, "Start implementation");
    await capture(page, "18-worktree-ready-overview");

    await clickByText(page, "Start implementation");
    await waitForText(page, "Agent run started.");
    await waitForText(page, "Running");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await capture(page, "19-implementation-running-overview");

    await postDemo(apiServer.url, "/api/demo/created-task-state", {
      state: "completed",
    });
    await reloadTaskDetail(page, FOCAL_TASK_TITLE);
    await waitForText(page, "Run Codex review");
    await capture(page, "20-review-ready-overview");

    await clickByText(page, "Run Codex review");
    await waitForText(page, "Reviewing the current diff");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );
    await capture(page, "21-review-running-overview");

    await postDemo(apiServer.url, "/api/demo/review-state", {
      state: "complete",
    });
    await reloadTaskDetail(page, FOCAL_TASK_TITLE);
    await waitForText(page, "Delivery actions stay enabled");
    await capture(page, "22-review-needs-changes-overview");

    await clickByText(page, "Request changes");
    await waitForText(page, "Findings to attach");
    await capture(page, "23-request-changes-modal");
    await clickReviewFinding(page, "Paused actions need one consistent reason");
    await waitForText(page, "3 selected");
    await capture(page, "24-request-changes-all-selected");

    await clickByText(page, "Send to agent");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-reviewdrawer"),
    );
    await waitForText(page, "Follow-up run started.");
    await waitForText(page, "Review follow-up in progress");
    await capture(page, "25-followup-running-overview");
    await waitForPredicate(
      page,
      () => !document.querySelector(".tm-notifier__item"),
      undefined,
      7_000,
    );

    await clickByText(page, "Evidence");
    await waitForText(page, "Changed files");
    await capture(page, "26-evidence-all");
    await clickByText(page, "Committed");
    await waitForText(page, "COMMITTED");
    await capture(page, "27-evidence-committed");
    await clickByText(page, "Uncommitted");
    await waitForText(page, "UNCOMMITTED");
    await capture(page, "28-evidence-uncommitted");

    await clickByText(page, "Debug");
    await waitForText(page, "Provider activity");
    await capture(page, "29-debug-provider-activity");

    await clickByText(page, "Board");
    await waitForText(page, "Protect delivery actions during review follow-up");
    await capture(page, "30-board-after-followup");

    console.log(
      `Captured design screenshots in ${path.relative(rootDir, screenshotDir)}`,
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

async function clickFirstTaskCard(page, taskTitle) {
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
  }, taskTitle);
  if (!clicked) {
    throw new Error(`Could not click task card for "${taskTitle}".`);
  }
  await settle(page);
}

async function clickTaskOptions(page, taskTitle) {
  const clicked = await page.evaluate((expectedTitle) => {
    const target = document.querySelector(
      `button[aria-label="Task options for ${CSS.escape(expectedTitle)}"]`,
    );
    if (!target) {
      return false;
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, taskTitle);
  if (!clicked) {
    throw new Error(`Could not open task options for "${taskTitle}".`);
  }
  await settle(page);
}

async function clickReviewFinding(page, findingTitle) {
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
  }, findingTitle);
  if (!clicked) {
    throw new Error(`Could not click review finding "${findingTitle}".`);
  }
  await settle(page);
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

async function setSelect(page, label, value) {
  const updated = await page.evaluate(
    ({ expectedLabel, nextValue }) => {
      const target = Array.from(document.querySelectorAll("select")).find(
        (select) => select.getAttribute("aria-label") === expectedLabel,
      );
      if (!(target instanceof HTMLSelectElement)) {
        return false;
      }
      target.value = nextValue;
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { expectedLabel: label, nextValue: value },
  );
  if (!updated) {
    throw new Error(`Could not set select "${label}" to "${value}".`);
  }
  await settle(page);
}

async function reloadTaskDetail(page, taskTitle) {
  await page.goto({ url: appUrl, timeout: 60_000 });
  await waitForText(page, "Board");
  await waitForText(page, taskTitle);
  await settle(page);
  await clickFirstTaskCard(page, taskTitle);
  await waitForText(page, taskTitle);
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
    path.join(screenshotDir, `${name}.png`),
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
