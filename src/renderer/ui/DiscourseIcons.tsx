import {
  Check,
  ChevronDown,
  ClipboardCheck,
  Copy,
  FileText,
  Folder,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  PanelRight,
  Pin,
  Reply,
  Settings2,
  Users,
  X
} from 'lucide-react';
import type { DiscourseDefaultPolicy } from '../../shared/discourse';
import { UiLucideIcon } from './UiIcons';

export function DiscoursePinIcon() {
  return <UiLucideIcon component={Pin} size={12} />;
}

export function DiscourseTaskIcon() {
  return <UiLucideIcon component={ClipboardCheck} size={13} />;
}

export function DiscourseRepositoryIcon() {
  return <UiLucideIcon component={Folder} size={13} />;
}

export function DiscoursePanelRightIcon(_props: { expanded?: boolean }) {
  return <UiLucideIcon component={PanelRight} />;
}

export function DiscourseContextPreviewIcon() {
  return <UiLucideIcon component={FileText} />;
}

export function DiscourseSlidersIcon() {
  return <UiLucideIcon component={Settings2} size={15} />;
}

export function DiscourseReplyIcon() {
  return <UiLucideIcon component={Reply} />;
}

export function DiscourseCopyIcon() {
  return <UiLucideIcon component={Copy} />;
}

export function DiscourseCheckIcon() {
  return <UiLucideIcon component={Check} size={14} />;
}

export function DiscourseMoreIcon() {
  return <UiLucideIcon component={MoreHorizontal} />;
}

export function DiscourseChevronDownIcon() {
  return <UiLucideIcon component={ChevronDown} size={14} />;
}

export function DiscourseCloseIcon() {
  return <UiLucideIcon component={X} size={15} />;
}

export function DiscourseRoundtableIcon() {
  return <UiLucideIcon component={MessagesSquare} size={28} />;
}

export function DiscourseNavIcon() {
  return <UiLucideIcon component={MessageSquare} />;
}

export function DiscourseModeIcon({ policy }: { policy: DiscourseDefaultPolicy }) {
  if (policy === 'NONE') return <UiLucideIcon component={FileText} />;
  if (policy === 'DIRECT') return <UiLucideIcon component={MessageSquare} />;
  if (policy === 'PANEL') return <UiLucideIcon component={MessagesSquare} />;
  return <UiLucideIcon component={Users} />;
}
