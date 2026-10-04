import { Pencil, Play, X } from 'lucide-react';

interface QueuedMessage {
  id: string;
  text: string;
  detail?: string;
  held?: boolean;
}

export function MessageQueue({ items, editingId, disabled = false, continueDisabledReason, onContinue, onEdit, onRemove }: {
  items: QueuedMessage[];
  editingId?: string;
  disabled?: boolean;
  continueDisabledReason?: string;
  onContinue?(id: string): void;
  onEdit?(id: string): void;
  onRemove(id: string): void;
}) {
  if (!items.length) return null;
  const held = items.filter((item) => item.held).length;
  const queued = items.length - held;
  return <div className="tm-queue">
    <div className="tm-queue__head">
      <span className="tm-queue__title">{items.length} {held ? 'pending' : 'queued'}</span>
      <span className="tm-queue__hint">{held
        ? queued ? `${queued} queued · ${held} paused` : 'Paused · continue when ready'
        : 'Sends after this response'}</span>
    </div>
    <ol aria-label="Pending instructions">{items.map((item, index) => <li key={item.id} className="tm-queue__item" aria-current={editingId === item.id ? true : undefined}>
      <span className="tm-queue__order" aria-hidden="true">{index + 1}</span>
      <span className="tm-queue__message">
        <span className="tm-queue__text" title={item.text}>{item.text}</span>
        {item.detail ? <span className="tm-queue__hint tm-queue__text" title={item.detail}>{item.detail}</span> : null}
      </span>
      {held > 0 && queued > 0 && item.held ? <span className="tm-queue__hint">Paused</span> : null}
      {item.held && onContinue ? <button type="button" className="tm-iconbtn" aria-label={`Continue instruction ${index + 1}`}
        disabled={disabled || Boolean(continueDisabledReason)} title={continueDisabledReason ?? 'Continue with this instruction'} onClick={() => onContinue(item.id)}>
        <Play size={16} strokeWidth={1.5} aria-hidden="true" />
      </button> : null}
      {onEdit ? <button type="button" className="tm-iconbtn" aria-label={`Edit instruction ${index + 1}`} title="Edit instruction" disabled={disabled} onClick={() => onEdit(item.id)}>
        <Pencil size={16} strokeWidth={1.5} aria-hidden="true" />
      </button> : null}
      <button type="button" className="tm-iconbtn" aria-label={`Remove instruction ${index + 1}`} title="Remove instruction" disabled={disabled} onClick={() => onRemove(item.id)}>
        <X size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </li>)}</ol>
  </div>;
}
