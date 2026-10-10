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
  it('stays off the rail until there is an actionable update', () => {
    expect(buildSoftwareUpdateNotice(baseState)).toBeNull();
    expect(buildSoftwareUpdateNotice({ ...baseState, status: 'error' })).toBeNull();
  });

  it('reports download progress accessibly without offering an action', () => {
    const html = renderToStaticMarkup(
      <SoftwareUpdateNotice
        state={{
          ...baseState,
          status: 'downloading',
          availableVersion: '0.2.1',
          progress: { percent: 29.6, transferred: 296, total: 1_000, bytesPerSecond: 20 }
        }}
        onDownload={() => undefined}
        onInstall={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Downloading 0.2.1, 30%"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).not.toContain('<button');
  });

  it('keeps the rail action labeled and marks attention with one dot', () => {
    const html = renderToStaticMarkup(
      <SoftwareUpdateNotice
        state={{ ...baseState, status: 'available', availableVersion: '0.2.1' }}
        onDownload={() => undefined}
        onInstall={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Update to 0.2.1"');
    expect(html).toContain('<button');
    expect(html).toContain('tm-rail__dot');
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
