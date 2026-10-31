import fs from 'node:fs/promises';
import path from 'node:path';
import { statfs } from 'node:fs/promises';

export type StorageArea = 'incoming' | 'quarantine' | 'released' | 'tmp';

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** All content lives under one root so moves are atomic renames and deletion can be verified. */
export class Storage {
  constructor(readonly root: string) {}

  dir(area: StorageArea) {
    return path.join(this.root, area);
  }

  async init() {
    for (const a of ['incoming', 'quarantine', 'released', 'tmp'] as StorageArea[]) {
      await fs.mkdir(this.dir(a), { recursive: true, mode: 0o700 });
    }
  }

  /** Path for an id inside an area. Ids are validated so no traversal is possible. */
  pathFor(area: StorageArea, id: string): string {
    if (!ID_RE.test(id)) throw new Error('invalid storage id');
    const p = path.join(this.dir(area), id);
    if (path.dirname(p) !== this.dir(area)) throw new Error('invalid storage path');
    return p;
  }

  /** Paths where bytes for a file may exist (tus incoming file + its json sidecar, quarantine, released). */
  candidatePaths(fileId: string, uploadId: string | null): string[] {
    const out = [this.pathFor('quarantine', fileId), this.pathFor('released', fileId)];
    if (uploadId && ID_RE.test(uploadId)) {
      out.push(this.pathFor('incoming', uploadId), this.pathFor('incoming', uploadId) + '.json');
    }
    return out;
  }

  /** Atomic move; refuses symlinks at either end. */
  async move(from: string, to: string) {
    const st = await fs.lstat(from);
    if (!st.isFile()) throw new Error('refusing to move non-regular file');
    try {
      const dst = await fs.lstat(to);
      if (dst.isSymbolicLink()) throw new Error('refusing to overwrite symlink');
      throw new Error('destination exists');
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await fs.rename(from, to);
  }

  /** Delete a path if it exists; returns true if something was removed. Never follows symlinks. */
  async removeIfExists(p: string): Promise<boolean> {
    try {
      const st = await fs.lstat(p);
      if (st.isDirectory()) {
        await fs.rm(p, { recursive: true, force: true });
      } else {
        await fs.unlink(p);
      }
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

  async size(p: string): Promise<number | null> {
    try {
      const st = await fs.lstat(p);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  }

  async diskUsage(): Promise<{ totalBytes: number; freeBytes: number; availableBytes: number }> {
    const s = await statfs(this.root);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bfree * s.bsize, availableBytes: s.bavail * s.bsize };
  }

  /** List ids in an area (for reconciliation). */
  async list(area: StorageArea): Promise<string[]> {
    try {
      return await fs.readdir(this.dir(area));
    } catch {
      return [];
    }
  }
}
