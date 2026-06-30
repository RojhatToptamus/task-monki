import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const VIDEO_FPS = 30;

const seconds = (value: number) => Math.round(value * VIDEO_FPS);
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

interface ShotSpec {
  id: string;
  duration: number;
  image: string;
  camera?: CameraMove;
  cursor?: CursorMove;
}

interface CameraMove {
  zoomFrom: number;
  zoomTo: number;
  panFrom: [number, number];
  panTo: [number, number];
}

interface CursorMove {
  from: [number, number];
  to: [number, number];
  arriveAt?: number;
  clickAt?: number;
}

const shots: ShotSpec[] = [
  {
    id: "board-open",
    duration: seconds(2),
    image: "01-board.png",
    cursor: {
      from: [1680, 72],
      to: [1854, 23],
      arriveAt: seconds(1.1),
      clickAt: seconds(1.32),
    },
  },
  {
    id: "new-task-empty",
    duration: seconds(1.2),
    image: "02-new-task-empty.png",
    cursor: {
      from: [1854, 23],
      to: [1450, 139],
      arriveAt: seconds(0.72),
      clickAt: seconds(0.92),
    },
  },
  {
    id: "new-task-title-start",
    duration: seconds(0.7),
    image: "03-new-task-title-start.png",
  },
  {
    id: "new-task-title-full",
    duration: seconds(1),
    image: "04-new-task-title-full.png",
    cursor: {
      from: [1450, 139],
      to: [1450, 222],
      arriveAt: seconds(0.55),
      clickAt: seconds(0.76),
    },
  },
  {
    id: "new-task-description-full",
    duration: seconds(1.3),
    image: "05-new-task-description-full.png",
    cursor: {
      from: [1450, 222],
      to: [1870, 182],
      arriveAt: seconds(0.78),
      clickAt: seconds(1),
    },
  },
  {
    id: "new-task-refining",
    duration: seconds(0.9),
    image: "06-new-task-refining.png",
  },
  {
    id: "new-task-refined",
    duration: seconds(2.4),
    image: "07-new-task-refined.png",
    cursor: {
      from: [1870, 182],
      to: [1452, 1048],
      arriveAt: seconds(1.45),
      clickAt: seconds(1.72),
    },
  },
  {
    id: "created-task-notifier",
    duration: seconds(1.2),
    image: "08-created-task-notifier.png",
  },
  {
    id: "created-task-board",
    duration: seconds(1.7),
    image: "09-created-task-board.png",
    cursor: {
      from: [1452, 1048],
      to: [408, 226],
      arriveAt: seconds(1.05),
      clickAt: seconds(1.28),
    },
  },
  {
    id: "created-task-open",
    duration: seconds(1.9),
    image: "10-created-task-open.png",
    cursor: {
      from: [408, 226],
      to: [1828, 79],
      arriveAt: seconds(1.06),
      clickAt: seconds(1.3),
    },
  },
  {
    id: "prepare-worktree-notifier",
    duration: seconds(1.2),
    image: "11-prepare-worktree-notifier.png",
  },
  {
    id: "worktree-ready",
    duration: seconds(1.55),
    image: "12-worktree-ready.png",
    cursor: {
      from: [1828, 79],
      to: [1808, 79],
      arriveAt: seconds(0.86),
      clickAt: seconds(1.08),
    },
  },
  {
    id: "start-task-notifier",
    duration: seconds(1.2),
    image: "13-start-task-notifier.png",
  },
  {
    id: "created-task-running",
    duration: seconds(1.65),
    image: "14-created-task-running.png",
  },
  {
    id: "created-task-finished",
    duration: seconds(2.2),
    image: "15-created-task-finished.png",
    cursor: {
      from: [520, 640],
      to: [360, 470],
      arriveAt: seconds(1.25),
      clickAt: seconds(1.5),
    },
  },
  {
    id: "review-running-a",
    duration: seconds(0.85),
    image: "16-review-running-a.png",
  },
  {
    id: "review-running-b",
    duration: seconds(0.85),
    image: "17-review-running-b.png",
  },
  {
    id: "review-running-c",
    duration: seconds(1),
    image: "18-review-running-c.png",
  },
  {
    id: "review-complete",
    duration: seconds(2.8),
    image: "19-review-complete.png",
    cursor: {
      from: [360, 470],
      to: [357, 816],
      arriveAt: seconds(1.55),
      clickAt: seconds(1.82),
    },
  },
  {
    id: "request-changes-open",
    duration: seconds(1.35),
    image: "20-request-changes-open.png",
    cursor: {
      from: [357, 816],
      to: [1446, 509],
      arriveAt: seconds(0.8),
      clickAt: seconds(1.02),
    },
  },
  {
    id: "request-changes-checkboxes",
    duration: seconds(1.2),
    image: "21-request-changes-checkboxes.png",
  },
  {
    id: "request-changes-submit",
    duration: seconds(1.45),
    image: "22-request-changes-submit.png",
    cursor: {
      from: [1446, 509],
      to: [1835, 1047],
      arriveAt: seconds(0.9),
      clickAt: seconds(1.13),
    },
  },
  {
    id: "followup-started-overview",
    duration: seconds(1.15),
    image: "23-followup-started-overview.png",
  },
  {
    id: "followup-overview",
    duration: seconds(1.75),
    image: "24-followup-overview.png",
  },
  {
    id: "evidence-tab-click",
    duration: seconds(1.1),
    image: "25-evidence-tab-click.png",
    cursor: {
      from: [1835, 1047],
      to: [382, 164],
      arriveAt: seconds(0.72),
      clickAt: seconds(0.94),
    },
  },
  {
    id: "evidence-all",
    duration: seconds(1.8),
    image: "26-evidence-all.png",
    cursor: {
      from: [382, 164],
      to: [515, 262],
      arriveAt: seconds(1),
      clickAt: seconds(1.25),
    },
  },
  {
    id: "evidence-uncommitted",
    duration: seconds(1.5),
    image: "27-evidence-uncommitted.png",
    cursor: {
      from: [515, 262],
      to: [423, 262],
      arriveAt: seconds(0.78),
      clickAt: seconds(1),
    },
  },
  {
    id: "evidence-committed",
    duration: seconds(1.4),
    image: "28-evidence-committed.png",
  },
  {
    id: "debug-tab-click",
    duration: seconds(1.05),
    image: "29-debug-tab-click.png",
    cursor: {
      from: [423, 262],
      to: [461, 164],
      arriveAt: seconds(0.7),
      clickAt: seconds(0.9),
    },
  },
  {
    id: "debug",
    duration: seconds(2.2),
    image: "30-debug.png",
  },
  {
    id: "settings-click",
    duration: seconds(1.05),
    image: "31-settings-click.png",
    cursor: {
      from: [461, 164],
      to: [75, 318],
      arriveAt: seconds(0.68),
      clickAt: seconds(0.9),
    },
  },
  {
    id: "settings",
    duration: seconds(2),
    image: "32-settings.png",
  },
  {
    id: "board-click",
    duration: seconds(1),
    image: "33-board-click.png",
    cursor: {
      from: [75, 318],
      to: [70, 160],
      arriveAt: seconds(0.6),
      clickAt: seconds(0.82),
    },
  },
  {
    id: "closing",
    duration: seconds(2.6),
    image: "34-closing-board.png",
  },
];

