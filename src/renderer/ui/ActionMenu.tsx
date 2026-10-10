import { useId, type ReactNode } from 'react';
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
  onSelect(): void;
}

/** shadcn's Radix menu foundation, styled with Task Monki's shared tokens. */
export function ActionMenu({ className = 'tm-action-menu', selection = 'multiple', align = 'end', disabled, label, trigger, items, open, closeOnSelect = true, onOpenChange }: {
  className?: string;
  selection?: 'single' | 'multiple';
  align?: 'start' | 'end';
  disabled?: boolean;
  label: string;
  trigger: ReactNode;
  items: ActionMenuItem[];
  open?: boolean;
  closeOnSelect?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const id = useId();
  const selected = items.find((item) => item.pressed);
  const selectedValue = selected?.id ?? selected?.label;
  const renderItem = (item: ActionMenuItem, index: number) => {
    const description = item.disabled ? item.disabledReason ?? item.description : item.description;
    const copy = <>
      <span className="tm-action-menu__copy"><span>{item.label}</span>
        {description ? <small id={`${id}-${index}`}>{description}</small> : null}
      </span>
      {item.pressed !== undefined ? <span className="tm-action-menu__check" aria-hidden="true">{item.pressed ? <Check size={14} strokeWidth={1.5} /> : null}</span> : null}
    </>;
    const props = {
      className: `tm-action-menu__item${item.danger ? ' tm-action-menu__danger' : ''}`,
      disabled: item.disabled,
      'aria-label': item.label,
      'aria-describedby': description ? `${id}-${index}` : undefined,
      textValue: item.label,
      onSelect: (event: Event) => {
        if (!closeOnSelect) event.preventDefault();
        item.onSelect();
      }
    };
    return item.pressed === undefined ? <DropdownMenu.Item key={item.id ?? item.label} {...props}>{copy}</DropdownMenu.Item>
      : selection === 'single' ? <DropdownMenu.RadioItem key={item.id ?? item.label} value={item.id ?? item.label} {...props}>{copy}</DropdownMenu.RadioItem>
      : <DropdownMenu.CheckboxItem key={item.id ?? item.label} checked={item.pressed} {...props}>{copy}</DropdownMenu.CheckboxItem>;
  };
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <div className={className}>
      <DropdownMenu.Trigger asChild><button type="button" className={`tm-action-menu__trigger ${className}__trigger`} title={label} aria-label={label} disabled={disabled}>{trigger}</button></DropdownMenu.Trigger>
    </div>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="tm-action-menu__popover" aria-label={label} side="top" align={align} sideOffset={6} collisionPadding={8}>
        {selection === 'single' ? <DropdownMenu.RadioGroup value={selectedValue}>{items.map(renderItem)}</DropdownMenu.RadioGroup> : items.map(renderItem)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
