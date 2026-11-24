/**
 * Content-addressed archive for the originals and the snapshot manifests.
 *
 * The key includes the SHA-256 of the original, so a changed export cannot
 * overwrite the copy of the export it changed from. This is the only thing the
 * archive has to guarantee: the directory can always answer "what bytes did you
 * see, and when?".
 */

export interface GedsArchive {
  put(key: string, value: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  putJson(key: string, value: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  has?(key: string): Promise<boolean>;
}

export class MemoryArchive implements GedsArchive {
  private entries = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    this.entries.set(key, value.slice());
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.entries.get(key)?.slice() ?? null;
  }
  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, new TextEncoder().encode(JSON.stringify(value, null, 2)));
  }
  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    return JSON.parse(new TextDecoder().decode(value)) as T;
  }
  async has(key: string): Promise<boolean> {
    return this.entries.has(key);
  }
}

/** The slice of R2 the directory uses. */
export interface R2Like {
  put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head?(key: string): Promise<unknown | null>;
}

export class R2GedsArchive implements GedsArchive {
  constructor(private bucket: R2Like) {}

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.bucket.put(key, value);
  }
  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }
  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, new TextEncoder().encode(JSON.stringify(value, null, 2)));
  }
  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    return JSON.parse(new TextDecoder().decode(value)) as T;
  }
  async has(key: string): Promise<boolean> {
    if (!this.bucket.head) return (await this.get(key)) != null;
    return (await this.bucket.head(key)) != null;
  }
}

export function archiveKeyForOriginal(hash: string, filename: string): string {
  return `geds/archive/${hash}/${filename.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
}

export function archiveMetadataKey(hash: string): string {
  return `geds/archive/${hash}/observation.json`;
}

export function snapshotManifestKey(snapshotId: string): string {
  return `geds/snapshots/${snapshotId}/manifest.json`;
}
