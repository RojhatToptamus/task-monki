import { X } from 'lucide-react';
import type { BugCaptureCheckTemplate } from '../../../shared/bugReplay';
import { CHECK_TEMPLATE_OPTIONS, REQUEST_CHECK_OPTIONS } from '../../model/bugReplay';
import { Tooltip } from '../Tooltip';

/**
 * An expectation's row, as the capture panel and the expectations editor both list them: what it
 * reads and Remove, what the recording showed, then what it should be. Rows sit in a
 * `tm-bugexpect__list`, divided by hairlines.
 */

export interface ElementExpectationValue {
  template: BugCaptureCheckTemplate;
  expected?: string;
  count?: number;
  alsoAfterReload: boolean;
}

/** An element on the page: what it should read, contain or do, and whether that holds after reload. */
export function ElementExpectation({
  badge,
  name,
  shown,
  value,
  disabled,
  arrived = false,
  valueRef,
  onChange,
  onRemove
}: {
  /** The number of its outline on the page, when the page shows one. */
  badge?: number;
  name: string;
  /** What it showed when the bug was recorded. */
  shown?: string;
  value: ElementExpectationValue;
  disabled: boolean;
  arrived?: boolean;
  /** The text a person types over: what it should read or contain. */
  valueRef?: (element: HTMLInputElement | null) => void;
  onChange(next: ElementExpectationValue): void;
  onRemove(): void;
}) {
  const textual = value.template === 'equals' || value.template === 'contains';
  return (
    <li className="tm-bugexpect__row" data-arrived={arrived ? '' : undefined}>
      <div className="tm-bugexpect__line">
        {badge !== undefined ? <span className="tm-bugexpect__badge" aria-hidden="true">{badge}</span> : null}
        <span className="tm-bugexpect__name" title={name}>{name}</span>
        <RemoveButton label={`Remove the expectation on ${name}`} disabled={disabled} onRemove={onRemove} />
      </div>
      {shown ? <p className="tm-bugexpect__was" title={shown}>{shown}</p> : null}
      <div className="tm-bugexpect__controls">
        <select className="tm-bugcontrol" aria-label={`Expectation on ${name}`} value={value.template} disabled={disabled}
          onChange={(event) => onChange({ ...value, template: event.target.value as BugCaptureCheckTemplate })}>
          {CHECK_TEMPLATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {textual ? (
          <input
            ref={valueRef}
            className="tm-bugcontrol"
            aria-label={`What ${name} should ${value.template === 'equals' ? 'read' : 'contain'}`}
            value={value.expected ?? ''}
            maxLength={1000}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, expected: event.target.value })} />
        ) : value.template === 'count' ? (
          <input className="tm-bugcontrol tm-bugcontrol--count" aria-label={`How many times ${name} should appear`} type="number" min={0} max={1000}
            value={value.count ?? 1} disabled={disabled}
            onChange={(event) => onChange({ ...value, count: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) })} />
        ) : null}
      </div>
      <label className="tm-bugcheck__option">
        <input type="checkbox" checked={value.alsoAfterReload} disabled={disabled}
          onChange={(event) => onChange({ ...value, alsoAfterReload: event.target.checked })} />
        <span>Also after reload</span>
      </label>
    </li>
  );
}

