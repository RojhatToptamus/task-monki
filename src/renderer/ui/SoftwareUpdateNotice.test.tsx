import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';
import { SoftwareUpdateNotice, buildSoftwareUpdateNotice } from './SoftwareUpdateNotice';

const baseState: SoftwareUpdateState = {
  status: 'idle',
  currentVersion: '0.2.0',
  availableVersion: null,
  lastCheckedAt: null,
  progress: null,
  errorMessage: null
};

describe('SoftwareUpdateNotice', () => {
  it('stays out of the sidebar until there is an actionable update', () => {
    expect(buildSoftwareUpdateNotice(baseState)).toBeNull();
    expect(buildSoftwareUpdateNotice({ ...baseState, status: 'error' })).toBeNull();
  });

  it('renders download progress as an accessible stable row', () => {
    const html = renderToStaticMarkup(
      <SoftwareUpdateNotice
        state={{
          ...baseState,
          status: 'downloading',
          availableVersion: '0.2.1',
          progress: { percent: 29.6, transferred: 296, total: 1_000, bytesPerSecond: 20 }
        }}
        collapsed={false}
        onDownload={() => undefined}
        onInstall={() => undefined}
      />
    );

    expect(html).toContain('Downloading 0.2.1');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).not.toContain('<button');
  });

  it('keeps the collapsed action labeled and marks attention with one dot', () => {
    const html = renderToStaticMarkup(
      <SoftwareUpdateNotice
        state={{ ...baseState, status: 'available', availableVersion: '0.2.1' }}
        collapsed
        onDownload={() => undefined}
        onInstall={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Update to 0.2.1"');
    expect(html).toContain('data-tip="Update to 0.2.1"');
    expect(html).toContain('tm-software-update__dot');
  });

  it('maps completed and failed downloads to the correct actions', () => {
    expect(
      buildSoftwareUpdateNotice({
        ...baseState,
        status: 'downloaded',
        availableVersion: '0.2.1'
      })
    ).toMatchObject({ tone: 'ready', label: 'Restart to update', action: 'install' });
    expect(
      buildSoftwareUpdateNotice({
        ...baseState,
        status: 'error',
        availableVersion: '0.2.1',
        errorMessage: 'Could not download the update.'
      })
    ).toMatchObject({ tone: 'failed', label: 'Update failed', action: 'download' });
  });
});
