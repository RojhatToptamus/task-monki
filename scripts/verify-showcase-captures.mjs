import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBrowser } from "@remotion/renderer";

const defaultRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function verifyShowcaseCaptures({
  rootDir = defaultRootDir,
  captureDir = path.join(rootDir, "public", "remotion-captures"),
  writeArtifacts = true,
} = {}) {
  const [sceneSource, manifestSource] = await Promise.all([
    readFile(path.join(rootDir, "scripts", "showcase-scenes.json")),
    readFile(path.join(captureDir, "capture-manifest.json")),
  ]);
  const scenes = JSON.parse(sceneSource);
  const manifest = JSON.parse(manifestSource);
  const errors = [];

  check(manifest.schemaVersion === 1, "Manifest schemaVersion must be 1.");
  check(manifest.viewport?.width === 1920, "Manifest width must be 1920.");
  check(manifest.viewport?.height === 1080, "Manifest height must be 1080.");
  check(
    manifest.task?.id === "showcase-atlas-launch-dashboard",
    "Unexpected showcase task id.",
  );
  check(
    manifest.task?.title === "Build Atlas launch operations dashboard",
    "Unexpected showcase task title.",
  );
  check(manifest.task?.repository === "Atlas Web", "Unexpected repository.");
  check(
    manifest.task?.branch === "task-monki/launch-dashboard-preview",
    "Unexpected branch.",
  );
  check(
    manifest.provenance?.sceneSpecSha256 === sha256(sceneSource),
    "Scene specification changed after capture.",
  );
  check(
    manifest.provenance?.preview?.testCommand ===
      "node --test dashboard.test.mjs",
    "Unexpected focused verification command.",
  );
  check(
    manifest.provenance?.preview?.testSummary?.tests === 2 &&
      manifest.provenance?.preview?.testSummary?.pass === 2 &&
      manifest.provenance?.preview?.testSummary?.fail === 0,
    "Focused dashboard verification did not pass 2 tests.",
  );
  check(
    /^[a-f0-9]{64}$/.test(
      manifest.provenance?.preview?.testOutputSha256 ?? "",
    ),
    "Focused verification output hash is missing.",
  );
  check(
    manifest.scenes?.length === scenes.length,
    `Expected ${scenes.length} manifest scenes, found ${manifest.scenes?.length ?? 0}.`,
  );

  const manifestById = new Map(
    manifest.scenes.map((scene) => [scene.id, scene]),
  );
  const expectedImages = new Set(scenes.map((scene) => scene.image));
  const files = await readdir(captureDir);
  const pngFiles = files.filter((file) => file.endsWith(".png"));
  for (const file of pngFiles) {
    check(!file.startsWith("failure-"), `Failure artifact remains: ${file}.`);
    check(expectedImages.has(file), `Unexpected capture image: ${file}.`);
  }
  check(
    pngFiles.length === expectedImages.size,
    `Expected ${expectedImages.size} PNG files, found ${pngFiles.length}.`,
  );

  for (const scene of scenes) {
    const record = manifestById.get(scene.id);
    check(Boolean(record), `Missing manifest record for ${scene.id}.`);
    if (!record) continue;
    check(record.image === scene.image, `Image mismatch for ${scene.id}.`);
    check(
      record.sourceKind === scene.sourceKind,
      `Source kind mismatch for ${scene.id}.`,
    );
    const image = await readFile(path.join(captureDir, scene.image));
    const dimensions = pngDimensions(image);
    check(dimensions.width === 1920, `${scene.image} width is not 1920.`);
    check(dimensions.height === 1080, `${scene.image} height is not 1080.`);
    check(record.sha256 === sha256(image), `Hash mismatch for ${scene.image}.`);
    check(
      record.byteCount === image.length,
      `Byte count mismatch for ${scene.image}.`,
    );
    check(
      record.page?.overlays?.notifiers?.length === 0,
      `Notifier leaked into ${scene.id}.`,
    );

    if (scene.sourceKind === "task-monki") {
      check(
        record.page?.title === "Task Monki",
        `${scene.id} has a foreign title.`,
      );
      check(
        record.page?.hasTaskMonkiRoot === true,
        `${scene.id} lacks Task Monki root.`,
      );
      check(
        record.page?.appMarker === null,
        `${scene.id} has a foreign app marker.`,
      );
    } else if (scene.sourceKind === "preview-inset") {
      check(
        record.page?.title === "Atlas Launch Operations",
        `${scene.id} has an unexpected preview title.`,
      );
      check(
        record.page?.appMarker === "atlas-preview",
        `${scene.id} lacks Atlas provenance.`,
      );
      check(
        record.page?.previewReady === true,
        `${scene.id} preview script did not run.`,
      );
      check(
        Boolean(scene.backgroundImage),
        `${scene.id} must declare a Task Monki background.`,
      );
      check(
        scenes.some(
          (candidate) =>
            candidate.image === scene.backgroundImage &&
            candidate.sourceKind === "task-monki",
        ),
        `${scene.id} background is not a canonical Task Monki scene.`,
      );
    } else {
      check(false, `Unsupported source kind ${scene.sourceKind}.`);
    }

    const actionKind = scene.exitAction?.kind;
    const needsGeometry = actionKind === "click" || actionKind === "fill";
    check(
      Boolean(record.action) === needsGeometry,
      `${scene.id} action geometry presence is incorrect.`,
    );
    if (record.action) {
      const { point, rect } = record.action;
      check(
        record.action.kind === actionKind,
        `${scene.id} action kind mismatch.`,
      );
      check(
        record.action.label === scene.exitAction.label,
        `${scene.id} action label mismatch.`,
      );
      check(
        record.action.hitMatches === true,
        `${scene.id} target failed DOM hit testing.`,
      );
      check(
        rect.width > 0 && rect.height > 0,
        `${scene.id} has an empty action rect.`,
      );
      check(point.x >= rect.x, `${scene.id} point is left of target.`);
      check(
        point.x <= rect.x + rect.width,
        `${scene.id} point is right of target.`,
      );
      check(point.y >= rect.y, `${scene.id} point is above target.`);
      check(
        point.y <= rect.y + rect.height,
        `${scene.id} point is below target.`,
      );
      check(
        point.x >= 0 && point.x <= 1920,
        `${scene.id} point is outside viewport.`,
      );
      check(
        point.y >= 0 && point.y <= 1080,
        `${scene.id} point is outside viewport.`,
      );
    }
  }

  const previewScenes = manifest.scenes.filter(
    (scene) => scene.sourceKind === "preview-inset",
  );
  check(
    previewScenes.length === 1,
    "Expected exactly one contextual preview scene.",
  );
  const computedCaptureSet = sha256(
    Buffer.from(
      manifest.scenes
        .map((scene) => `${scene.image}:${scene.sha256}`)
        .join("\n"),
    ),
  );
  check(
    manifest.captureSetSha256 === computedCaptureSet,
    "Capture-set hash does not match scene hashes.",
  );

  if (errors.length > 0) {
    throw new Error(
      `Showcase capture verification failed:\n- ${errors.join("\n- ")}`,
    );
  }

  const report = {
    verifiedAt: new Date().toISOString(),
    runId: manifest.runId,
    captureSetSha256: manifest.captureSetSha256,
    sceneCount: scenes.length,
    actionCount: manifest.scenes.filter((scene) => scene.action).length,
    task: manifest.task,
    preview: manifest.provenance.preview,
    checks: {
      hashes: "passed",
      dimensions: "passed",
      actionGeometry: "passed",
      pageProvenance: "passed",
      notifierExclusion: "passed",
      taskIdentity: "passed",
    },
  };

  let artifactDir;
  if (writeArtifacts) {
    artifactDir = path.join(rootDir, "renders", "video-checks", manifest.runId);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "verification.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeReviewArtifacts({
      artifactDir,
      captureDir,
      scenes,
      manifestById,
      report,
    });
  }

  return { ...report, artifactDir };

  function check(condition, message) {
    if (!condition) errors.push(message);
  }
}

