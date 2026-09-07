import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentProfilesSettings } from './AgentProfilesSettings';
import { AgentProfileSelect } from './AgentProfileSelect';

describe('Agent profile editing and assignment', () => {
  it('keeps unsaved instructions after a failed save and submits their exact text on retry', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Name already exists.'))
      .mockResolvedValueOnce(undefined);
    render(
      <AgentProfilesSettings
        profiles={[]}
        onSaveAgentProfile={save}
        onDeleteAgentProfile={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'New profile' }));
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'Testing' } });
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toContain(
      'Trace the behavior'
    );
    const instructions = '  Inspect the actual request.\n\nKeep this spacing.\n';
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: instructions } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('Name already exists.');
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe(instructions);
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(screen.queryByLabelText('Instructions')).toBeNull());
    expect(save.mock.calls[1]?.[0]).toMatchObject({ name: 'Testing', instructions });
  });

  it('shows the assigned copy after library deletion and requires an explicit choice to replace it', () => {
    const saved = {
      id: 'b6d8c40c-e1d5-43b1-84bd-7e45f2260f80',
      name: 'Protocol',
      description: '',
      instructions: '<script>untrusted text</script>\nOriginal guidance.'
    };
    const onChange = vi.fn();
    const view = render(
      <AgentProfileSelect profiles={[]} savedProfile={saved} onChange={onChange} />
    );
    expect(
      (screen.getByRole('combobox') as HTMLSelectElement).selectedOptions[0]?.textContent
    ).toBe('Protocol · saved');
    expect(screen.getByText(/Original guidance/).textContent).toBe(saved.instructions);
    expect(view.container.querySelector('script')).toBeNull();
    view.rerender(
      <AgentProfileSelect
        profiles={[{ ...saved, instructions: 'New library guidance.' }]}
        savedProfile={saved}
        onChange={onChange}
      />
    );
    expect(screen.queryByText('New library guidance.')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: saved.id } });
    expect(onChange).toHaveBeenLastCalledWith(saved.id);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
