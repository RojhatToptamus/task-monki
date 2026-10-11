import type { ReactNode } from 'react';

/** One Settings section: a heading, an optional action on its line, then rows or a table. */
export function SettingsPane({
  id,
  title,
  detail,
  action,
  children
}: {
  id: string;
  title: string;
  /** One line, only when it changes what the user does here. */
  detail?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`settings-panel-${id}`} className="tm-settings__pane" aria-labelledby={`settings-heading-${id}`}>
      <header className="tm-settings__pane-head">
        <div>
          <h2 id={`settings-heading-${id}`}>{title}</h2>
          {detail ? <p>{detail}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** One setting: its name and an optional line under it on the left, the control on the right. */
export function SettingsRow({ label, description, children }: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="tm-settings__row">
      <div className="tm-settings__label">
        <span className="tm-settings__k">{label}</span>
        {description ? <span className="tm-settings__description">{description}</span> : null}
      </div>
      {children}
    </div>
  );
}
