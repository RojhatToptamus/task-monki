import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import captureManifestSource from "../../public/remotion-captures/capture-manifest.json";
import sceneSpecsSource from "../../scripts/showcase-scenes.json";

export const VIDEO_FPS = 30;

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Chapter = {
  eyebrow: string;
  title: string;
  align?: "left" | "right";
};
type SceneSpec = {
  id: string;
  image: string;
  backgroundImage?: string;
  duration: number;
  sourceKind: "task-monki" | "preview-inset";
  chapter?: Chapter;
};
type CaptureAction = {
  kind: "click" | "fill";
  label: string;
  point: Point;
  rect: Rect;
  hitMatches: boolean;
};
type CaptureRecord = {
  id: string;
  image: string;
  sourceKind: SceneSpec["sourceKind"];
  action?: CaptureAction;
};
type CaptureManifest = {
  captureSetSha256: string;
  task: {
    id: string;
    title: string;
    repository: string;
    branch: string;
  };
  scenes: CaptureRecord[];
};
type Shot = SceneSpec & {
  durationFrames: number;
  record: CaptureRecord;
  cursorFrom?: Point;
};

const seconds = (value: number) => Math.round(value * VIDEO_FPS);
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const sceneSpecs = sceneSpecsSource as SceneSpec[];
const captureManifest = captureManifestSource as CaptureManifest;
const captureById = new Map(
  captureManifest.scenes.map((scene) => [scene.id, scene]),
);

const shots = sceneSpecs.map<Shot>((scene, index) => {
  const record = captureById.get(scene.id);
  if (
    !record ||
    record.image !== scene.image ||
    record.sourceKind !== scene.sourceKind
  ) {
    throw new Error(`Capture manifest does not match scene ${scene.id}.`);
  }
  const priorAction = captureManifest.scenes
    .slice(0, index)
    .reverse()
    .find((candidate) => candidate.action)?.action;
  return {
    ...scene,
    durationFrames: seconds(scene.duration),
    record,
    cursorFrom: record.action
      ? (priorAction?.point ?? { x: 1740, y: 76 })
      : undefined,
  };
});

const sceneStarts = shots.reduce<number[]>((starts, shot, index) => {
  starts.push(
    index === 0 ? 0 : starts[index - 1] + shots[index - 1].durationFrames,
  );
  return starts;
}, []);

export const VIDEO_DURATION_FRAMES =
  sceneStarts.at(-1)! + shots.at(-1)!.durationFrames;

export function TaskMonkiShowcase() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill className="tmv-root">
      {shots.map((shot, index) => (
        <Scene
          key={shot.id}
          shot={shot}
          start={sceneStarts[index]}
          frame={frame}
        />
      ))}
    </AbsoluteFill>
  );
}

export function TaskMonkiPoster() {
  return (
    <AbsoluteFill className="tmv-root">
      <Img
        className="tmv-shot__image"
        src={staticFile("remotion-captures/34-completed-board.png")}
      />
      <div className="tmv-poster">
        <span>LOCAL AI WORKSPACE</span>
        <strong>Task Monki</strong>
        <p>One Atlas task, from rough request to accepted branch.</p>
      </div>
    </AbsoluteFill>
  );
}

function Scene({
  shot,
  start,
  frame,
}: {
  shot: Shot;
  start: number;
  frame: number;
}) {
  const localFrame = frame - start;
  if (localFrame < 0 || localFrame >= shot.durationFrames) return null;
  const action = shot.record.action;

  return (
    <AbsoluteFill>
      {shot.sourceKind === "preview-inset" ? (
        <PreviewInset shot={shot} />
      ) : (
        <Img
          className="tmv-shot__image"
          src={staticFile(`remotion-captures/${shot.image}`)}
        />
      )}
      {shot.chapter ? (
        <ChapterCard
          chapter={shot.chapter}
          action={action}
          frame={localFrame}
          duration={shot.durationFrames}
        />
      ) : null}
      {action && shot.cursorFrom ? (
        <>
          {action.kind === "fill" ? (
            <TypedFill
              action={action}
              frame={localFrame}
              duration={shot.durationFrames}
            />
          ) : null}
          <MeasuredCursor
            action={action}
            from={shot.cursorFrom}
            frame={localFrame}
            duration={shot.durationFrames}
          />
        </>
      ) : null}
    </AbsoluteFill>
  );
}

