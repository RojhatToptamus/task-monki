import { useId } from 'react';

export function DesignNetworkAccess({
  value,
  policy,
  runtimeId,
  disabled,
  onChange
}: {
  value: boolean;
  policy: 'DISABLED' | 'OPTIONAL' | 'REQUIRED' | undefined;
  runtimeId: string;
  disabled: boolean;
  onChange(value: boolean): void;
}) {
  const id = useId();
  return (
    <div className="network-toggle">
      <div className="network-toggle__copy">
        <span className="network-toggle__title" id={`${id}-label`}>
          Command network
        </span>
        <span className="network-toggle__state" id={`${id}-help`}>
          {policy === 'REQUIRED'
            ? 'Required by this agent.'
            : policy !== 'OPTIONAL'
              ? 'Unavailable for this agent.'
              : value
                ? 'On for commands in this update.'
                : 'Off for sandboxed commands in this update.'}
          {runtimeId === 'codex'
            ? ' Web search is separate. Saved Codex command rules can grant exceptions.'
            : ''}
        </span>
      </div>
      <button
        type="button"
        className={`network-toggle__switch ${value ? 'network-toggle__switch--on' : ''}`}
        role="switch"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        aria-checked={value}
        disabled={disabled || policy !== 'OPTIONAL'}
        onClick={() => onChange(!value)}
      >
        <span />
      </button>
    </div>
  );
}
