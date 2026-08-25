import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowRight,
  Columns3,
  Folder,
  FolderOpen,
  Inbox,
  MessagesSquare,
  PanelLeft,
  PanelsTopLeft,
  Plus,
  Settings2,
  SquareCheckBig
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { UiLucideIcon } from './UiIcons';

export function NavItem({
  label,
  icon,
  count,
  countNoun = 'task',
  urgent,
  pillCount = false,
  overlapCount = false,
  active,
  collapsed,
  onClick
}: {
  label: string;
  icon: ReactNode;
  count?: number;
  countNoun?: string;
  urgent?: boolean;
  pillCount?: boolean;
  overlapCount?: boolean;
  active: boolean;
  collapsed?: boolean;
  onClick(): void;
}) {
  const descriptionId = useId();
  const countDescription =
    count != null && count > 0
      ? `${count} ${countNoun}${count === 1 ? '' : 's'}`
      : undefined;
  return (
    <button
      type="button"
      className={`tm-nav__item ${active ? 'tm-nav__item--active' : ''} ${overlapCount ? 'tm-nav__item--overlap-count' : ''}`}
      onClick={onClick}
      data-tip={collapsed ? label : undefined}
      aria-label={label}
      aria-describedby={countDescription ? descriptionId : undefined}
    >
      {icon}
      <span className="tm-nav__label">{label}</span>
      {count != null && count > 0 ? (
        <span
          className={`tm-nav__count ${urgent ? 'tm-nav__count--urgent' : ''} ${pillCount ? 'tm-nav__count--pill' : ''}`}
          aria-hidden="true"
        >
          {count}
        </span>
      ) : null}
      {countDescription ? (
        <span id={descriptionId} className="tm-visually-hidden">
          {countDescription}
        </span>
      ) : null}
    </button>
  );
}

export function PanelIcon() {
  return <UiLucideIcon component={PanelLeft} />;
}

export function ArrowLeftIcon() {
  return <UiLucideIcon component={ArrowLeft} />;
}

export function ArrowRightIcon() {
  return <UiLucideIcon component={ArrowRight} />;
}

export function PlusIcon() {
  return <UiLucideIcon component={Plus} size={14} />;
}

export function InboxIcon() {
  return <UiLucideIcon component={Inbox} />;
}

export function BoardIcon() {
  return <UiLucideIcon component={Columns3} />;
}

export function DesignIcon() {
  return <UiLucideIcon component={PanelsTopLeft} />;
}

export function DiscourseIcon() {
  return <UiLucideIcon component={MessagesSquare} />;
}

export function SavedViewsFolderIcon({ open }: { open: boolean }) {
  return <UiLucideIcon component={open ? FolderOpen : Folder} />;
}

export function ActiveIcon() {
  return <UiLucideIcon component={Activity} />;
}

export function ReviewIcon() {
  return <UiLucideIcon component={SquareCheckBig} />;
}

export function DoneIcon() {
  return <UiLucideIcon component={Archive} />;
}

export function SettingsIcon() {
  return <UiLucideIcon component={Settings2} />;
}
