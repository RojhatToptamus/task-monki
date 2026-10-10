import {
  ArrowRight,
  Check,
  ChevronDown,
  Columns2,
  ExternalLink,
  FileText,
  Folder,
  Image,
  Monitor,
  Plus,
  RefreshCw,
  Rows2,
  Search,
  Smartphone,
  Sparkles,
  Tablet,
  X,
  type LucideIcon
} from 'lucide-react';
import type { DesignWorkspaceLayoutMode } from '../model/designs';

// The line weight comes from CSS (`--icon-stroke`), the same at every size.
const iconProps = (size: number, className?: string) => ({
  'aria-hidden': true as const,
  className,
  focusable: false as const,
  size
});

export function UiLucideIcon({
  component: Component,
  size = 16,
  className
}: {
  component: LucideIcon;
  size?: number;
  className?: string;
}) {
  return <Component {...iconProps(size, className)} />;
}

/**
 * The one mark for every agent in the app: the implementation agent's side
 * question, the reviewer, the Preview agent and prompt refinement. Agents
 * never get a chat or comment icon (DESIGN.md 3.3).
 */
export function AgentMark({ size = 14, className }: { size?: number; className?: string } = {}) {
  return <UiLucideIcon component={Sparkles} size={size} className={className} />;
}

export function UiPlusIcon() {
  return <UiLucideIcon component={Plus} />;
}

export function UiSearchIcon() {
  return <UiLucideIcon component={Search} />;
}

export function UiCloseIcon({ size = 16 }: { size?: number } = {}) {
  return <UiLucideIcon component={X} size={size} />;
}

export function UiFolderIcon({ size = 16 }: { size?: number } = {}) {
  return <UiLucideIcon component={Folder} size={size} />;
}

export function UiLayoutIcon({ layout }: { layout: DesignWorkspaceLayoutMode }) {
  const component = layout === 'chat' ? FileText : layout === 'split' ? Columns2 : Rows2;
  return <UiLucideIcon component={component} />;
}

export function UiDesktopIcon() {
  return <UiLucideIcon component={Monitor} />;
}

export function UiTabletIcon() {
  return <UiLucideIcon component={Tablet} />;
}

export function UiPhoneIcon() {
  return <UiLucideIcon component={Smartphone} />;
}

export function UiRefreshIcon() {
  return <UiLucideIcon component={RefreshCw} />;
}

export function UiExternalLinkIcon() {
  return <UiLucideIcon component={ExternalLink} />;
}

export function UiFileIcon({
  kind = 'text',
  size = 16
}: {
  kind?: 'text' | 'image';
  size?: number;
} = {}) {
  return <UiLucideIcon component={kind === 'image' ? Image : FileText} size={size} />;
}

export function UiCheckIcon({ size = 11 }: { size?: number } = {}) {
  return <UiLucideIcon component={Check} size={size} />;
}

export function UiArrowRightIcon() {
  return <UiLucideIcon component={ArrowRight} size={12} />;
}

export function UiChevronDownIcon({
  open = false,
  size = 12,
  className = ''
}: {
  open?: boolean;
  size?: number;
  className?: string;
} = {}) {
  return (
    <UiLucideIcon
      component={ChevronDown}
      size={size}
      className={[className, open && className ? `${className}--open` : '']
        .filter(Boolean)
        .join(' ')}
    />
  );
}
