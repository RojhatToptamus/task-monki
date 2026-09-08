import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentProfilesSettings } from './AgentProfilesSettings';

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

});
