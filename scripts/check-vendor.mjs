import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const receipt = JSON.parse(readFileSync(join(root, 'vendor/chs-provenance.json'), 'utf8'));
function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected vendor symlink: ${name}`);
    return entry.isDirectory() ? files(join(directory, entry.name), name) : [name];
  }).sort();
}
for (const entry of receipt.packages) {
  if (!['@chester-hill-solutions/corpus', '@chester-hill-solutions/api-billing'].includes(entry.package)) throw new Error('Unexpected package');
  const directory = join(root, 'vendor', entry.package);
  const expected = entry.files.map(file => file.path).sort();
  if (JSON.stringify(files(directory)) !== JSON.stringify(expected)) throw new Error(`Vendor file list differs: ${entry.package}`);
  for (const file of entry.files) {
    const actual = createHash('sha256').update(readFileSync(join(directory, file.path))).digest('hex');
    if (actual !== file.sha256) throw new Error(`Vendor checksum differs: ${entry.package}/${file.path}`);
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== entry.package || manifest.version !== entry.version || manifest.gitHead !== entry.sourceCommit) throw new Error(`Vendor identity differs: ${entry.package}`);
}
console.log('vendor: both CHS packages match their committed source receipts');