async function writeReviewArtifacts({
  artifactDir,
  captureDir,
  scenes,
  manifestById,
  report,
}) {
  const storyboardPath = path.join(artifactDir, "storyboard.html");
  const clickAtlasPath = path.join(artifactDir, "click-atlas.html");
  await Promise.all([
    writeFile(
      storyboardPath,
      buildReviewHtml({
        captureDir,
        scenes,
        manifestById,
        report,
        clicksOnly: false,
      }),
    ),
    writeFile(
      clickAtlasPath,
      buildReviewHtml({
        captureDir,
        scenes,
        manifestById,
        report,
        clicksOnly: true,
      }),
    ),
  ]);
  await renderReviewPages([
    [storyboardPath, path.join(artifactDir, "storyboard.png")],
    [clickAtlasPath, path.join(artifactDir, "click-atlas.png")],
  ]);
}

async function renderReviewPages(entries) {
  let browser;
  try {
    browser = await openBrowser("chrome", {
      chromiumOptions: { darkMode: true, headless: true },
      forceDeviceScaleFactor: 1,
      logLevel: "error",
    });
    let pageIndex = 0;
    for (const [htmlPath, outputPath] of entries) {
      const page = await browser.newPage({
        context: () => null,
        logLevel: "error",
        indent: false,
        pageIndex: pageIndex++,
        onBrowserLog: null,
        onLog: () => {},
      });
      await page.setViewport({
        width: 1800,
        height: 900,
        deviceScaleFactor: 1,
      });
      await page.goto({ url: pathToFileURL(htmlPath).href, timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page._client().send("Page.getLayoutMetrics");
      const size = metrics.value.contentSize;
      const result = await page._client().send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      });
      await writeFile(outputPath, Buffer.from(result.value.data, "base64"));
    }
  } finally {
    if (browser) await browser.close({ silent: true });
  }
}

