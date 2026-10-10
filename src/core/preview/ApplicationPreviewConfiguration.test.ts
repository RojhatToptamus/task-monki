import { expect, it } from 'vitest';
import { parseConfigurationFile } from './ApplicationPreviewConfiguration';

it('rejects a file that breaks the Preview contract with Previewhost’s own reason, so the person can correct it', () => {
  const text = [
    'name: fixture',
    'type: environment',
    'primary: web',
    'services:',
    '  web:',
    '    type: command',
    '    cwd: .',
    '    command: [node, server.js]',
    '    dependsOn: [api]',
    ''
  ].join('\n');
  expect(() => parseConfigurationFile(text)).toThrow('The YAML does not match the Preview configuration format: Node web depends on missing node api.');
});
