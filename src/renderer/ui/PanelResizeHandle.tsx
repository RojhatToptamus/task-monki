import { useRef } from 'react';

export interface PanelResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  controls?: string;
  direction?: 1 | -1;
  className?: string;
  onChange(value: number): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Shared pointer and keyboard contract for horizontal panel resizing. */
export function PanelResizeHandle({
  label,
  value,
  min,
  max,
  defaultValue,
  controls,
  direction = 1,
  className = '',
  onChange
}: PanelResizeHandleProps) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startValue: number;
  } | undefined>(undefined);
  const update = (next: number) => onChange(clamp(next, min, max));

  return (
    <div
      className={['tm-panel-resize', className].filter(Boolean).join(' ')}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-controls={controls}
      tabIndex={0}
      title={`${label}. Double-click to reset.`}
      onDoubleClick={() => update(defaultValue)}
      onPointerDown={(event) => {
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startValue: value
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        update(drag.startValue + (event.clientX - drag.startX) * direction);
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
        const next = event.key === 'ArrowLeft'
          ? value - step * direction
          : event.key === 'ArrowRight'
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
