import { describe, expect, it } from 'vitest';
import {
  isPreviewRouteHostname,
  previewRouteHostname
} from './PreviewRouteHostname';

describe('PreviewRouteHostname', () => {
  it('creates one stable bounded label from the task and route identities', () => {
    const hostname = previewRouteHostname('task-a', 'app');

    expect(hostname).toBe('tm-c56924243da73fb3ca189a97b3ea51d3.localhost');
    expect(hostname.split('.')).toHaveLength(2);
    expect(hostname.split('.')[0].length).toBeLessThanOrEqual(63);
    expect(isPreviewRouteHostname(hostname)).toBe(true);
  });

  it('keeps replacement identity stable and separates every task-route pair', () => {
    const first = previewRouteHostname('task-a', 'app');

    expect(previewRouteHostname('task-a', 'app')).toBe(first);
    expect(previewRouteHostname('task-a', 'api')).not.toBe(first);
    expect(previewRouteHostname('task-b', 'app')).not.toBe(first);
    expect(previewRouteHostname('task-ab', 'c')).not.toBe(
      previewRouteHostname('task-a', 'bc')
    );
  });

  it('does not put long or repository-controlled identities into DNS labels', () => {
    const hostname = previewRouteHostname('t'.repeat(512), 'r'.repeat(512));

    expect(hostname).toMatch(/^tm-[0-9a-f]{32}\.localhost$/);
    expect(hostname.split('.')[0].length).toBe(35);
  });

  it('rejects invalid identity inputs and malformed or foreign hostnames', () => {
    expect(() => previewRouteHostname('', 'app')).toThrow('Preview task identity is invalid.');
    expect(() => previewRouteHostname('task-a', '')).toThrow('Preview route identity is invalid.');
    expect(() => previewRouteHostname('task-a\nforeign', 'app')).toThrow(
      'Preview task identity is invalid.'
    );
    expect(() => previewRouteHostname('t'.repeat(513), 'app')).toThrow(
      'Preview task identity is invalid.'
    );

    for (const hostname of [
      'tm-deadbeef.localhost',
      'tm-c56924243da73fb3ca189a97b3ea51d3.example.com',
      'app.task-a.preview.localhost',
      'other.localhost',
      'TM-C56924243DA73FB3CA189A97B3EA51D3.localhost',
      'tm-c56924243da73fb3ca189a97b3ea51d3.localhost.',
      'tm-c56924243da73fb3ca189a97b3ea51d3.localhost:31337'
    ]) {
      expect(isPreviewRouteHostname(hostname), hostname).toBe(false);
    }
  });
});