const sceneStarts = shots.reduce<number[]>((starts, shot, index) => {
  starts.push(index === 0 ? 0 : starts[index - 1] + shots[index - 1].duration);
  return starts;
}, []);

export const VIDEO_DURATION_FRAMES =
  sceneStarts.at(-1)! + shots.at(-1)!.duration;

export function TaskMonkiShowcase() {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill className="tmv-root">
      {shots.map((shot, index) => (
        <Shot
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
        src={staticFile("remotion-captures/26-evidence-all.png")}
      />
    </AbsoluteFill>
  );
}

function Shot({
  shot,
  start,
  frame,
}: {
  shot: ShotSpec;
  start: number;
  frame: number;
}) {
  const localFrame = frame - start;
  const visible = localFrame >= 0 && localFrame < shot.duration;
  if (!visible) {
    return null;
  }

  const cameraMove =
    shot.camera ??
    ({
      zoomFrom: 1,
      zoomTo: 1,
      panFrom: [0, 0],
      panTo: [0, 0],
    } satisfies CameraMove);
  const camera = easedProgress(localFrame, 0, shot.duration);
  const scale = interpolate(
    camera,
    [0, 1],
    [cameraMove.zoomFrom, cameraMove.zoomTo],
  );
  const x = interpolate(
    camera,
    [0, 1],
    [cameraMove.panFrom[0], cameraMove.panTo[0]],
  );
  const y = interpolate(
    camera,
    [0, 1],
    [cameraMove.panFrom[1], cameraMove.panTo[1]],
  );

  return (
    <AbsoluteFill>
      <div
        className="tmv-shot"
        style={{
          transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
        }}
      >
        <Img
          className="tmv-shot__image"
          src={staticFile(`remotion-captures/${shot.image}`)}
        />
      </div>
      {shot.cursor ? <Cursor cursor={shot.cursor} frame={localFrame} /> : null}
    </AbsoluteFill>
  );
}

function Cursor({ cursor, frame }: { cursor: CursorMove; frame: number }) {
  const arriveAt = cursor.arriveAt ?? cursor.clickAt ?? seconds(1);
  const progress = easedProgress(frame, 0, arriveAt);
  const x = interpolate(progress, [0, 1], [cursor.from[0], cursor.to[0]]);
  const y = interpolate(progress, [0, 1], [cursor.from[1], cursor.to[1]]);
  const clickAge =
    typeof cursor.clickAt === "number"
      ? frame - cursor.clickAt
      : Number.NEGATIVE_INFINITY;
  const clickOpacity =
    clickAge >= 0 && clickAge <= 18
      ? interpolate(clickAge, [0, 8, 18], [0.58, 0.34, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;
  const clickScale =
    clickAge >= 0 && clickAge <= 18
      ? interpolate(clickAge, [0, 18], [0.82, 1.9], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: easeOut,
        })
      : 0.82;

  return (
    <div
      className="tmv-cursor"
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
      }}
    >
      <span
        className="tmv-cursor__click"
        style={{
          opacity: clickOpacity,
          transform: `scale(${clickScale})`,
        }}
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
  );
}

function easedProgress(frame: number, from: number, to: number) {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
}
