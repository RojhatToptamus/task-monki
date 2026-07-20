import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const videoPath = path.join(rootDir, "renders", "task-monki-showcase.mp4");
const manifest = JSON.parse(
  await readFile(
    path.join(rootDir, "public", "remotion-captures", "capture-manifest.json"),
    "utf8",
  ),
);
const scenes = JSON.parse(
  await readFile(path.join(rootDir, "scripts", "showcase-scenes.json"), "utf8"),
);
const artifactDir = path.join(
  rootDir,
  "renders",
  "video-checks",
  manifest.runId,
);
await mkdir(artifactDir, { recursive: true });

const probe = JSON.parse(
  await run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    videoPath,
  ]),
);
const videoStream = probe.streams.find(
  (stream) => stream.codec_type === "video",
);
const audioStreams = probe.streams.filter(
  (stream) => stream.codec_type === "audio",
);
const expectedDuration = scenes.reduce(
  (total, scene) => total + scene.duration,
  0,
);
const actualDuration = Number(probe.format.duration);
const errors = [];

check(Boolean(videoStream), "No video stream found.");
check(videoStream?.codec_name === "h264", "Video codec is not H.264.");
check(videoStream?.width === 1920, "Video width is not 1920.");
check(videoStream?.height === 1080, "Video height is not 1080.");
check(
  videoStream?.avg_frame_rate === "30/1",
  "Video frame rate is not 30 fps.",
);
check(
  audioStreams.length === 0,
  "Muted showcase must not contain an audio stream.",
);
check(
  Math.abs(actualDuration - expectedDuration) <= 0.12,
  `Duration ${actualDuration}s does not match expected ${expectedDuration}s.`,
);

await run("ffmpeg", ["-v", "error", "-i", videoPath, "-f", "null", "-"]);
const blackLog = await run("ffmpeg", [
  "-hide_banner",
  "-i",
  videoPath,
  "-vf",
  "blackdetect=d=0.5:pix_th=0.01:pic_th=0.98",
  "-an",
  "-f",
  "null",
  "-",
]);
const freezeLog = await run("ffmpeg", [
  "-hide_banner",
  "-i",
  videoPath,
  "-vf",
  "freezedetect=n=-60dB:d=4.2",
  "-an",
  "-f",
  "null",
  "-",
]);
check(
  !blackLog.includes("black_duration:"),
  "Detected a sustained black frame.",
);
check(
  !freezeLog.includes("freeze_duration:"),
  "Detected an unexpected freeze longer than 4.2s.",
);

const contactSheetPath = path.join(artifactDir, "video-contact-sheet.png");
await run("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-i",
  videoPath,
  "-vf",
  "fps=1/3,scale=480:-1,tile=5x5:padding=6:margin=6:color=0x0b0e12",
  "-frames:v",
  "1",
  contactSheetPath,
]);

if (errors.length > 0) {
  throw new Error(
    `Showcase video verification failed:\n- ${errors.join("\n- ")}`,
  );
}

const video = await readFile(videoPath);
const fileInfo = await stat(videoPath);
const report = {
  verifiedAt: new Date().toISOString(),
  runId: manifest.runId,
  video: {
    path: path.relative(rootDir, videoPath),
    sha256: createHash("sha256").update(video).digest("hex"),
    byteCount: fileInfo.size,
    codec: videoStream.codec_name,
    width: videoStream.width,
    height: videoStream.height,
    frameRate: videoStream.avg_frame_rate,
    durationSeconds: actualDuration,
    audioStreams: audioStreams.length,
  },
  expectedDurationSeconds: expectedDuration,
  checks: {
    fullDecode: "passed",
    sustainedBlackFrames: "passed",
    unexpectedFreezeOver4_2Seconds: "passed",
    contactSheet: path.relative(rootDir, contactSheetPath),
  },
};
await writeFile(
  path.join(artifactDir, "video-verification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `Verified ${actualDuration.toFixed(1)}s H.264 video (${(fileInfo.size / 1024 / 1024).toFixed(1)} MiB).`,
);
console.log(`Contact sheet: ${path.relative(rootDir, contactSheetPath)}`);

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} failed.\n${output}`));
    });
  });
}
