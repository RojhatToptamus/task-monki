import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Copies text and reports success for a moment, so the control that copied can say so itself. */
export function useCopied(onError?: () => void): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (text: string) => {
    const write = navigator.clipboard?.writeText(text);
    if (!write) return onError?.();
    void write.then(() => setCopied(true), () => onError?.());
  };
  return [copied, copy];
}

/** The copy glyph, swapped for a check while the copy is confirmed. */
export function CopyGlyph({ copied, size = 16 }: { copied: boolean; size?: number }) {
  return copied ? <Check size={size} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={size} strokeWidth={1.5} aria-hidden="true" />;
}

/** An icon button that copies a value; it confirms on itself rather than elsewhere on the page. */
export function CopyIconButton({ value, label, size = 16, className = 'tm-iconbtn', onError }: {
  /** The text, or a function that reads it when the button is pressed. */
  value: string | (() => string);
  /** What is copied, as the button's accessible name, such as "Copy response". */
  label: string;
  size?: number;
  className?: string;
  onError?(): void;
}) {
  const [copied, copy] = useCopied(onError);
  const name = copied ? 'Copied' : label;
  return (
    <button type="button" className={className} aria-label={name} title={name} onClick={() => copy(typeof value === 'function' ? value() : value)}>
      <CopyGlyph copied={copied} size={size} />
    </button>
  );
}
