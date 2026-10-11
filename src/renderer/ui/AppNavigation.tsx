import {
  ArrowLeft,
  ArrowRight,
  Columns3,
  Inbox,
  MessagesSquare,
  Monitor,
  Palette,
  PanelLeft,
  Plus,
  Settings2
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';
import { UiLucideIcon } from './UiIcons';

/**
 * One destination on the icon rail. The rail never expands, so the name lives
 * in the accessible label and in a tooltip. Something waiting on the user is a
 * dot at the icon's corner; how many is in the tooltip and on the page itself.
 */
export function RailItem({
  label,
  icon,
  count = 0,
  countNoun = 'task',
  active,
  onClick
}: {
  label: string;
  icon: ReactNode;
  /** Items waiting on the user. */
  count?: number;
  countNoun?: string;
  active: boolean;
  onClick(): void;
}) {
  const descriptionId = useId();
  const waiting = count > 0 ? `${count} ${countNoun}${count === 1 ? '' : 's'} waiting` : undefined;
  return (
    <Tooltip label={waiting ? `${label} · ${count > 99 ? '99+' : count} waiting` : label} side="right">
      <button
        type="button"
        className={`tm-rail__item${active ? ' tm-rail__item--active' : ''}`}
        onClick={onClick}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        aria-describedby={waiting ? descriptionId : undefined}
      >
        {icon}
        {waiting ? (
          <>
            <span className="tm-rail__dot" aria-hidden="true" />
            <span id={descriptionId} className="tm-visually-hidden">{waiting}</span>
          </>
        ) : null}
      </button>
    </Tooltip>
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
  return <UiLucideIcon component={Plus} size={13} />;
}

export function InboxIcon() {
  return <UiLucideIcon component={Inbox} />;
}

export function BoardIcon() {
  return <UiLucideIcon component={Columns3} />;
}

export function DesignIcon() {
  return <UiLucideIcon component={Palette} />;
}

export function PreviewIcon() {
  return <UiLucideIcon component={Monitor} />;
}

export function DiscourseIcon() {
  return <UiLucideIcon component={MessagesSquare} />;
}

export function SettingsIcon() {
  return <UiLucideIcon component={Settings2} />;
}
