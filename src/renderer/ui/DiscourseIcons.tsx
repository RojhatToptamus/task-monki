import {
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  FileText,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Reply,
  SlidersHorizontal,
  StickyNote,
  UsersRound,
  X,
  type LucideIcon
} from 'lucide-react';
import type { DiscourseDefaultPolicy } from '../../shared/discourse';

const ICON_PROPS = {
  'aria-hidden': true,
  focusable: false,
  strokeWidth: 1.8
} as const;

function Icon({ icon: Glyph, size = 16 }: { icon: LucideIcon; size?: number }) {
  return <Glyph {...ICON_PROPS} size={size} />;
}

export function DiscoursePinIcon() {
  return <Icon icon={Pin} size={12} />;
}

export function DiscourseTaskIcon() {
  return <Icon icon={ListTodo} size={13} />;
}

export function DiscourseRepositoryIcon() {
  return <Icon icon={BookOpen} size={13} />;
}

export function DiscoursePanelLeftIcon({ expanded = false }: { expanded?: boolean }) {
  return <Icon icon={expanded ? PanelLeftClose : PanelLeftOpen} />;
}

export function DiscoursePanelRightIcon({ expanded = false }: { expanded?: boolean }) {
  return <Icon icon={expanded ? PanelRightClose : PanelRightOpen} />;
}

export function DiscourseContextPreviewIcon() {
  return <Icon icon={FileText} />;
}

export function DiscourseSlidersIcon() {
  return <Icon icon={SlidersHorizontal} size={15} />;
}

export function DiscourseReplyIcon() {
  return <Icon icon={Reply} size={16} />;
}

export function DiscourseCopyIcon() {
  return <Icon icon={Copy} size={16} />;
}

export function DiscourseCheckIcon() {
  return <Icon icon={Check} size={14} />;
}

export function DiscourseMoreIcon() {
  return <Icon icon={Ellipsis} />;
}

export function DiscourseChevronDownIcon() {
  return <Icon icon={ChevronDown} size={14} />;
}

export function DiscourseCloseIcon() {
  return <Icon icon={X} size={15} />;
}

export function DiscourseRoundtableIcon() {
  return <Icon icon={MessagesSquare} size={28} />;
}

export function DiscourseNavIcon() {
  return <Icon icon={MessagesSquare} size={18} />;
}

export function DiscourseModeIcon({ policy }: { policy: DiscourseDefaultPolicy }) {
  const icon = policy === 'NONE'
    ? StickyNote
    : policy === 'DIRECT'
      ? MessageSquare
      : policy === 'PANEL'
        ? MessagesSquare
        : UsersRound;
  return <Icon icon={icon} size={16} />;
}
