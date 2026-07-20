import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBrowser } from "@remotion/renderer";
import { verifyShowcaseCaptures } from "./verify-showcase-captures.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const captureDir = path.join(rootDir, "public", "remotion-captures");
const screenshotDir = path.join(rootDir, "screenshots");

await verifyShowcaseCaptures({ rootDir, captureDir, writeArtifacts: false });

const manifest = JSON.parse(
  await readFile(path.join(captureDir, "capture-manifest.json"), "utf8"),
);
await mkdir(screenshotDir, { recursive: true });
for (const entry of await readdir(screenshotDir, { withFileTypes: true })) {
  if (
    entry.isFile() &&
    (entry.name.endsWith(".png") || entry.name === "capture-manifest.json")
  ) {
    await rm(path.join(screenshotDir, entry.name));
  }
}

for (const scene of manifest.scenes) {
  await copyFile(
    path.join(captureDir, scene.image),
    path.join(screenshotDir, scene.image),
  );
}
await copyFile(
  path.join(captureDir, "capture-manifest.json"),
  path.join(screenshotDir, "capture-manifest.json"),
);

const printPath = path.join(screenshotDir, ".app-screenshots-print.html");
await writeFile(printPath, buildPrintHtml(manifest.scenes));
let browser;
try {
  browser = await openBrowser("chrome", {
    chromiumOptions: { darkMode: true, headless: true },
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
  await page.goto({ url: pathToFileURL(printPath).href, timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  const result = await page._client().send("Page.printToPDF", {
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
  });
  await writeFile(
    path.join(screenshotDir, "app-screenshots.pdf"),
    Buffer.from(result.value.data, "base64"),
  );
} finally {
  if (browser) await browser.close({ silent: true });
  await rm(printPath, { force: true });
}

console.log(
  `Exported ${manifest.scenes.length} canonical screenshots and app-screenshots.pdf`,
);

function buildPrintHtml(scenes) {
  const pages = scenes
    .map(
      (scene) =>
        `<section class="page"><img src="${escapeAttribute(scene.image)}" alt="${escapeAttribute(scene.id)}"></section>`,
    )
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@page { size: 16in 9in; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #0c0f13; }
.page { width: 16in; height: 9in; break-after: page; page-break-after: always; overflow: hidden; }
.page:last-child { break-after: auto; page-break-after: auto; }
img { display: block; width: 100%; height: 100%; object-fit: cover; }
</style></head><body>${pages}</body></html>`;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
