import { Fragment, useId, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';

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
  /** Starts a new group: a separator is drawn before this item. */
  separated?: boolean;
  onSelect(): void;
}

/** shadcn's Radix menu foundation, styled with Task Monki's shared tokens. */
export function ActionMenu({ className = 'tm-action-menu', selection = 'multiple', align = 'end', side = 'top', disabled, label, trigger, items, note, open, closeOnSelect = true, onOpenChange }: {
  className?: string;
  selection?: 'single' | 'multiple';
  align?: 'start' | 'end';
  /** Preferred side; Radix flips it when the window has no room. */
  side?: 'top' | 'bottom';
  disabled?: boolean;
  label: string;
  trigger: ReactNode;
  items: ActionMenuItem[];
  /** One muted line after the items that explains a limit shared by several of them. */
  note?: string;
  open?: boolean;
  closeOnSelect?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const id = useId();
  const selected = items.find((item) => item.pressed);
  const selectedValue = selected?.id ?? selected?.label;
  const renderItem = (item: ActionMenuItem, index: number) => {
    const description = item.disabled ? item.disabledReason ?? item.description : item.description;
    const describedBy = [item.meta ? `${id}-${index}-meta` : '', description ? `${id}-${index}` : ''].filter(Boolean).join(' ');
    const copy = <>
      <span className="tm-action-menu__copy">
        {item.meta ? <span className="tm-action-menu__line"><span>{item.label}</span>
          <span className="tm-action-menu__meta" id={`${id}-${index}-meta`} data-tone={item.metaTone}>{item.meta}</span></span> : <span>{item.label}</span>}
        {description ? <small id={`${id}-${index}`}>{description}</small> : null}
      </span>
      {item.pressed !== undefined ? <span className="tm-action-menu__check" aria-hidden="true">{item.pressed ? <Check size={14} strokeWidth={1.5} /> : null}</span> : null}
    </>;
    const props = {
      className: `tm-action-menu__item${item.danger ? ' tm-action-menu__danger' : ''}`,
      disabled: item.disabled,
      'aria-label': item.label,
      'aria-describedby': describedBy || undefined,
      textValue: item.label,
      onSelect: (event: Event) => {
        if (!closeOnSelect) event.preventDefault();
        item.onSelect();
      }
    };
    const element = item.pressed === undefined ? <DropdownMenu.Item {...props}>{copy}</DropdownMenu.Item>
      : selection === 'single' ? <DropdownMenu.RadioItem value={item.id ?? item.label} {...props}>{copy}</DropdownMenu.RadioItem>
      : <DropdownMenu.CheckboxItem checked={item.pressed} {...props}>{copy}</DropdownMenu.CheckboxItem>;
    return <Fragment key={item.id ?? item.label}>
      {item.separated && index > 0 ? <DropdownMenu.Separator className="tm-action-menu__separator" /> : null}
      {element}
    </Fragment>;
  };
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <div className={className}>
      <DropdownMenu.Trigger asChild><button type="button" className={`tm-action-menu__trigger ${className}__trigger`} title={label} aria-label={label} disabled={disabled}>{trigger}</button></DropdownMenu.Trigger>
    </div>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="tm-action-menu__popover" aria-label={label} aria-describedby={note ? `${id}-note` : undefined} side={side} align={align} sideOffset={6} collisionPadding={8}>
        {selection === 'single' ? <DropdownMenu.RadioGroup value={selectedValue}>{items.map(renderItem)}</DropdownMenu.RadioGroup> : items.map(renderItem)}
        {note ? <><DropdownMenu.Separator className="tm-action-menu__separator" /><p className="tm-action-menu__note" id={`${id}-note`}>{note}</p></> : null}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
