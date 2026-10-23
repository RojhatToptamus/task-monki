import { Fragment, useEffect, useId, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { Tooltip } from './Tooltip';

export interface ActionMenuItem {
  id?: string;
  label: string;
  description?: string;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  pressed?: boolean;
  /** A short value on the label's line, right-aligned and muted, such as a state word. */
  meta?: string;
  metaTone?: 'blocked';
  /** A short muted value before the label, such as a step's number. */
  lead?: string;
  /** Where the person is now, such as the stage being read: it takes the selected plane. */
  current?: boolean;
  /** Starts a new group: a separator is drawn before this item. */
  separated?: boolean;
  /** A submenu ("Open with"): the item opens these instead of acting. */
  items?: ActionMenuItem[];
  onSelect?(): void;
}

interface MenuBodyOptions {
  id: string;
  selection: 'single' | 'multiple';
  closeOnSelect: boolean;
}

/** Items, groups and submenus, shared by the button menu and the context menu. */
function MenuItems({ items, options }: { items: ActionMenuItem[]; options: MenuBodyOptions }) {
  const { id, selection, closeOnSelect } = options;
  const selected = items.find((item) => item.pressed);
  const selectedValue = selected?.id ?? selected?.label;
  const renderItem = (item: ActionMenuItem, index: number) => {
    const key = `${id}-${index}`;
    const description = item.disabled ? item.disabledReason ?? item.description : item.description;
    const describedBy = [item.meta ? `${key}-meta` : '', description ? key : ''].filter(Boolean).join(' ');
    const copy = <span className="tm-action-menu__copy">
      {item.meta ? <span className="tm-action-menu__line"><span>{item.label}</span>
        <span className="tm-action-menu__meta" id={`${key}-meta`} data-tone={item.metaTone}>{item.meta}</span></span> : <span>{item.label}</span>}
      {description ? <small id={key}>{description}</small> : null}
    </span>;
    const separator = item.separated && index > 0 ? <DropdownMenu.Separator className="tm-action-menu__separator" /> : null;
    if (item.items) {
      return <Fragment key={item.id ?? item.label}>
        {separator}
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger className="tm-action-menu__item tm-action-menu__subtrigger" disabled={item.disabled}
            aria-describedby={describedBy || undefined} textValue={item.label}>
            {copy}
            <ChevronRight className="tm-action-menu__subchevron" size={13} aria-hidden="true" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent className="tm-action-menu__popover tm-action-menu__popover--sub" sideOffset={4} alignOffset={-4} collisionPadding={8}>
              <MenuItems items={item.items} options={{ ...options, id: key }} />
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      </Fragment>;
    }
    const props = {
      className: `tm-action-menu__item${item.danger ? ' tm-action-menu__danger' : ''}`,
      disabled: item.disabled,
      'aria-label': item.label,
      'aria-describedby': describedBy || undefined,
      'aria-current': item.current ? true : undefined,
      textValue: item.label,
      onSelect: (event: Event) => {
        if (!closeOnSelect) event.preventDefault();
        item.onSelect?.();
      }
    };
    const content = <>
      {item.lead !== undefined ? <span className="tm-action-menu__lead" aria-hidden="true">{item.lead}</span> : null}
      {copy}
      {item.pressed !== undefined ? <span className="tm-action-menu__check" aria-hidden="true">{item.pressed ? <Check size={13} /> : null}</span> : null}
    </>;
    const element = item.pressed === undefined ? <DropdownMenu.Item {...props}>{content}</DropdownMenu.Item>
      : selection === 'single' ? <DropdownMenu.RadioItem value={item.id ?? item.label} {...props}>{content}</DropdownMenu.RadioItem>
      : <DropdownMenu.CheckboxItem checked={item.pressed} {...props}>{content}</DropdownMenu.CheckboxItem>;
    return <Fragment key={item.id ?? item.label}>{separator}{element}</Fragment>;
  };
  return selection === 'single'
    ? <DropdownMenu.RadioGroup value={selectedValue}>{items.map(renderItem)}</DropdownMenu.RadioGroup>
    : <>{items.map(renderItem)}</>;
}

function MenuNote({ id, note }: { id: string; note: string }) {
  return <>
    <DropdownMenu.Separator className="tm-action-menu__separator" />
    <p className="tm-action-menu__note" id={`${id}-note`}>{note}</p>
  </>;
}

/** shadcn's Radix menu foundation, styled with Task Monki's shared tokens. */
export function ActionMenu({ className = 'tm-action-menu', selection = 'multiple', align = 'end', side = 'top', wide = false, disabled, label, tooltip, trigger, items, note, open, closeOnSelect = true, onOpenChange }: {
  className?: string;
  selection?: 'single' | 'multiple';
  align?: 'start' | 'end';
  /** Preferred side; Radix flips it when the window has no room. */
  side?: 'top' | 'bottom';
  /** The widest menu, for labels such as titles that wrap to a second line rather than being cut. */
  wide?: boolean;
  disabled?: boolean;
  label: string;
  /** Names an icon-only trigger; a trigger that shows its value needs none. */
  tooltip?: string;
  trigger: ReactNode;
  items: ActionMenuItem[];
  /** One muted line after the items that explains a limit shared by several of them, or an error. */
  note?: string;
  open?: boolean;
  closeOnSelect?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const id = useId();
  const button = <DropdownMenu.Trigger asChild>
    <button type="button" className={`tm-action-menu__trigger ${className.split(' ')[0]}__trigger`} aria-label={label} disabled={disabled}>{trigger}</button>
  </DropdownMenu.Trigger>;
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <div className={className}>
      {tooltip ? <Tooltip label={tooltip}>{button}</Tooltip> : button}
    </div>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className={`tm-action-menu__popover${wide ? ' tm-action-menu__popover--wide' : ''}`} aria-label={label}
        aria-describedby={note ? `${id}-note` : undefined} side={side} align={align} sideOffset={6} collisionPadding={8}>
        <MenuItems items={items} options={{ id, selection, closeOnSelect }} />
        {note ? <MenuNote id={id} note={note} /> : null}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/**
 * The same menu opened at a point, for a right-click: an invisible anchor at the pointer
 * stands in for the trigger. Scrolling anything outside the menu closes it.
 */
export function ActionContextMenu({ label, position, items, onClose }: {
  label: string;
  position: { x: number; y: number };
  items: ActionMenuItem[];
  onClose(): void;
}) {
  const id = useId();
  useEffect(() => {
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('.tm-action-menu__popover'))) onClose();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return <DropdownMenu.Root modal={false} open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DropdownMenu.Trigger asChild>
      <span className="tm-action-menu__anchor" aria-hidden="true" style={{ left: position.x, top: position.y }} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="tm-action-menu__popover" aria-label={label} side="bottom" align="start" sideOffset={2} collisionPadding={8}>
        <MenuItems items={items} options={{ id, selection: 'multiple', closeOnSelect: true }} />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
