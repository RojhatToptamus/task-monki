import { Composition, Still } from "remotion";
import {
  TaskMonkiPoster,
  TaskMonkiShowcase,
  VIDEO_DURATION_FRAMES,
  VIDEO_FPS,
} from "./TaskMonkiShowcase";
import "./showcase.css";

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="TaskMonkiShowcase"
        component={TaskMonkiShowcase}
        durationInFrames={VIDEO_DURATION_FRAMES}
        fps={VIDEO_FPS}
        width={1920}
        height={1080}
      />
      <Still
        id="TaskMonkiPoster"
        component={TaskMonkiPoster}
        width={1920}
        height={1080}
      />
    </>
  );
}
