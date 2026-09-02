import { Audio } from '@remotion/media';
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from 'remotion';
import showcaseSource from './showcase.json';

type Point = { x: number; y: number };
type Focus = Point & { zoom: number };
type Chapter = { eyebrow: string; title: string };
type Action = Point & { at: number; kind: 'click' | 'focus' };
type SceneSpec = {
  id: string;
  image: string;
  backgroundImage?: string;
  prototypeImage?: string;
  start: number;
  duration: number;
  sourceKind: 'task-monki' | 'preview-inset' | 'design-composite';
  focus: Focus;
  chapter?: Chapter;
  label?: string;
  action?: Action;
  outro?: boolean;
};
type VoiceoverSpec = {
  id: string;
  file: string;
  start: number;
  duration: number;
  text: string;
};
type ShowcaseConfig = {
  durationSeconds: number;
  fps: number;
  scenes: SceneSpec[];
  voiceover: VoiceoverSpec[];
};

const showcase = showcaseSource as ShowcaseConfig;
export const VIDEO_FPS = showcase.fps;
export const VIDEO_DURATION_FRAMES = Math.round(showcase.durationSeconds * VIDEO_FPS);

const transitionFrames = 8;
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const clickScenes = showcase.scenes.filter((scene) => scene.action?.kind === 'click');

