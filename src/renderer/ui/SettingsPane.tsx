import type { ReactNode } from 'react';

export function SettingsPane({
  id,
  title,
  detail,
  action,
  children
}: {
  id: string;
  title: string;
  detail: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={`settings-panel-${id}`}
      className="tm-settings__pane"
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
    >
      <header className="tm-settings__pane-head">
        <div>
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
