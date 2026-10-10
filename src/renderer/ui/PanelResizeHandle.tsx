import { useRef, type CSSProperties } from 'react';

export interface PanelResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  controls?: string;
  direction?: 1 | -1;
  /** `vertical` separates columns (the default); `horizontal` separates rows. */
  orientation?: 'vertical' | 'horizontal';
  className?: string;
  /** Placement for a handle that overlays its panels instead of sitting between them. */
  style?: CSSProperties;
  onChange(value: number): void;
  /** Double-click action; defaults to `onChange(defaultValue)`. */
  onReset?(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Shared pointer and keyboard contract for panel resizing. */
export function PanelResizeHandle({
  label,
  value,
  min,
  max,
  defaultValue,
  controls,
  direction = 1,
  orientation = 'vertical',
  className = '',
  style,
  onChange,
  onReset
}: PanelResizeHandleProps) {
  const dragRef = useRef<{
    pointerId: number;
    start: number;
    startValue: number;
  } | undefined>(undefined);
  const update = (next: number) => onChange(clamp(next, min, max));
  const rows = orientation === 'horizontal';
  const position = (event: { clientX: number; clientY: number }) =>
    rows ? event.clientY : event.clientX;
  const [decrease, increase] = rows ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];

  return (
    <div
      className={['tm-panel-resize', rows ? 'tm-panel-resize--horizontal' : '', className].filter(Boolean).join(' ')}
      style={style}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-controls={controls}
      tabIndex={0}
      title={`${label}. Double-click to reset.`}
      onDoubleClick={() => (onReset ? onReset() : update(defaultValue))}
      onPointerDown={(event) => {
        dragRef.current = {
          pointerId: event.pointerId,
          start: position(event),
          startValue: value
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        update(drag.startValue + (position(event) - drag.start) * direction);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        dragRef.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onLostPointerCapture={() => {
        dragRef.current = undefined;
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 16;
        const next = event.key === decrease
          ? value - step * direction
          : event.key === increase
            ? value + step * direction
            : event.key === 'Home'
              ? min
              : event.key === 'End'
                ? max
                : undefined;
        if (next === undefined) return;
        event.preventDefault();
        update(next);
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}
