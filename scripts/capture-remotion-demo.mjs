import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShowcaseCapture } from "./showcase-capture-runner.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

runShowcaseCapture({
  rootDir,
  outputDir: path.join(rootDir, "public", "remotion-captures"),
  apiPort: Number(process.env.TASK_MONKI_DEMO_API_PORT ?? 43099),
  rendererPort: Number(process.env.TASK_MONKI_DEMO_RENDERER_PORT ?? 43110),
  previewPort: Number(process.env.TASK_MONKI_DEMO_PREVIEW_PORT ?? 43130),
})
  .then((result) => {
    console.log(
      `Captured ${result.captures} showcase frames in ${path.relative(rootDir, result.outputDir)}`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