/** A request the marked action sent: the status it should get, and whether it should be sent once. */
export function RequestExpectation({
  name,
  title,
  observed,
  failed,
  check,
  anyStatus = true,
  sentOnce,
  disabled,
  arrived = false,
  onCheck,
  onSentOnce,
  onRemove
}: {
  /** "POST /api/orders". */
  name: string;
  title?: string;
  /** What the recording got: "Returned 500", "Got no response", "Returned 200 ×2". */
  observed?: string;
  /** The recording got something other than success: its line takes the error ink. */
  failed: boolean;
  /** The status it should get; none is Any status. Without one there is nothing to choose. */
  check?: 'success' | 'answered' | 'none';
  /** Any status can be chosen: nothing else reads the request's answer. */
  anyStatus?: boolean;
  /** Sent once, where it applies. */
  sentOnce?: boolean;
  disabled: boolean;
  arrived?: boolean;
  onCheck(check: 'success' | 'answered' | 'none'): void;
  onSentOnce(sentOnce: boolean): void;
  onRemove(): void;
}) {
  return (
    <li className="tm-bugexpect__row" data-arrived={arrived ? '' : undefined}>
      <div className="tm-bugexpect__line">
        <code className="tm-bugexpect__request" title={title ?? name}>{name}</code>
        <RemoveButton label={`Remove the expectations on ${name}`} disabled={disabled} onRemove={onRemove} />
      </div>
      {observed ? <p className="tm-bugexpect__was" data-tone={failed ? 'error' : undefined}>{observed}</p> : null}
      <div className="tm-bugexpect__controls">
        {check !== undefined ? (
          <select className="tm-bugcontrol" aria-label={`Expectation on ${name}`} value={check} disabled={disabled}
            onChange={(event) => onCheck(event.target.value as 'success' | 'answered' | 'none')}>
            {REQUEST_CHECK_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            {anyStatus || check === 'none' ? <option value="none">Any status</option> : null}
          </select>
        ) : null}
        {sentOnce !== undefined ? (
          <label className="tm-bugcheck__option">
            <input type="checkbox" checked={sentOnce} disabled={disabled} onChange={(event) => onSentOnce(event.target.checked)} />
            <span>Sent once</span>
          </label>
        ) : null}
      </div>
    </li>
  );
}

/** A JSON value a request sent or got back: what it should be. */
export function ValueExpectation({
  name,
  was,
  expected,
  disabled,
  arrived = false,
  onExpected,
  onRemove
}: {
  /** "POST /api/cart returns total". */
  name: string;
  /** "Was 40". */
  was?: string;
  expected: string;
  disabled: boolean;
  arrived?: boolean;
  onExpected(expected: string): void;
  onRemove(): void;
}) {
  return (
    <li className="tm-bugexpect__row" data-arrived={arrived ? '' : undefined}>
      <div className="tm-bugexpect__line">
        <code className="tm-bugexpect__request" title={name}>{name}</code>
        <RemoveButton label={`Remove the expectation on ${name}`} disabled={disabled} onRemove={onRemove} />
      </div>
      {was ? <p className="tm-bugexpect__was">{was}</p> : null}
      <div className="tm-bugexpect__controls tm-bugexpect__controls--value">
        <span className="tm-bugexpect__verb">Should be</span>
        <input aria-label={`Expected value of ${name}`} className="tm-bugcontrol tm-bugcontrol--mono" value={expected} maxLength={2000} disabled={disabled}
          onChange={(event) => onExpected(event.target.value)} />
      </div>
    </li>
  );
}

/** A fixed expectation that is kept or removed: No page error, or a check with no control. */
export function FixedExpectation({
  name,
  was,
  removeLabel,
  disabled,
  arrived = false,
  onRemove
}: {
  name: string;
  was?: string;
  removeLabel: string;
  disabled: boolean;
  arrived?: boolean;
  onRemove(): void;
}) {
  return (
    <li className="tm-bugexpect__row" data-arrived={arrived ? '' : undefined}>
      <div className="tm-bugexpect__line">
        <span className="tm-bugexpect__name" title={name}>{name}</span>
        <RemoveButton label={removeLabel} disabled={disabled} onRemove={onRemove} />
      </div>
      {was ? <p className="tm-bugexpect__was">{was}</p> : null}
    </li>
  );
}

/**
 * Removes its row. Focus stays where the person works: on Remove of the row that takes this one's
 * place or of the row before, and once no row is left on the surface's first control.
 */
function RemoveButton({ label, disabled, onRemove }: { label: string; disabled: boolean; onRemove(): void }) {
  return (
    <Tooltip label="Remove">
      <button type="button" className="tm-iconbtn tm-bugexpect__remove" aria-label={label} disabled={disabled}
        onClick={(event) => {
          const button = event.currentTarget;
          const row = button.closest('.tm-bugexpect__row');
          const surface = button.closest<HTMLElement>('[role="dialog"], .tm-bugcapture');
          const hadFocus = document.activeElement === button;
          // The row that takes this one's place, or the one before it, outlives the removal.
          const neighbour = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLElement>('.tm-bugexpect__remove');
          onRemove();
          if (!hadFocus) return;
          neighbour?.focus({ preventScroll: true });
          // A removal can take the neighbour too (a request takes its values): then the first row
          // left, or with none left the surface's first control (Add expectation, or Cancel).
          requestAnimationFrame(() => {
            const active = document.activeElement;
            if (active && active !== document.body && active.isConnected) return;
            const next = surface?.querySelector<HTMLElement>('.tm-bugexpect__remove:not(:disabled)')
              ?? surface?.querySelector<HTMLElement>('button:not(:disabled)');
            (next ?? surface)?.focus({ preventScroll: true });
          });
        }}>
        <X size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
