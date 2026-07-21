import { useEffect, useRef, useState } from 'react';
import type { MascotState } from '../model/mascotState';

type MascotVideoLayerPhase = 'entering' | 'active' | 'exiting';

const MASCOT_EXIT_FALLBACK_MS = 620;
const MASCOT_PLAYBACK_RATE = 0.85;

interface MascotVideoLayer {
  id: number;
  source: string;
  state: MascotState;
  phase: MascotVideoLayerPhase;
}

export function TaskMascotVideo({
  source,
  state,
  prefersReducedMotion
}: {
  source: string;
  state: MascotState;
  prefersReducedMotion: boolean;
}) {
  const nextLayerIdRef = useRef(1);
  const videoRefs = useRef(new Map<number, HTMLVideoElement>());
  const [layers, setLayers] = useState<MascotVideoLayer[]>([
    { id: 0, source, state, phase: 'active' }
  ]);

  useEffect(() => {
    setLayers((current) => {
      const active =
        current.find((layer) => layer.phase === 'active') ?? current[current.length - 1];
      if (prefersReducedMotion) {
        if (active?.source === source) {
          return [{ ...active, state, phase: 'active' }];
        }

        const nextLayer: MascotVideoLayer = {
          id: nextLayerIdRef.current,
          source,
          state,
          phase: 'active'
        };
        nextLayerIdRef.current += 1;
        return [nextLayer];
      }

      if (active?.source === source) {
        return current.map((layer) =>
          layer.source === source
            ? { ...layer, state, phase: 'active' }
            : { ...layer, phase: 'exiting' }
        );
      }

      const nextLayer: MascotVideoLayer = {
        id: nextLayerIdRef.current,
        source,
        state,
        phase: 'entering'
      };
      nextLayerIdRef.current += 1;

      return [
        ...current.map((layer) => ({ ...layer, phase: 'exiting' as const })).slice(-1),
        nextLayer
      ];
    });
  }, [source, state, prefersReducedMotion]);

  useEffect(() => {
    if (prefersReducedMotion || !layers.some((layer) => layer.phase === 'entering')) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      setLayers((current) =>
        current.map((layer) =>
          layer.phase === 'entering' ? { ...layer, phase: 'active' } : layer
        )
      );
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [layers, prefersReducedMotion]);

  useEffect(() => {
    if (prefersReducedMotion || !layers.some((layer) => layer.phase === 'exiting')) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setLayers((current) => current.filter((layer) => layer.phase !== 'exiting'));
    }, MASCOT_EXIT_FALLBACK_MS);

    return () => window.clearTimeout(timeout);
  }, [layers, prefersReducedMotion]);

  useEffect(() => {
    for (const video of videoRefs.current.values()) {
      video.playbackRate = MASCOT_PLAYBACK_RATE;
      if (prefersReducedMotion) {
        video.pause();
        if (video.currentTime > 0.05) {
          video.currentTime = 0;
        }
      } else {
        void video.play().catch(() => undefined);
      }
    }
  }, [layers, prefersReducedMotion]);

  return (
    <div className="tm-detail__mascot" data-mascot-state={state} aria-hidden="true">
      {layers.map((layer) => (
        <video
          key={layer.id}
          ref={(video) => {
            if (video) {
              videoRefs.current.set(layer.id, video);
            } else {
              videoRefs.current.delete(layer.id);
            }
          }}
          className={`tm-detail__mascot-video tm-detail__mascot-video--${layer.phase}`}
          src={layer.source}
          data-mascot-state={layer.state}
          autoPlay={!prefersReducedMotion}
          loop={!prefersReducedMotion}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          onTransitionEnd={(event) => {
            if (layer.phase !== 'exiting' || event.propertyName !== 'opacity') {
              return;
            }
            setLayers((current) =>
              current.filter((candidate) => candidate.id !== layer.id)
            );
          }}
        />
      ))}
    </div>
  );
}

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return prefersReducedMotion;
}
