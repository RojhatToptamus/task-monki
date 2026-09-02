import { Composition } from 'remotion';
import {
  TaskMonkiShowcase,
  VIDEO_DURATION_FRAMES,
  VIDEO_FPS
} from './TaskMonkiShowcase';

export function RemotionRoot() {
  return (
    <Composition
      id="TaskMonkiShowcase"
      component={TaskMonkiShowcase}
      durationInFrames={VIDEO_DURATION_FRAMES}
      fps={VIDEO_FPS}
      width={1920}
      height={1080}
    />
  );
}
