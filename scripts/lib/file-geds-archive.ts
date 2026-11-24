import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GedsArchive } from '../../src/geds/archive';

/** The local mirror of the R2 archive: one file per key, content-addressed. */
export class FileGedsArchive implements GedsArchive {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    const relativePath = relative(this.root, path);
    if (
      !key ||
      isAbsolute(key) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error(`archive key escapes its root: ${key}`);
    }
    return path;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, value, { flag: 'wx' });
      renameSync(temporaryPath, path);
    } catch (error) {
      if (existsSync(temporaryPath)) {
        rmSync(temporaryPath, { force: true });
      }
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, new TextEncoder().encode(JSON.stringify(value, null, 2)));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    return value ? (JSON.parse(new TextDecoder().decode(value)) as T) : null;
  }

  async has(key: string): Promise<boolean> {
    return existsSync(this.pathFor(key));
  }
}