function buildReviewHtml({
  captureDir,
  scenes,
  manifestById,
  report,
  clicksOnly,
}) {
  const selected = clicksOnly
    ? scenes.filter((scene) => manifestById.get(scene.id)?.action)
    : scenes;
  const cards = selected
    .map((scene, index) => {
      const record = manifestById.get(scene.id);
      const action = record.action;
      const rect = action
        ? `<span class="target" style="left:${(action.rect.x / 1920) * 100}%;top:${(action.rect.y / 1080) * 100}%;width:${(action.rect.width / 1920) * 100}%;height:${(action.rect.height / 1080) * 100}%"></span>`
        : "";
      const point = action
        ? `<span class="point" style="left:${(action.point.x / 1920) * 100}%;top:${(action.point.y / 1080) * 100}%"></span>`
        : "";
      return `<article>
<header><strong>${String(index + 1).padStart(2, "0")} · ${escapeHtml(scene.id)}</strong><span>${escapeHtml(scene.sourceKind)} · ${scene.duration}s</span></header>
<div class="frame"><img src="${pathToFileURL(path.join(captureDir, scene.image)).href}" alt="${escapeHtml(scene.id)}">${rect}${point}</div>
<footer><span>${escapeHtml(scene.image)}</span><strong>${escapeHtml(action?.label ?? "state")}</strong></footer>
</article>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${clicksOnly ? "Click atlas" : "Storyboard"}</title><style>
*{box-sizing:border-box}body{margin:0;padding:34px;background:#0b0e12;color:#eef2f7;font-family:Inter,ui-sans-serif,system-ui,sans-serif}h1{margin:0;font-size:28px;letter-spacing:0}p{margin:8px 0 28px;color:#9ca7b6;font-size:14px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}article{overflow:hidden;border:1px solid #2a313c;border-radius:7px;background:#12171e}header,footer{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 13px;font-size:12px}header span,footer span{color:#8490a0}footer strong{color:#d9e1eb}.frame{position:relative;aspect-ratio:16/9;background:#05070a}.frame img{display:block;width:100%;height:100%;object-fit:cover}.target{position:absolute;border:2px solid #ffcc66;background:rgba(255,204,102,.12);box-shadow:0 0 0 1px rgba(0,0,0,.55)}.point{position:absolute;width:13px;height:13px;border:3px solid #fff;border-radius:50%;background:#ff4d5e;transform:translate(-50%,-50%);box-shadow:0 0 0 2px #111,0 2px 8px #000}code{color:#9fc1ff}</style></head><body><h1>${clicksOnly ? "Measured click atlas" : "Canonical storyboard"}</h1><p><code>${escapeHtml(report.runId)}</code> · ${selected.length} scenes · <code>${escapeHtml(report.captureSetSha256.slice(0, 16))}</code></p><main class="grid">${cards}</main></body></html>`;
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Capture is not a PNG.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyShowcaseCaptures()
    .then((report) => {
      console.log(
        `Verified ${report.sceneCount} scenes and ${report.actionCount} measured actions.`,
      );
      console.log(
        `Review artifacts: ${path.relative(defaultRootDir, report.artifactDir)}`,
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
