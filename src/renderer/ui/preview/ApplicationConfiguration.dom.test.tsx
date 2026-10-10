import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { formatCommand, parseCommand } from '../../model/previewConfigurationModel';
import { ApplicationConfiguration, type ConfigurationView } from './ApplicationConfiguration';
import { commandText } from './previewPresentation';

const file = `# Fixture
name: fixture
type: environment
primary: web
services:
  install:
    type: job
    cwd: .
    command: [npm, ci]
  web:
    type: command
    cwd: .
    dependsOn: [install]
    command: [npm, start]
    env:
      API_URL: {service: api}   # same-origin in production
  api:
    type: command
    cwd: ../backend
    command: [node, api.js]
`;

/** The panel's ownership of the draft text, reduced to what the configuration view needs. */
function Harness({ onText }: { onText?(text: string): void }) {
  const [text, setText] = useState(file);
  const [view, setView] = useState<ConfigurationView>('Configuration');
  return (
    <ApplicationConfiguration
      draft={{ original: { name: 'preview.yaml', text: file }, text }}
      view={view}
      onView={setView}
      onChange={(next) => {
        setText(next);
        onText?.(next);
      }}
      onSave={() => undefined}
      busy={false}
    />
  );
}

describe('ApplicationConfiguration', () => {
  it('writes a new variable when its name is left and keeps focus in the row the person is filling in', () => {
    let text = file;
    render(<Harness onText={(next) => (text = next)} />);
    fireEvent.click(screen.getByRole('button', { name: /^web/, expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    const name = screen.getByRole('textbox', { name: 'New variable name' });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: 'API_URL' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('API_URL is already set.');
    expect(text).toBe(file);
    fireEvent.change(name, { target: { value: 'TOKEN' } });
    const kind = screen.getByRole('combobox', { name: 'New variable kind' });
    act(() => kind.focus()); // Tab: the name field blurs and commits
    expect(parse(text).services.web.env).toEqual({ API_URL: { service: 'api' }, TOKEN: '' });
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'TOKEN kind' }));
    fireEvent.change(document.activeElement!, { target: { value: 'secret' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'TOKEN secret reference' }), { target: { value: 'fixture/dev/token' } });
    expect(parse(text).services.web.env.TOKEN).toEqual({ secret: 'fixture/dev/token' });
    expect(text).toContain('API_URL: {service: api}   # same-origin in production');
    expect(screen.getByRole('region', { name: 'Secrets' }).textContent).toContain('fixture/dev/token');
  });

  it('chooses dependencies in a menu that stays open, and Escape closes the menu before the editor', async () => {
    let text = file;
    render(<Harness onText={(next) => (text = next)} />);
    const row = screen.getByRole('button', { name: /^web/, expanded: false });
    fireEvent.click(row);
    const trigger = screen.getByRole('button', { name: 'Starts after: install' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'api' }));
    expect(parse(text).services.web.dependsOn).toEqual(['install', 'api']);
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'web' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Command' }), { key: 'Escape' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(row);
  });

  it('offers Once only to a step that waits for a managed database, and says why', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^install/ }));
    const once = screen.getByRole('button', { name: 'Once' }) as HTMLButtonElement;
    expect(once.disabled).toBe(true);
    expect(document.getElementById(once.getAttribute('aria-describedby')!)?.textContent).toContain('managed database');
  });

  it('switches between the structure, the source and the changes with pressed toggles', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^web/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove API_URL' }));
    const changes = screen.getByRole('button', { name: 'Changes' });
    fireEvent.click(changes);
    expect(changes.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Configuration changes').textContent).toContain('API_URL');
    fireEvent.click(changes);
    expect(screen.getByRole('region', { name: 'Services' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }));
    expect((screen.getByRole('textbox', { name: 'Preview YAML' }) as HTMLTextAreaElement).value).not.toContain('API_URL');
  });

  it('reads back the command line the rows display, so the editor and the summary never disagree', () => {
    for (const command of [['npm', 'run', 'dev'], ['node', '-e', 'console.log("a b")', '--port={port}'], ['sh', 'with space/run.sh', 'tab\there']]) {
      expect(parseCommand(commandText(command))).toEqual({ command });
      expect(formatCommand(command)).toBe(commandText(command));
    }
  });
});
