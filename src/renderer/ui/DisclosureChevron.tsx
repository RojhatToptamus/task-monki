import { ChevronRight } from 'lucide-react';

export function DisclosureChevron({ className }: { className?: string }) {
  return (
    <ChevronRight
      absoluteStrokeWidth
      aria-hidden="true"
      className={['tm-disclosure__chevron', className].filter(Boolean).join(' ')}
      focusable="false"
      size={12}
      strokeWidth={1.5}
    />
  );
}
