import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadDesignSkillPack,
  resolveDesignSkillPackRoot
} from './DesignSkillPack';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe('DesignSkillPack', () => {
  it('loads the app pack and builds its catalog only from front matter', async () => {
    const root = path.resolve('resources/design-skills');
    const pack = await loadDesignSkillPack(root);

    expect(pack.rootPath).toBe(await fs.realpath(root));
    expect(pack.skills).toHaveLength(12);
    expect(pack.skills.map((skill) => skill.name)).toEqual([
      'accessibility-review',
      'aesthetic-direction',
      'browser-verification',
      'design-system-inspection',
      'discovery-questions',
      'final-polish',
      'generic-design-review',
      'hierarchy-rhythm-review',
      'interaction-states-review',
      'prototype',
      'variations',
      'wireframe'
    ]);
    for (const skill of pack.skills) {
      expect(path.isAbsolute(skill.path)).toBe(true);
      expect(pack.catalog).toContain(`- ${skill.name}: ${skill.description}`);
      expect(pack.catalog).toContain(`Path: ${skill.path}`);
    }
    expect(pack.catalog).toContain(
      'For each skill that matches the current request, read its exact SKILL.md path before you apply it.'
    );
    expect(pack.catalog).not.toContain('Bad designs often come from missing context');
    await expect(
      fs.readFile(path.join(root, 'browser-verification', 'SKILL.md'), 'utf8')
    ).resolves.toContain(
      '{"operation":"set_media","colorScheme":"light","reducedMotion":true}'
    );
  });

  it('loads a valid minimal pack', async () => {
    const root = await temporaryRoot();
    await writeSkill(root, 'focused-review', 'Use for a focused review.', '# Review\n\nCheck the work.');

    await expect(loadDesignSkillPack(root)).resolves.toMatchObject({
      skills: [
        {
          name: 'focused-review',
          description: 'Use for a focused review.',
          path: path.join(await fs.realpath(root), 'focused-review', 'SKILL.md')
        }
      ]
    });
  });

  it('rejects a symlink root, skill directory, and skill file', async () => {
    const outside = await temporaryRoot();
    await writeSkill(outside, 'outside', 'Use outside.', '# Outside');
    const rootLink = `${outside}-link`;
    temporaryRoots.push(rootLink);
    await fs.symlink(outside, rootLink, 'dir');
    await expect(loadDesignSkillPack(rootLink)).rejects.toThrow('not a symlink');

    const directoryRoot = await temporaryRoot();
    await fs.symlink(path.join(outside, 'outside'), path.join(directoryRoot, 'outside'), 'dir');
    await expect(loadDesignSkillPack(directoryRoot)).rejects.toThrow(
      'regular directory'
    );

    const fileRoot = await temporaryRoot();
    const fileDirectory = path.join(fileRoot, 'outside');
    await fs.mkdir(fileDirectory);
    await fs.symlink(
      path.join(outside, 'outside', 'SKILL.md'),
      path.join(fileDirectory, 'SKILL.md'),
      'file'
    );
    await expect(loadDesignSkillPack(fileRoot)).rejects.toThrow(
      'regular file'
    );
  });

  it('rejects duplicate names, directory mismatches, and missing front matter', async () => {
    const duplicateRoot = await temporaryRoot();
    await writeSkill(duplicateRoot, 'first', 'Use first.', '# First', 'same-name');
    await writeSkill(duplicateRoot, 'second', 'Use second.', '# Second', 'same-name');
    await expect(loadDesignSkillPack(duplicateRoot)).rejects.toThrow('duplicate name');

    const mismatchRoot = await temporaryRoot();
    await writeSkill(mismatchRoot, 'directory-name', 'Use this.', '# Body', 'other-name');
    await expect(loadDesignSkillPack(mismatchRoot)).rejects.toThrow(
      'must match its directory'
    );

    const invalidRoot = await temporaryRoot();
    const invalidDirectory = path.join(invalidRoot, 'invalid');
    await fs.mkdir(invalidDirectory);
    await fs.writeFile(path.join(invalidDirectory, 'SKILL.md'), '# Missing metadata\n');
    await expect(loadDesignSkillPack(invalidRoot)).rejects.toThrow('front matter');
  });

  it('rejects a skill path that resolves outside the root', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeSkill(outside, 'escaped', 'Use escaped.', '# Escaped');
    await fs.symlink(path.join(outside, 'escaped'), path.join(root, 'escaped'), 'dir');

    await expect(loadDesignSkillPack(root)).rejects.toThrow('regular directory');
  });

  it('resolves source and packaged roots from trusted app paths', () => {
    expect(
      resolveDesignSkillPackRoot({
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/project'
      })
    ).toBe(path.join('/project', 'resources', 'design-skills'));
    expect(
      resolveDesignSkillPackRoot({
        isPackaged: true,
        resourcesPath: '/app/Contents/Resources',
        appPath: '/unused'
      })
    ).toBe(path.join('/app/Contents/Resources', 'design-skills'));
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-skills-'));
  temporaryRoots.push(root);
  return root;
}

async function writeSkill(
  root: string,
  directoryName: string,
  description: string,
  body: string,
  name = directoryName
): Promise<void> {
  const directory = path.join(root, directoryName);
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
  );
}
