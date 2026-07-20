import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_WORKSPACE_DIRECTORY = 'empty-read-only-v1';

/**
 * Owns the inert cwd used by discourse jobs that receive metadata-only or no
 * repository access. The directory contains no marker or payload files and is
 * made non-writable on POSIX; provider sandbox attestation remains the primary
 * cross-platform write boundary.
 */
export class DiscourseWorkspace {
  private preparedPath?: string;
  private preparePromise?: Promise<string>;

  constructor(private readonly rootDirectory: string) {}

  async prepareEmptyReadOnlyWorkspace(): Promise<string> {
    if (this.preparedPath) {
      await this.assertEmptyReadOnly(this.preparedPath);
      return this.preparedPath;
    }
    if (!this.preparePromise) {
      this.preparePromise = this.prepare().catch((error) => {
        this.preparePromise = undefined;
        throw error;
      });
    }
    return this.preparePromise;
  }

  private async prepare(): Promise<string> {
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.rootDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('Discourse workspace root must be a private directory.');
    }
    if (process.platform !== 'win32') await fs.chmod(this.rootDirectory, 0o700);

    const canonicalRoot = await fs.realpath(this.rootDirectory);
    const workspacePath = path.join(canonicalRoot, EMPTY_WORKSPACE_DIRECTORY);
    try {
      const existing = await fs.lstat(workspacePath);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error('Discourse empty workspace must be a real directory.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(workspacePath, { mode: 0o500 });
    }
    if (process.platform !== 'win32') await fs.chmod(workspacePath, 0o500);

    const canonicalPath = await fs.realpath(workspacePath);
    if (canonicalPath !== workspacePath) {
      throw new Error('Discourse empty workspace must not resolve through aliases.');
    }
    await this.assertEmptyReadOnly(canonicalPath);
    this.preparedPath = canonicalPath;
    return canonicalPath;
  }

  private async assertEmptyReadOnly(workspacePath: string): Promise<void> {
    const stat = await fs.lstat(workspacePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Discourse empty workspace is missing or unsafe.');
    }
    const entries = await fs.readdir(workspacePath);
    if (entries.length > 0) {
      throw new Error(
        'Discourse empty workspace contains unexpected data; filesystem-free jobs are disabled.'
      );
    }
    if (process.platform !== 'win32' && (stat.mode & 0o222) !== 0) {
      throw new Error('Discourse empty workspace unexpectedly became writable.');
    }
  }
}