export function TaskMonkiShowcase() {
  return (
    <AbsoluteFill className="tmv-root">
      <Audio
        src={staticFile('remotion-showcase/audio/music.wav')}
        loop
        loopVolumeCurveBehavior="extend"
        volume={(frame) =>
          interpolate(
            frame,
            [0, VIDEO_FPS * 2, VIDEO_DURATION_FRAMES - VIDEO_FPS * 2, VIDEO_DURATION_FRAMES],
            [0, 0.3, 0.3, 0],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
          )
        }
      />

      {showcase.voiceover.map((voiceover) => (
        <Sequence
          key={voiceover.id}
          from={seconds(voiceover.start)}
          durationInFrames={seconds(voiceover.duration)}
          premountFor={VIDEO_FPS}
        >
          <Audio src={staticFile(`remotion-showcase/${voiceover.file}`)} volume={1} />
        </Sequence>
      ))}

      {clickScenes.map((scene) => (
        <Sequence
          key={`click-${scene.id}`}
          from={seconds(scene.start + (scene.action?.at ?? 0))}
          durationInFrames={12}
          premountFor={6}
        >
          <Audio src={staticFile('remotion-showcase/audio/click.wav')} volume={0.38} />
        </Sequence>
      ))}

      {showcase.scenes.map((scene, index) => (
        <Sequence
          key={scene.id}
          from={seconds(scene.start)}
          durationInFrames={seconds(scene.duration) + (index === showcase.scenes.length - 1 ? 0 : transitionFrames)}
          premountFor={VIDEO_FPS}
        >
          <ShowcaseScene
            scene={scene}
            priorAction={findPriorAction(index)}
            isLast={index === showcase.scenes.length - 1}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

function ShowcaseScene({
  scene,
  priorAction,
  isLast
}: {
  scene: SceneSpec;
  priorAction: Point;
  isLast: boolean;
}) {
  const frame = useCurrentFrame();
  const durationFrames = seconds(scene.duration);
  const opacity = sceneOpacity(frame, durationFrames, isLast);
  const cameraProgress = interpolate(frame, [0, durationFrames], [0, 1], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  const scale = interpolate(cameraProgress, [0, 1], [Math.max(1, scene.focus.zoom - 0.025), scene.focus.zoom]);

  return (
    <AbsoluteFill style={{ opacity }}>
      <div
        className="tmv-camera"
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${scene.focus.x}px ${scene.focus.y}px`
        }}
      >
        <SceneImage scene={scene} />
      </div>

      {scene.chapter ? <ChapterCard chapter={scene.chapter} frame={frame} duration={durationFrames} /> : null}
      {scene.label ? <SceneLabel text={scene.label} frame={frame} duration={durationFrames} /> : null}
      {scene.action ? <Cursor action={scene.action} from={priorAction} frame={frame} /> : null}
      {scene.outro ? <Outro frame={frame} /> : null}
    </AbsoluteFill>
  );
}

function SceneImage({ scene }: { scene: SceneSpec }) {
  if (scene.sourceKind === 'preview-inset') {
    return (
      <AbsoluteFill className="tmv-inset-context">
        <Img
          className="tmv-full-image tmv-inset-background"
          src={staticFile(`remotion-showcase/${scene.backgroundImage}`)}
        />
        <div className="tmv-preview-window">
          <div className="tmv-preview-window__bar">
            <div className="tmv-window-controls"><span /><span /><span /></div>
            <strong>Task Monki Preview</strong>
            <code>checkout-api.local</code>
          </div>
          <Img
            className="tmv-preview-window__image"
            src={staticFile(`remotion-showcase/${scene.image}`)}
          />
        </div>
      </AbsoluteFill>
    );
  }

  if (scene.sourceKind === 'design-composite') {
    return (
      <AbsoluteFill>
        <Img className="tmv-full-image" src={staticFile(`remotion-showcase/${scene.image}`)} />
        <div className="tmv-design-canvas">
          <Img
            className="tmv-design-canvas__image"
            src={staticFile(`remotion-showcase/${scene.prototypeImage}`)}
          />
        </div>
      </AbsoluteFill>
    );
  }

  return <Img className="tmv-full-image" src={staticFile(`remotion-showcase/${scene.image}`)} />;
}

function ChapterCard({ chapter, frame, duration }: { chapter: Chapter; frame: number; duration: number }) {
  const enter = interpolate(frame, [4, 20], [0, 1], {
    easing: easeOut,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  const exit = interpolate(frame, [Math.max(45, duration - 14), duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  return (
    <div
      className="tmv-chapter"
      style={{
        opacity: enter * exit,
        transform: `translate3d(0, ${interpolate(enter, [0, 1], [14, 0])}px, 0)`
      }}
    >
      <span>{chapter.eyebrow}</span>
      <strong>{chapter.title}</strong>
    </div>
  );
}

function SceneLabel({ text, frame, duration }: { text: string; frame: number; duration: number }) {
  const opacity = interpolate(frame, [8, 20, duration - 16, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  return <div className="tmv-label" style={{ opacity }}>{text}</div>;
}

function Cursor({ action, from, frame }: { action: Action; from: Point; frame: number }) {
  const actionFrame = seconds(action.at);
  const movement = interpolate(frame, [Math.max(0, actionFrame - 30), Math.max(1, actionFrame - 5)], [0, 1], {
    easing: easeOut,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  const x = interpolate(movement, [0, 1], [from.x, action.x]);
  const y = interpolate(movement, [0, 1], [from.y, action.y]);
  const visibility = interpolate(
    frame,
    [Math.max(0, actionFrame - 38), Math.max(1, actionFrame - 28), actionFrame + 14, actionFrame + 24],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const clickAge = frame - actionFrame;
  const ringOpacity = action.kind === 'click' && clickAge >= 0
    ? interpolate(clickAge, [0, 5, 16], [0.8, 0.5, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;
  const ringScale = interpolate(Math.max(0, clickAge), [0, 16], [0.7, 2], {
    easing: easeOut,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });

  return (
    <>
      <span
        className="tmv-focus-ring"
        style={{ left: action.x - 30, top: action.y - 22, opacity: visibility * 0.7 }}
      />
      <div
        className="tmv-cursor"
        style={{ opacity: visibility, transform: `translate3d(${x - 3}px, ${y - 3}px, 0)` }}
      >
        <span className="tmv-click-ring" style={{ opacity: ringOpacity, transform: `scale(${ringScale})` }} />
        <svg viewBox="0 0 31 35" aria-hidden="true">
          <path
            d="M3.4 2.8 27.6 22l-12.1 1.5-6.2 9.8L3.4 2.8Z"
            fill="#f7f8fa"
            stroke="#101114"
            strokeLinejoin="round"
            strokeWidth="2.5"
          />
        </svg>
      </div>
    </>
  );
}

function Outro({ frame }: { frame: number }) {
  const enter = interpolate(frame, [0, 22], [0, 1], {
    easing: easeOut,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  return (
    <AbsoluteFill className="tmv-outro" style={{ opacity: enter }}>
      <Img className="tmv-outro__mark" src={staticFile('assets/brand/monkey_icon_cream.svg')} />
      <h1>Task Monki</h1>
      <p>Free and open source</p>
      <strong>monki.work</strong>
    </AbsoluteFill>
  );
}

function sceneOpacity(frame: number, duration: number, isLast: boolean) {
  const enter = interpolate(frame, [0, transitionFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  if (isLast) return enter;
  const exit = interpolate(frame, [duration - transitionFrames, duration + transitionFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  return enter * exit;
}

function findPriorAction(index: number): Point {
  for (let sceneIndex = index - 1; sceneIndex >= 0; sceneIndex -= 1) {
    const action = showcase.scenes[sceneIndex]?.action;
    if (action) return { x: action.x, y: action.y };
  }
  return { x: 1848, y: 25 };
}

function seconds(value: number) {
  return Math.round(value * VIDEO_FPS);
}
