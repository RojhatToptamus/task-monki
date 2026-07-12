import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createInitialProjection,
  TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
  TASK_STORE_SCHEMA_VERSION,
  type TaskManagerAppSettings,
  type TaskSnapshot,
  type WorktreeRecord
} from '../../shared/contracts';
import {
  createNodeOpenTargetHost,
  OpenTargetService,
  type OpenTargetHost
} from './OpenTargetService';

const defaultSettings: TaskManagerAppSettings = {
  schemaVersion: TASK_MANAGER_APP_SETTINGS_SCHEMA_VERSION,
  theme: 'device',
  sidebarCollapsed: false,
  showMascot: true,
  firstLaunchSetupCompleted: true,
  codexExternalTools: {
    webSearchMode: 'disabled',
    mcpServers: 'disabled',
    apps: 'disabled'
  },
  externalExecutables: {
    gitExecutablePath: null,
    codexExecutablePath: null,
    ghExecutablePath: null
  },
  repositories: {
    knownPaths: ['/repo'],
    selectedPath: '/repo'
  },
  previewGateway: { port: null }
};

describe('OpenTargetService', () => {
  it('provides an icon reader in the shared Node host', () => {
    expect(createNodeOpenTargetHost().getFileIconDataUrl).toEqual(expect.any(Function));
  });

  it.runIf(process.platform !== 'win32')(
    'refuses descriptor copy when the selected file is replaced by a symlink',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-open-copy-'));
      const worktree = path.join(directory, 'worktree');
      const outside = path.join(directory, 'outside.txt');
      const selected = path.join(worktree, 'selected.txt');
      await fs.mkdir(worktree);
      await fs.writeFile(outside, 'outside secret', 'utf8');
      await fs.symlink(outside, selected);

      await expect(
        createNodeOpenTargetHost().readFile(selected, worktree, 512 * 1024)
      ).rejects.toThrow('could not be opened safely');
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside secret');
    }
  );

  it('detects an editor from PATH and opens a worktree file with line and column', async () => {
    const host = new FakeOpenTargetHost({
      '/bin/code': executable(),
      '/repo': directory(),
      '/worktree': directory(),
      '/worktree/src': directory(),
      '/worktree/src/app.ts': file('const value = 1;\n')
    });
    const service = new OpenTargetService(host);
    const context = testContext();

    const inspection = await service.inspect(
      {
        target: {
          type: 'worktreeFile',
          worktreeId: 'worktree-1',
          relativePath: 'src/app.ts',
          line: 12,
          column: 4
        }
      },
      context
    );

    expect(inspection.preferredAppId).toBe('vscode');
    expect(inspection.canCopyFileContents).toBe(true);

    await expect(
      service.execute(
        {
          action: 'open',
          appId: 'vscode',
          target: {
            type: 'worktreeFile',
            worktreeId: 'worktree-1',
            relativePath: 'src/app.ts',
            line: 12,
            column: 4
          }
        },
        context
      )
    ).resolves.toMatchObject({ ok: true });

    expect(host.launched).toEqual([
      {
        executable: '/bin/code',
        argv: ['--goto', '/worktree/src/app.ts:12:4'],
        cwd: '/worktree'
      }
    ]);
  });

  it('uses a native app icon when PATH detection can be matched to an app bundle', async () => {
    const host = new FakeOpenTargetHost(
      {
        '/bin/code': executable(),
        '/Applications/Visual Studio Code.app': directory(),
        '/repo': directory(),
        '/worktree': directory()
      },
      {
        iconDataUrls: {
          '/Applications/Visual Studio Code.app': 'data:image/png;base64,vscode'
        }
      }
    );
    const service = new OpenTargetService(host);

    const inspection = await service.inspect(
      {
        target: {
          type: 'worktree',
          worktreeId: 'worktree-1'
        }
      },
      testContext()
    );

    expect(inspection.apps.find((app) => app.id === 'vscode')).toMatchObject({
      icon: {
        kind: 'image',
        dataUrl: 'data:image/png;base64,vscode'
      }
    });
    expect(inspection.apps.find((app) => app.id === 'default')).not.toHaveProperty('icon');
  });

  it('rejects worktree file targets that escape the recorded root', async () => {
    const service = new OpenTargetService(new FakeOpenTargetHost({
      '/repo': directory(),
      '/worktree': directory()
    }));

    await expect(
      service.inspect(
        {
          target: {
            type: 'worktreeFile',
            worktreeId: 'worktree-1',
            relativePath: '../outside.txt'
          }
        },
        testContext()
      )
    ).rejects.toThrow(/escapes/);
  });

  it('rejects existing worktree file targets whose real path escapes the recorded root', async () => {
    const service = new OpenTargetService(new FakeOpenTargetHost(
      {
        '/repo': directory(),
        '/worktree': directory(),
        '/worktree/link.ts': file('outside\n')
      },
      {
        realpaths: {
          '/worktree': '/worktree',
          '/worktree/link.ts': '/outside/link.ts'
        }
      }
    ));

    await expect(
      service.inspect(
        {
          target: {
            type: 'worktreeFile',
            worktreeId: 'worktree-1',
            relativePath: 'link.ts'
          }
        },
        testContext()
      )
    ).rejects.toThrow(/escapes/);
  });

  it('keeps missing files usable for copy path and reveal parent fallbacks', async () => {
    const service = new OpenTargetService(new FakeOpenTargetHost({
      '/repo': directory(),
      '/worktree': directory(),
      '/worktree/src': directory()
    }));

    const inspection = await service.inspect(
      {
        target: {
          type: 'worktreeFile',
          worktreeId: 'worktree-1',
          relativePath: 'src/deleted.ts'
        }
      },
      testContext()
    );

    expect(inspection.canOpen).toBe(false);
    expect(inspection.canReveal).toBe(true);
    expect(inspection.canCopyFileContents).toBe(false);
    expect(inspection.copyFileContentsDisabledReason).toBe('File is missing.');

    const copy = await service.execute(
      {
        action: 'copyPath',
        target: {
          type: 'worktreeFile',
          worktreeId: 'worktree-1',
          relativePath: 'src/deleted.ts'
        }
      },
      testContext()
    );
    expect(copy).toMatchObject({
      ok: true,
      clipboardText: '/worktree/src/deleted.ts'
    });
  });

  it('opens recorded repositories with the default app fallback', async () => {
    const host = new FakeOpenTargetHost({
      '/repo': directory(),
      '/worktree': directory()
    });
    const service = new OpenTargetService(host);

    await expect(
      service.execute(
        {
          action: 'open',
          appId: 'default',
          target: {
            type: 'repository',
            repositoryPath: '/repo'
          }
        },
        testContext()
      )
    ).resolves.toMatchObject({ ok: true });

    expect(host.defaults).toEqual(['/repo']);
  });

  it('opens worktrees in Terminal on macOS', async () => {
    const host = new FakeOpenTargetHost({
      '/repo': directory(),
      '/worktree': directory()
    });
    const service = new OpenTargetService(host);

    await expect(
      service.execute(
        {
          action: 'openTerminal',
          target: {
            type: 'worktree',
            taskId: 'task-1',
            worktreeId: 'worktree-1'
          }
        },
        testContext()
      )
    ).resolves.toMatchObject({ ok: true });

    expect(host.launched).toEqual([
      {
        executable: 'open',
        argv: ['-a', 'Terminal', '/worktree'],
        cwd: undefined
      }
    ]);
  });

  it('detects and opens Windows editors from PATH with PATHEXT and native icon paths', async () => {
    const host = new FakeOpenTargetHost(
      {
        'C:\\Users\\person\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.CMD': executable(),
        'C:\\Users\\person\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe': executable(),
        'C:\\repo': directory(),
        'C:\\worktree': directory(),
        'C:\\worktree\\src': directory(),
        'C:\\worktree\\src\\app.ts': file('const value = 1;\n')
      },
      {
        env: {
          PATH: 'C:\\Users\\person\\AppData\\Local\\Programs\\Microsoft VS Code\\bin',
          PATHEXT: '.EXE;.CMD',
          LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local'
        },
        iconDataUrls: {
          'C:\\Users\\person\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe':
            'data:image/png;base64,windows-vscode'
        },
        platform: 'win32'
      }
    );
    const service = new OpenTargetService(host);
    const context = testContext({
      repositoryPath: 'C:\\repo',
      worktreePath: 'C:\\worktree'
    });

    const inspection = await service.inspect(
      {
        target: {
          type: 'worktreeFile',
          worktreeId: 'worktree-1',
          relativePath: 'src/app.ts',
          line: 8,
          column: 2
        }
      },
      context
    );

    expect(inspection.preferredAppId).toBe('vscode');
    expect(inspection.revealLabel).toBe('Reveal in File Explorer');
    expect(inspection.apps.find((app) => app.id === 'vscode')).toMatchObject({
      icon: {
        kind: 'image',
        dataUrl: 'data:image/png;base64,windows-vscode'
      }
    });

    await expect(
      service.execute(
        {
          action: 'open',
          appId: 'vscode',
          target: {
            type: 'worktreeFile',
            worktreeId: 'worktree-1',
            relativePath: 'src/app.ts',
            line: 8,
            column: 2
          }
        },
        context
      )
    ).resolves.toMatchObject({ ok: true });

    expect(host.launched).toEqual([
      {
        executable: 'C:\\Users\\person\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.CMD',
        argv: ['--goto', 'C:\\worktree\\src\\app.ts:8:2'],
        cwd: 'C:\\worktree'
      }
    ]);
  });

  it('opens worktrees in Windows Terminal when wt is available', async () => {
    const host = new FakeOpenTargetHost(
      {
        'C:\\Windows\\System32\\wt.EXE': executable(),
        'C:\\repo': directory(),
        'C:\\worktree': directory()
      },
      {
        env: {
          PATH: 'C:\\Windows\\System32',
          PATHEXT: '.EXE;.CMD'
        },
        platform: 'win32'
      }
    );
    const service = new OpenTargetService(host);
    const context = testContext({
      repositoryPath: 'C:\\repo',
      worktreePath: 'C:\\worktree'
    });

    const inspection = await service.inspect(
      {
        target: {
          type: 'worktree',
          taskId: 'task-1',
          worktreeId: 'worktree-1'
        }
      },
      context
    );

    expect(inspection.canOpenTerminal).toBe(true);
    await expect(
      service.execute(
        {
          action: 'openTerminal',
          target: {
            type: 'worktree',
            taskId: 'task-1',
            worktreeId: 'worktree-1'
          }
        },
        context
      )
    ).resolves.toMatchObject({ ok: true });

    expect(host.launched).toEqual([
      {
        executable: 'C:\\Windows\\System32\\wt.EXE',
        argv: ['-d', 'C:\\worktree'],
        cwd: undefined
      }
    ]);
  });

  it('rejects repository targets that are not recorded by Task Monki', async () => {
    const service = new OpenTargetService(new FakeOpenTargetHost({
      '/repo': directory(),
      '/outside': directory(),
      '/worktree': directory()
    }));

    await expect(
      service.inspect(
        {
          target: {
            type: 'repository',
            repositoryPath: '/outside'
          }
        },
        testContext()
      )
    ).rejects.toThrow(/not recorded/);
  });

  it('copies safe UTF-8 files but blocks binary contents', async () => {
    const host = new FakeOpenTargetHost({
      '/repo': directory(),
      '/worktree': directory(),
      '/worktree/src': directory(),
      '/worktree/src/app.ts': file('hello\n'),
      '/worktree/src/image.bin': file(Buffer.from([1, 0, 2]))
    });
    const service = new OpenTargetService(host);

    await expect(
      service.execute(
        {
          action: 'copyFileContents',
          target: {
            type: 'worktreeFile',
            worktreeId: 'worktree-1',
            relativePath: 'src/app.ts'
          }
        },
        testContext()
      )
    ).resolves.toMatchObject({
      ok: true,
      clipboardText: 'hello\n'
    });

    const binary = await service.execute(
      {
        action: 'copyFileContents',
        target: {
          type: 'worktreeFile',
          worktreeId: 'worktree-1',
          relativePath: 'src/image.bin'
        }
      },
      testContext()
    );

    expect(binary).toMatchObject({
      ok: false,
      message: 'Binary file contents cannot be copied.'
    });
  });

  it('preserves special relative-path characters instead of trimming them', async () => {
    const host = new FakeOpenTargetHost({
      '/repo': directory(),
      '/worktree': directory(),
      '/worktree/src': directory(),
      '/worktree/src/file with trailing space.ts ': file('space-sensitive\n')
    });
    const service = new OpenTargetService(host);

    const copy = await service.execute(
      {
        action: 'copyFileContents',
        target: {
          type: 'worktreeFile',
          worktreeId: 'worktree-1',
          relativePath: 'src/file with trailing space.ts '
        }
      },
      testContext()
    );

    expect(copy).toMatchObject({
      ok: true,
      clipboardText: 'space-sensitive\n'
    });
  });
});

