import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import { ExecutionPolicySelect } from './NewTaskPanel';

const executionPolicy = codexCapabilities().executionPolicy;

function ControlledPolicySelect({ attachmentsIncluded = false }: { attachmentsIncluded?: boolean }) {
  const [presetId, setPresetId] = useState(executionPolicy.defaultPresetId);
  return (
    <ExecutionPolicySelect
      presets={executionPolicy.presets}
      selectedPreset={executionPolicy.presets.find((preset) => preset.id === presetId)}
      attachmentsIncluded={attachmentsIncluded}
      disabled={false}
      onChange={setPresetId}
    />
  );
}

describe('New task execution policy menu', () => {
  it('opens as one explanatory menu and selects a policy', () => {
    render(<ControlledPolicySelect />);

    const trigger = screen.getByRole('button', { name: 'Execution policy: Restricted' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Execution policy' });
    const approvalOption = within(menu).getByRole('menuitemradio', {
      name: /Ask for approval/
    });
    expect(approvalOption.textContent).toContain('Ask for approval');
    expect(approvalOption.textContent).toContain('approval');

    fireEvent.click(approvalOption);
    expect(screen.queryByRole('menu', { name: 'Execution policy' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Execution policy: Ask for approval' })
        .getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('keeps full access unavailable while attachments are included', () => {
    render(<ControlledPolicySelect attachmentsIncluded />);
    fireEvent.click(screen.getByRole('button', { name: 'Execution policy: Restricted' }));

    const fullAccess = screen.getByRole('menuitemradio', { name: /Full access/ });
    expect((fullAccess as HTMLButtonElement).disabled).toBe(true);
    expect(fullAccess.getAttribute('title')).toBe('Remove attachments to use full access.');
  });

  it('closes when focus leaves the control', () => {
    render(
      <>
        <ControlledPolicySelect />
        <button type="button">Outside</button>
      </>
    );
    const trigger = screen.getByRole('button', { name: 'Execution policy: Restricted' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Execution policy' })).toBeTruthy();

    fireEvent.blur(trigger, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
    expect(screen.queryByRole('menu', { name: 'Execution policy' })).toBeNull();
  });
});
