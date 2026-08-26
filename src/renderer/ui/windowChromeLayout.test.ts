import { describe, expect, it } from 'vitest';
import { TITLEBAR_HEIGHT } from '../../electron/windowChrome';
import { readRendererStyles } from '../../testSupport/rendererStyles';

describe('window chrome layout styles', () => {
  it('keeps renderer chrome aligned with the native titlebar height', async () => {
    const css = await readRendererStyles();

    for (const selector of ['tm-titlebar', 'slideover__header']) {
      const body = css.match(
        new RegExp(`\\.${selector}\\s*\\{(?<body>[^}]*)\\}`)
      )?.groups?.body;
      expect(body).toContain(`height: ${TITLEBAR_HEIGHT}px`);
    }
  });
});