type FakeEntry =
  | { type: 'file'; content: Buffer }
  | { type: 'directory' }
  | { type: 'executable' };

class FakeOpenTargetHost implements OpenTargetHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly launched: Array<{ executable: string; argv: string[]; cwd?: string }> = [];
  readonly defaults: string[] = [];
  readonly reveals: string[] = [];
  private readonly entries: Record<string, FakeEntry>;
  private readonly iconDataUrls: Record<string, string>;
  private readonly realpaths: Record<string, string>;

  constructor(
    entries: Record<string, FakeEntry>,
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      iconDataUrls?: Record<string, string>;
      platform?: NodeJS.Platform;
      realpaths?: Record<string, string>;
    } = {}
  ) {
    this.platform = options.platform ?? 'darwin';
    this.env = options.env ?? { PATH: '/bin' };
    this.entries = normalizeRecord(entries, this.platform);
    this.iconDataUrls = normalizeRecord(options.iconDataUrls ?? {}, this.platform);
    this.realpaths = normalizeRecord(options.realpaths ?? {}, this.platform);
  }

  async stat(filePath: string) {
    const entry = this.entries[normalize(filePath, this.platform)];
    if (!entry || entry.type === 'executable') {
      return null;
    }
    return {
      isFile: entry.type === 'file',
      isDirectory: entry.type === 'directory',
      size: entry.type === 'file' ? entry.content.byteLength : 0
    };
  }

  async realpath(filePath: string) {
    return this.realpaths[normalize(filePath, this.platform)] ?? normalize(filePath, this.platform);
  }

  async access(filePath: string) {
    return Boolean(this.entries[normalize(filePath, this.platform)]);
  }

  async readFile(filePath: string) {
    const entry = this.entries[normalize(filePath, this.platform)];
    if (!entry || entry.type !== 'file') {
      throw new Error('File not found.');
    }
    return entry.content;
  }

  async launchExecutable(executable: string, argv: string[], cwd?: string) {
    this.launched.push({ executable, argv, cwd });
  }

  async openDefault(filePath: string) {
    this.defaults.push(filePath);
  }

  async reveal(filePath: string) {
    this.reveals.push(filePath);
  }

  async getFileIconDataUrl(filePath: string) {
    return this.iconDataUrls[normalize(filePath, this.platform)];
  }
}

