import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { parse } from "yaml";

const fixtureRoot = "/private/tmp/task-monki-showcase-preview-repo";
const markerPath = path.join(fixtureRoot, ".task-monki-showcase-fixture");

export async function startShowcasePreviewApp({ port = 43130 } = {}) {
  const evidence = await createFixtureRepository();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: fixtureRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHttp(`${url}/ready`, child, () => output);
  return {
    url,
    pid: child.pid,
    repositoryPath: fixtureRoot,
    branch: "task-monki/launch-dashboard-preview",
    evidence,
    close: () => stopProcess(child),
  };
}

async function createFixtureRepository() {
  if (await exists(fixtureRoot)) {
    if (!(await exists(markerPath))) {
      throw new Error(
        `Refusing to replace unowned preview fixture at ${fixtureRoot}`,
      );
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  await mkdir(path.join(fixtureRoot, ".taskmonki"), { recursive: true });
  await writeFile(markerPath, "owned by Task Monki showcase capture\n");
  await writeFile(
    path.join(fixtureRoot, "server.mjs"),
    `import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 43130);
const launchStatus = { checkedAt: new Date(Date.now() - 14_000).toISOString() };
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
const server = http.createServer(async (request, response) => {
  if (request.url === "/ready") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ready");
    return;
  }
  if (request.url === "/identity") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ app: "atlas-preview", branch: "task-monki/launch-dashboard-preview" }));
    return;
  }
  if (request.url === "/api/launch-status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(launchStatus));
    return;
  }
  const pathname = request.url === "/" ? "/index.html" : new URL(request.url, "http://127.0.0.1").pathname;
  try {
    const filePath = path.join(root, pathname);
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": types[path.extname(filePath)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  }
});
server.listen(port, "127.0.0.1", () => console.log("Atlas preview ready on " + port));
`,
  );
  await writeFile(
    path.join(fixtureRoot, "index.html"),
    `<!doctype html>
<html lang="en" data-app="atlas-preview">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Atlas Launch Operations</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <aside class="sidebar">
      <div class="brand"><span>A</span><strong>Atlas</strong></div>
      <nav>
        <a class="active" href="#">Launch operations</a>
        <a href="#">Campaigns</a>
        <a href="#">Environments</a>
        <a href="#">Incidents</a>
        <a href="#">Reports</a>
      </nav>
      <div class="workspace"><span>AW</span><div><strong>Atlas Web</strong><small>Production workspace</small></div></div>
    </aside>
    <main>
      <header>
        <div><p class="eyebrow">Atlas Web / Release 28</p><h1>Launch operations</h1></div>
        <div class="header-actions"><button class="icon" aria-label="Search">/</button><button class="secondary">Share</button><button class="primary">Create update</button></div>
      </header>
      <section class="status-line"><span class="pulse"></span><strong>All systems operational</strong><span data-status-age>Loading latest status...</span><span class="branch">task-monki/launch-dashboard-preview</span></section>
      <section class="metrics">
        <article><span>Launch readiness</span><strong>92%</strong><small class="up">+8% this week</small></article>
        <article><span>Active workstreams</span><strong>12</strong><small>4 teams contributing</small></article>
        <article><span>Open blockers</span><strong>2</strong><small class="warn">Both have owners</small></article>
        <article><span>Deployment window</span><strong>18h</strong><small>Tuesday, 09:00 UTC</small></article>
      </section>
      <section class="workspace-grid">
        <article class="panel progress-panel">
          <div class="panel-head"><div><span>Launch readiness</span><h2>Release 28 progress</h2></div><button class="secondary">View plan</button></div>
          <div class="progress-hero"><div class="ring"><strong>92</strong><span>%</span></div><div class="milestones">
            <div><span>Product and design</span><strong>18 / 18</strong><i style="--value:100%"></i></div>
            <div><span>Engineering</span><strong>31 / 34</strong><i style="--value:91%"></i></div>
            <div><span>Go-to-market</span><strong>14 / 16</strong><i style="--value:87%"></i></div>
            <div><span>Operations</span><strong>9 / 10</strong><i style="--value:90%"></i></div>
          </div></div>
        </article>
        <article class="panel health-panel">
          <div class="panel-head"><div><span>Environment health</span><h2>Services</h2></div><span class="live">Live</span></div>
          <div class="service"><span class="ok"></span><div><strong>Web application</strong><small>p95 184ms</small></div><em>Healthy</em></div>
          <div class="service"><span class="ok"></span><div><strong>API gateway</strong><small>p95 96ms</small></div><em>Healthy</em></div>
          <div class="service"><span class="ok"></span><div><strong>Event pipeline</strong><small>0.03% error rate</small></div><em>Healthy</em></div>
          <div class="service"><span class="watch"></span><div><strong>Analytics export</strong><small>Queue depth 128</small></div><em>Watching</em></div>
        </article>
        <article class="panel activity-panel">
          <div class="panel-head"><div><span>Recent activity</span><h2>Launch timeline</h2></div><button class="icon" aria-label="More">...</button></div>
          <ol>
            <li><span class="avatar blue">RK</span><div><strong>Rina moved checkout validation to complete</strong><small>2 minutes ago / Engineering</small></div></li>
            <li><span class="avatar green">TM</span><div><strong>Required checks passed on release/28</strong><small>9 minutes ago / Automation</small></div></li>
            <li><span class="avatar amber">JL</span><div><strong>Jon assigned the final export blocker</strong><small>24 minutes ago / Operations</small></div></li>
            <li><span class="avatar violet">AN</span><div><strong>Ana approved the launch messaging</strong><small>41 minutes ago / Go-to-market</small></div></li>
          </ol>
        </article>
        <article class="panel focus-panel">
          <div class="panel-head"><div><span>Today</span><h2>Critical path</h2></div><strong class="count">4 items</strong></div>
          <label><input type="checkbox" checked disabled /><span><strong>Finalize regional rollout plan</strong><small>Completed by Maya Chen</small></span></label>
          <label><input type="checkbox" checked disabled /><span><strong>Verify payment event replay</strong><small>Completed by Tom Reyes</small></span></label>
          <label><input type="checkbox" disabled /><span><strong>Resolve analytics export warning</strong><small>Owner: Jon Lee / Due in 3h</small></span></label>
          <label><input type="checkbox" disabled /><span><strong>Publish customer status update</strong><small>Owner: Ana Novak / Due in 5h</small></span></label>
        </article>
      </section>
    </main>
    <script type="module" src="/dashboard.mjs"></script>
  </body>
</html>
`,
  );
  await writeFile(path.join(fixtureRoot, "styles.css"), dashboardCss);
  await writeFile(
    path.join(fixtureRoot, "dashboard.mjs"),
    `export function formatStatusAge() {
  return "14 seconds ago";
}

const statusAge = typeof document === "undefined" ? null : document.querySelector("[data-status-age]");
if (statusAge) statusAge.textContent = "Last checked " + formatStatusAge();
`,
  );
  await writeFile(
    path.join(fixtureRoot, "dashboard.test.mjs"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { formatStatusAge } from "./dashboard.mjs";

test("formats seconds", () => {
  assert.equal(formatStatusAge(14_000, 28_000), "14 seconds ago");
});

test("formats elapsed minutes", () => {
  assert.equal(formatStatusAge(14_000, 89_000), "1 minute ago");
});
`,
  );
  await writeFile(
    path.join(fixtureRoot, ".taskmonki", "preview.yaml"),
    `version: 1
services:
  web:
    command: [node, server.mjs]
    env:
      NODE_ENV: development
    ports:
      http:
        env: PORT
    ready:
      type: http
      port: http
      path: /ready
      timeoutSeconds: 30
routes:
  app:
    service: web
    port: http
    primary: true
`,
  );

  const recipe = parse(
    await readFile(
      path.join(fixtureRoot, ".taskmonki", "preview.yaml"),
      "utf8",
    ),
  );
  if (
    recipe?.version !== 1 ||
    recipe?.routes?.app?.primary !== true ||
    recipe?.services?.web?.ready?.path !== "/ready"
  ) {
    throw new Error("Showcase preview recipe did not validate.");
  }

  await runGit(["init", "-b", "main"]);
  await runGit(["config", "user.name", "Task Monki Demo"]);
  await runGit(["config", "user.email", "demo@taskmonki.local"]);
  await runGit(["add", "server.mjs", ".task-monki-showcase-fixture"]);
  await runGit(["commit", "-m", "Initialize Atlas preview service"]);
  await runGit(["switch", "-c", "task-monki/launch-dashboard-preview"]);
  await runGit([
    "add",
    "index.html",
    "styles.css",
    "dashboard.mjs",
    "dashboard.test.mjs",
    ".taskmonki/preview.yaml",
  ]);
  await runGit(["commit", "-m", "Implement launch operations dashboard"]);
  const implementationSha = await runGit(["rev-parse", "HEAD"]);
  const implementationDiff = await runGit([
    "diff",
    "--no-ext-diff",
    "main...HEAD",
  ]);

  await writeFile(
    path.join(fixtureRoot, "dashboard.mjs"),
    `export function formatStatusAge(checkedAt, now = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  if (elapsedSeconds < 60) return elapsedSeconds + " seconds ago";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  return elapsedMinutes + (elapsedMinutes === 1 ? " minute ago" : " minutes ago");
}

async function renderStatusAge() {
  const response = await fetch("/api/launch-status");
  const status = await response.json();
  const statusAge = document.querySelector("[data-status-age]");
  if (statusAge) statusAge.textContent = "Last checked " + formatStatusAge(Date.parse(status.checkedAt));
}

if (typeof document !== "undefined") renderStatusAge().then(() => {
  document.documentElement.dataset.dashboardReady = "true";
});
`,
  );
  await runGit(["add", "dashboard.mjs"]);
  await runGit(["commit", "-m", "Derive launch status freshness"]);

  const baseSha = await runGit(["rev-parse", "main"]);
  const finalSha = await runGit(["rev-parse", "HEAD"]);
  const finalDiff = await runGit(["diff", "--no-ext-diff", "main...HEAD"]);
  const diffStat = await runGit(["diff", "--stat", "main...HEAD"]);
  const testOutput = await runCommand(process.execPath, [
    "--test",
    "dashboard.test.mjs",
  ]);
  const testSummary = parseNodeTestSummary(testOutput);
  if (testSummary.tests !== 2 || testSummary.pass !== 2 || testSummary.fail !== 0) {
    throw new Error(`Unexpected showcase test result: ${JSON.stringify(testSummary)}`);
  }
  return {
    repositoryPath: fixtureRoot,
    baseSha,
    implementationSha,
    finalSha,
    implementationDiff,
    finalDiff,
    diffStat,
    testOutput,
    testSummary,
  };
}

function parseNodeTestSummary(output) {
  const value = (label) => {
    const match = output.match(new RegExp(`# ${label} (\\d+)`));
    return match ? Number(match[1]) : -1;
  };
  return { tests: value("tests"), pass: value("pass"), fail: value("fail") };
}

const dashboardCss = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf4;background:#0d1117;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-width:1100px;min-height:100vh;background:#0d1117;color:#e8edf4}.sidebar{position:fixed;inset:0 auto 0 0;width:252px;padding:28px 20px 24px;border-right:1px solid #252b35;background:#11161e;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:12px;padding:0 10px 28px;font-size:19px}.brand>span{display:grid;place-items:center;width:32px;height:32px;border-radius:7px;background:#3478f6;color:white;font-weight:800}.brand strong{font-size:19px}.sidebar nav{display:grid;gap:5px}.sidebar nav a{color:#8f9bad;text-decoration:none;padding:11px 13px;border-radius:6px;font-size:14px}.sidebar nav a.active{background:#1c2532;color:white;font-weight:650}.workspace{margin-top:auto;border-top:1px solid #252b35;padding:22px 8px 0;display:flex;gap:11px;align-items:center}.workspace>span{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#2d3746;color:#dce6f7;font-size:11px;font-weight:700}.workspace div{display:grid;gap:2px}.workspace strong{font-size:13px}.workspace small{font-size:11px;color:#7f8a9b}main{margin-left:252px;padding:32px 42px 44px;min-height:100vh}header{height:62px;display:flex;justify-content:space-between;align-items:flex-start}h1,h2,p{margin:0}h1{font-size:27px;line-height:1.1;letter-spacing:0}.eyebrow{color:#8792a3;font-size:12px;margin-bottom:7px}.header-actions{display:flex;gap:9px;align-items:center}button{font:inherit;border-radius:6px;height:36px;padding:0 14px;border:1px solid #303847;background:#171d26;color:#dce3ec;font-weight:620;font-size:13px}.icon{width:36px;padding:0}.primary{background:#3478f6;border-color:#3478f6;color:white}.secondary{background:#151b24}.status-line{height:46px;margin-top:18px;border:1px solid #27303b;background:#121821;border-radius:7px;display:flex;align-items:center;gap:10px;padding:0 14px;font-size:12px;color:#8995a6}.status-line strong{color:#dbe5ef}.status-line .branch{margin-left:auto;color:#aeb8c7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.pulse,.ok,.watch{width:8px;height:8px;border-radius:50%;background:#38c989;box-shadow:0 0 0 3px #173c30}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid #27303b;border-radius:7px;margin-top:18px;background:#11171f}.metrics article{padding:19px 21px;border-right:1px solid #27303b;display:grid;gap:8px}.metrics article:last-child{border-right:0}.metrics span,.panel-head span{font-size:12px;color:#8490a1}.metrics strong{font-size:25px}.metrics small{font-size:11px;color:#788496}.metrics .up{color:#45cd91}.metrics .warn{color:#e6b45c}.workspace-grid{display:grid;grid-template-columns:1.42fr 1fr;gap:18px;margin-top:18px}.panel{border:1px solid #27303b;background:#11171f;border-radius:7px;padding:21px}.panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.panel-head h2{font-size:16px;margin-top:5px}.progress-hero{display:grid;grid-template-columns:155px 1fr;gap:24px;align-items:center}.ring{width:132px;height:132px;margin:auto;border-radius:50%;display:grid;place-content:center;text-align:center;background:radial-gradient(circle at center,#11171f 61%,transparent 62%),conic-gradient(#3478f6 0 92%,#252d38 92% 100%)}.ring strong{font-size:31px}.ring span{color:#8490a1;font-size:13px}.milestones{display:grid;gap:14px}.milestones div{display:grid;grid-template-columns:1fr auto;gap:8px;font-size:12px}.milestones div span{color:#a8b2c0}.milestones div strong{font-size:11px}.milestones i{grid-column:1/-1;height:5px;background:#252d38;border-radius:3px;overflow:hidden}.milestones i:after{content:"";display:block;width:var(--value);height:100%;background:#3478f6;border-radius:3px}.live{color:#40c88b!important}.service{display:flex;align-items:center;gap:12px;padding:13px 0;border-top:1px solid #242c36}.service div{display:grid;gap:3px}.service strong{font-size:13px}.service small{font-size:11px;color:#778394}.service em{margin-left:auto;font-size:11px;font-style:normal;color:#42c88d}.service .watch{background:#e3ad51;box-shadow:0 0 0 3px #3d3020}.service .watch~div+em{color:#e3ad51}.activity-panel ol{list-style:none;padding:0;margin:0;display:grid}.activity-panel li{display:flex;gap:12px;padding:13px 0;border-top:1px solid #242c36}.activity-panel li div{display:grid;gap:4px}.activity-panel li strong{font-size:12px}.activity-panel li small{font-size:11px;color:#758193}.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:9px;font-weight:800;flex:none}.blue{background:#183c73;color:#8ebcff}.green{background:#173e30;color:#71d9aa}.amber{background:#49371d;color:#e9bf73}.violet{background:#382b58;color:#c4a7ff}.count{font-size:11px;color:#9eabbc}.focus-panel label{display:flex;gap:11px;align-items:flex-start;padding:13px 0;border-top:1px solid #242c36}.focus-panel input{margin:2px 0 0;accent-color:#3478f6}.focus-panel label span{display:grid;gap:4px}.focus-panel label strong{font-size:12px}.focus-panel label small{font-size:11px;color:#758193}@media(max-width:1250px){main{padding-left:28px;padding-right:28px}.metrics{grid-template-columns:repeat(2,1fr)}.metrics article:nth-child(2){border-right:0}.metrics article:nth-child(-n+2){border-bottom:1px solid #27303b}.workspace-grid{grid-template-columns:1fr}}
`;

async function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: fixtureRoot, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`git ${args.join(" ")} failed.\n${output}`)),
    );
  });
}

async function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: fixtureRoot, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${command} ${args.join(" ")} failed.\n${output}`)),
    );
  });
}

async function waitForHttp(url, child, getOutput) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) {
      throw new Error(
        `Preview app exited before becoming ready.\n${getOutput()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Continue until the bounded readiness deadline.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for showcase preview at ${url}.`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
