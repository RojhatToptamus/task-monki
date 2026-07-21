import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkArchitecture,
  collectProductionGraph,
  findCycles,
  validateBoundaries
} from './check-architecture.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe('architecture dependency checks', () => {
  it('accepts dependencies that point toward shared contracts', async () => {
    const root = await fixture({
      'src/shared/contracts.ts': 'export interface Value { id: string }\n',
      'src/core/service.ts': "import type { Value } from '../shared/contracts';\nexport type Result = Value;\n",
      'src/renderer/model/view.ts': "import type { Value } from '../../shared/contracts';\nexport type View = Value;\n"
    });

    await expect(checkArchitecture(root)).resolves.toMatchObject({
      boundaryViolations: [],
      cycles: []
    });
  });

  it('rejects reversed layer dependencies and production test-support imports', async () => {
    const root = await fixture({
      'src/core/service.ts': 'export const service = true;\n',
      'src/shared/contracts.ts': "export { service } from '../core/service';\n",
      'src/renderer/ui/widget.ts': "import { fake } from '../../testSupport/fake';\nexport { fake };\n",
      'src/testSupport/fake.ts': 'export const fake = true;\n'
    });
    const graph = await collectProductionGraph(root);

    expect(validateBoundaries(root, graph)).toEqual([
      expect.objectContaining({
        source: 'src/renderer/ui/widget.ts',
        dependency: 'src/testSupport/fake.ts'
      }),
      expect.objectContaining({
        source: 'src/shared/contracts.ts',
        dependency: 'src/core/service.ts'
      })
    ]);
  });

  it('reports file-level cycles while ignoring test-only cycles', async () => {
    const root = await fixture({
      'src/core/first.ts': "export { second } from './second';\nexport const first = true;\n",
      'src/core/second.ts': "export { first } from './first';\nexport const second = true;\n",
      'src/core/ignored.test.ts': "import './ignored-helper.test';\n",
      'src/core/ignored-helper.test.ts': "import './ignored.test';\n"
    });
    const graph = await collectProductionGraph(root);

    expect(findCycles(root, graph)).toEqual([
      ['src/core/first.ts', 'src/core/second.ts']
    ]);
  });

  it('keeps provider implementations independent from one another', async () => {
    const root = await fixture({
      'src/core/agent/codex/adapter.ts':
        "import { bridge } from '../acp/bridge';\nexport { bridge };\n",
      'src/core/agent/acp/bridge.ts': 'export const bridge = true;\n'
    });
    const graph = await collectProductionGraph(root);

    expect(validateBoundaries(root, graph)).toEqual([
      expect.objectContaining({
        source: 'src/core/agent/codex/adapter.ts',
        dependency: 'src/core/agent/acp/bridge.ts',
        detail: 'provider adapters cannot depend on another provider implementation'
      })
    ]);
  });
});

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-architecture-'));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const file = path.join(root, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
    })
  );
  return root;
}