function testContext(input: { repositoryPath?: string; worktreePath?: string } = {}) {
  const repositoryPath = input.repositoryPath ?? '/repo';
  const worktreePath = input.worktreePath ?? '/worktree';
  return {
    snapshot: testSnapshot({ repositoryPath, worktreePath }),
    defaultRepositoryPath: repositoryPath,
    appSettings: {
      ...defaultSettings,
      repositories: {
        knownPaths: [repositoryPath],
        selectedPath: repositoryPath
      }
    }
  };
}

function testSnapshot(input: { repositoryPath?: string; worktreePath?: string } = {}): TaskSnapshot {
  const repositoryPath = input.repositoryPath ?? '/repo';
  const worktreePath = input.worktreePath ?? '/worktree';
  const worktree = testWorktree({ repositoryPath, worktreePath });
  return {
    schemaVersion: TASK_STORE_SCHEMA_VERSION,
    tasks: [
      {
        id: 'task-1',
        title: 'Task',
        prompt: 'Do it',
        repositoryPath,
        workflowPhase: 'REVIEW',
        resolution: 'NONE',
        completionPolicy: 'LOCAL_ACCEPTANCE',
        phaseVersion: 1,
        currentWorktreeId: worktree.id,
        forkedAlternativeTaskIds: [],
        agentSettings: {},
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt: '2026-07-05T00:00:00.000Z',
        projection: createInitialProjection('2026-07-05T00:00:00.000Z')
      }
    ],
    iterations: [],
    worktrees: [worktree],
    gitSnapshots: [],
    githubRepositories: [],
    branchPublications: [],
    pullRequests: [],
    ciRollups: [],
    reviewRollups: [],
    mergeSnapshots: [],
    runs: [],
    agentServers: [],
    agentSessions: [],
    agentItems: [],
    agentGoalSnapshots: [],
    agentPlanRevisions: [],
    agentUsageSnapshots: [],
    agentSettingsObservations: [],
    agentSubagentObservations: [],
    interactionRequests: [],
    previewPlans: [],
    previewApprovals: [],
    previewGenerations: [],
    previewManagedEnvironments: [],
    previewManagedResources: [],
    previewGenerationAttachments: [],
    previewNodeAttempts: [],
    previewResources: [],
    events: [],
    artifacts: []
  };
}

function testWorktree(input: { repositoryPath?: string; worktreePath?: string } = {}): WorktreeRecord {
  return {
    id: 'worktree-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    repositoryPath: input.repositoryPath ?? '/repo',
    worktreePath: input.worktreePath ?? '/worktree',
    branchName: 'codex/task',
    baseSha: 'abc123',
    status: 'PRESENT',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z'
  };
}

function file(content: string | Buffer): FakeEntry {
  return {
    type: 'file',
    content: Buffer.isBuffer(content) ? content : Buffer.from(content)
  };
}

function directory(): FakeEntry {
  return { type: 'directory' };
}

function executable(): FakeEntry {
  return { type: 'executable' };
}

function normalizeRecord<T>(record: Record<string, T>, platform: NodeJS.Platform): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [normalize(key, platform), value])
  );
}

function normalize(filePath: string, platform: NodeJS.Platform): string {
  const normalized = (platform === 'win32' ? path.win32 : path.posix).normalize(filePath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
