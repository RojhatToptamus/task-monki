import {
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback
} from 'react';

/**
 * Floating layers leave rather than vanish (DESIGN.md §12). A menu, popover, modal or drawer
 * whose owner stops rendering it stays on screen while its exit plays, inert so nothing waits
 * on it, and then unmounts. The exit is CSS keyed on `data-state="closed"`; a layer without one
 * (reduced motion, a test document) goes at once.
 */

/** What a layer's root element carries: the node whose exit is awaited, its state, and inertness while it leaves. */
export interface LayerProps {
  ref: RefCallback<HTMLElement>;
  'data-state': 'open' | 'closed';
  inert: boolean | undefined;
}

interface PresenceValue {
  leaving: boolean;
  layer: LayerProps;
}

const OPEN: PresenceValue = {
  leaving: false,
  layer: { ref: () => undefined, 'data-state': 'open', inert: undefined }
};
const PresenceContext = createContext<PresenceValue>(OPEN);

/** Whether the layer this component sits in is leaving: its dialog boundary hands focus back at once. */
export function useLeaving(): boolean {
  return useContext(PresenceContext).leaving;
}

/** The props for a layer's root element, to spread onto it. Outside a `Presence` the layer is simply open. */
export function useLayerProps(): LayerProps {
  return useContext(PresenceContext).layer;
}

/**
 * Renders a layer while its owner does, and keeps its last render while it leaves. The owner
 * renders it conditionally, as before: `<Presence>{open ? <Dialog /> : null}</Presence>`. A
 * single element such as a popover's `<div>` takes the layer props itself; a component spreads
 * `useLayerProps()` onto its root. A layer opened again while it leaves is a new layer.
 * `exit={false}` drops a layer at once: one that goes because it moved (a side panel that
 * docks), not because it closed.
 */
export function Presence({ children, exit = true }: { children?: ReactNode; exit?: boolean }) {
  const outer = useContext(PresenceContext);
  const open = children !== undefined && children !== null && children !== false;
  const [held, setHeld] = useState(() => ({ node: open ? children : null, leaving: false, generation: 0 }));
  if (open && (held.node !== children || held.leaving)) {
    setHeld({ node: children, leaving: false, generation: held.leaving ? held.generation + 1 : held.generation });
  } else if (!open && held.node !== null && (!held.leaving || !exit)) {
    setHeld(exit ? { ...held, leaving: true } : { ...held, node: null, leaving: false });
  }

  const node = useRef<HTMLElement | null>(null);
  const register = useCallback((element: HTMLElement | null) => {
    node.current = element;
  }, []);
  useLayoutEffect(() => {
    if (!held.leaving) return undefined;
    return afterExit(node.current, () =>
      setHeld((current) => (current.leaving ? { node: null, leaving: false, generation: current.generation } : current))
    );
  }, [held.leaving, held.generation]);

  const leaving = held.leaving || outer.leaving;
  const value = useMemo<PresenceValue>(
    () => ({ leaving, layer: { ref: register, 'data-state': leaving ? 'closed' : 'open', inert: leaving || undefined } }),
    [leaving, register]
  );
  const element = isValidElement<{ ref?: Ref<HTMLElement> }>(held.node) && typeof held.node.type === 'string' ? held.node : undefined;
  const elementRef = element?.props.ref;
  const ref = useMemo(() => composeRefs(elementRef, register), [elementRef, register]);
  if (held.node === null) return null;
  return (
    <PresenceContext.Provider value={value}>
      <Fragment key={held.generation}>
        {element ? cloneElement(element as ReactElement<Partial<LayerProps>>, { ...value.layer, ref }) : held.node}
      </Fragment>
    </PresenceContext.Provider>
  );
}

/**
 * For a layer that stays mounted and is hidden while closed (`hidden={!shown}`): shown while
 * open and while it leaves, with the props for its root.
 */
export function useExit(open: boolean): { shown: boolean; layer: LayerProps } {
  const [wasOpen, setWasOpen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setLeaving(!open);
  }
  const node = useRef<HTMLElement | null>(null);
  const register = useCallback((element: HTMLElement | null) => {
    node.current = element;
  }, []);
  useLayoutEffect(() => {
    if (!leaving) return undefined;
    return afterExit(node.current, () => setLeaving(false));
  }, [leaving]);
  const layer = useMemo<LayerProps>(
    () => ({ ref: register, 'data-state': leaving ? 'closed' : 'open', inert: leaving || undefined }),
    [leaving, register]
  );
  return { shown: open || leaving, layer };
}

/** The exits in foundation.css; a layer leaving with one of them is still on screen. */
const EXIT_ANIMATIONS = new Set(['tm-shrink-out', 'tm-fade-out', 'tm-slide-out']);

/**
 * Calls `done` once every layer leaving the window has gone, at once when none is. A native view
 * (the recorded page) draws above every layer, so it returns only after a cover has left.
 */
export function afterLeavingLayers(done: () => void): () => void {
  const leaving = (typeof document === 'undefined' ? [] : document.getAnimations?.() ?? []).filter(
    (animation) => animation instanceof CSSAnimation && EXIT_ANIMATIONS.has(animation.animationName)
  );
  return afterAll(leaving, done);
}

/**
 * Calls `done` once the exits now running on `node` and inside it have ended. Reading them
 * applies the closed state, so the exit has started; a loop (the live shimmer) is not an exit.
 */
function afterExit(node: HTMLElement | null, done: () => void): () => void {
  const exits = (node?.getAnimations?.({ subtree: true }) ?? []).filter((animation) =>
    Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
  );
  return afterAll(exits, done);
}

/** The longest a layer may take to leave; an exit that never reports its end is cut here. */
const EXIT_LIMIT_MS = 600;

function afterAll(exits: Animation[], done: () => void): () => void {
  if (exits.length === 0) {
    done();
    return () => undefined;
  }
  let live = true;
  const finish = () => {
    if (!live) return;
    live = false;
    window.clearTimeout(limit);
    done();
  };
  const limit = window.setTimeout(finish, EXIT_LIMIT_MS);
  void Promise.allSettled(exits.map((animation) => animation.finished)).then(finish);
  return () => {
    live = false;
    window.clearTimeout(limit);
  };
}

function composeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value);
      else if (ref) (ref as { current: T | null }).current = value;
    }
  };
}
