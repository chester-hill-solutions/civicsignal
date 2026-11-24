import { createHash } from 'node:crypto';

/** Incremental SHA-256 for the directory CSV and its compressed original. */
export class Sha256 {
  private readonly hash = createHash('sha256');
  update(bytes: Uint8Array): this {
    this.hash.update(bytes);
    return this;
  }
  digestHex(): string { return this.hash.digest('hex'); }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