function PreviewInset({ shot }: { shot: Shot }) {
  if (!shot.backgroundImage) {
    throw new Error(
      `Preview scene ${shot.id} is missing its Task Monki background.`,
    );
  }
  return (
    <AbsoluteFill className="tmv-preview-context">
      <Img
        className="tmv-shot__image tmv-preview-context__background"
        src={staticFile(`remotion-captures/${shot.backgroundImage}`)}
      />
      <div className="tmv-preview-window">
        <div className="tmv-preview-window__bar">
          <strong>Task Monki Preview</strong>
          <span>{captureManifest.task.repository}</span>
          <code>{captureManifest.task.branch}</code>
        </div>
        <Img
          className="tmv-preview-window__image"
          src={staticFile(`remotion-captures/${shot.image}`)}
        />
      </div>
    </AbsoluteFill>
  );
}

function ChapterCard({
  chapter,
  action,
  frame,
  duration,
}: {
  chapter: Chapter;
  action?: CaptureAction;
  frame: number;
  duration: number;
}) {
  const enter = easedProgress(frame, seconds(0.12), seconds(0.42));
  const exit = interpolate(
    frame,
    [Math.max(seconds(1.2), duration - seconds(0.35)), duration],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const horizontal = action
    ? action.point.x < 960
      ? "right"
      : "left"
    : (chapter.align ?? "left");
  const vertical =
    action && action.point.y > 800
      ? "bottom"
      : action && action.point.y > 540
        ? "top"
        : "bottom";
  return (
    <div
      className={`tmv-chapter tmv-chapter--${horizontal} tmv-chapter--${vertical}`}
      style={{
        opacity: enter * exit,
        transform: `translate3d(0, ${interpolate(enter, [0, 1], [12, 0])}px, 0)`,
      }}
    >
      <span>{chapter.eyebrow}</span>
      <strong>{chapter.title}</strong>
    </div>
  );
}

function MeasuredCursor({
  action,
  from,
  frame,
  duration,
}: {
  action: CaptureAction;
  from: Point;
  frame: number;
  duration: number;
}) {
  const arriveAt =
    action.kind === "fill"
      ? seconds(0.34)
      : Math.max(seconds(0.3), duration - seconds(0.58));
  const clickAt =
    action.kind === "fill"
      ? seconds(0.46)
      : Math.max(arriveAt + 2, duration - seconds(0.2));
  const progress = easedProgress(frame, 0, arriveAt);
  const x = interpolate(progress, [0, 1], [from.x, action.point.x]);
  const y = interpolate(progress, [0, 1], [from.y, action.point.y]);
  const clickAge = frame - clickAt;
  const clickOpacity =
    clickAge >= 0 && clickAge <= 16
      ? interpolate(clickAge, [0, 6, 16], [0.72, 0.42, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;
  const clickScale =
    clickAge >= 0 && clickAge <= 16
      ? interpolate(clickAge, [0, 16], [0.72, 1.8], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: easeOut,
        })
      : 0.72;
  const focusOpacity = interpolate(
    frame,
    [Math.max(0, arriveAt - 4), arriveAt, clickAt + 5],
    [0, 0.58, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <>
      <span
        className="tmv-target-focus"
        style={{
          left: action.rect.x,
          top: action.rect.y,
          width: action.rect.width,
          height: action.rect.height,
          opacity: focusOpacity,
        }}
      />
      <div
        className="tmv-cursor"
        style={{ transform: `translate3d(${x - 3}px, ${y - 3}px, 0)` }}
      >
        <span
          className="tmv-cursor__click"
          style={{ opacity: clickOpacity, transform: `scale(${clickScale})` }}
        />
        <svg viewBox="0 0 31 35" aria-hidden="true">
          <path
            d="M3.4 2.8 27.6 22l-12.1 1.5-6.2 9.8L3.4 2.8Z"
            fill="#f4f5f6"
            stroke="#15171a"
            strokeLinejoin="round"
            strokeWidth="2.5"
          />
        </svg>
      </div>
    </>
  );
}

function TypedFill({
  action,
  frame,
  duration,
}: {
  action: CaptureAction;
  frame: number;
  duration: number;
}) {
  const prompt =
    "Build an operations dashboard for the Atlas launch team. Show release readiness, service health, current blockers, and the critical path.";
  const progress = interpolate(
    frame,
    [seconds(0.5), Math.max(seconds(0.75), duration - seconds(0.12))],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const visible = prompt.slice(0, Math.floor(prompt.length * progress));
  return (
    <div
      className="tmv-fill-text"
      style={{
        left: action.rect.x + 10,
        top: action.rect.y + 8,
        width: action.rect.width - 20,
      }}
    >
      {visible}
      <span className="tmv-fill-text__caret">|</span>
    </div>
  );
}

function easedProgress(frame: number, from: number, to: number) {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
}
