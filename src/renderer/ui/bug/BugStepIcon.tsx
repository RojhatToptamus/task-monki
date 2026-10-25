import {
  ArrowLeftRight,
  ChevronsUpDown,
  CircleAlert,
  CircleX,
  Dot,
  Globe,
  Keyboard,
  MessageSquare,
  MousePointerClick,
  RotateCw,
  Square,
  SquareCheck,
  TextCursorInput
} from 'lucide-react';
import type { BugTimelineEntry } from '../../../shared/bugReplay';

const ICONS = {
  navigate: Globe,
  reload: RotateCw,
  click: MousePointerClick,
  check: SquareCheck,
  uncheck: Square,
  fill: TextCursorInput,
  select: ChevronsUpDown,
  press: Keyboard,
  dialog: MessageSquare,
  step: Dot,
  unsupported: CircleAlert,
  request: ArrowLeftRight,
  error: CircleX
} satisfies Record<BugTimelineEntry['kind'], unknown>;

/** What a step or a page event is, by its shape: the same mark in the live rail, the composer, the Overview and a replay. */
export function BugStepIcon({ kind }: { kind: BugTimelineEntry['kind'] }) {
  const Icon = ICONS[kind];
  return <Icon className="tm-bugstep__icon" size={13} aria-hidden="true" />;
}
