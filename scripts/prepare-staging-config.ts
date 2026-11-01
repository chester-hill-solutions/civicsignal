/** Prepare standalone staging configs. Does not create resources or deploy. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapStagingConfig, prepareStagingConfigs } from './lib/staging-config';

const args = process.argv.slice(2);
if (args.length !== 4 || !['--bootstrap', '--inventory'].includes(args[0]!) || args[2] !== '--out') {
  throw new Error('Use --bootstrap <YYYYMMDD> or --inventory <checked inventory.json>, followed by --out <config directory>.');
}
const root = resolve(import.meta.dir, '..');
const directory = resolve(args[3]!);
const configs = args[0] === '--bootstrap' ? { resources: bootstrapStagingConfig(root, args[1]!) }
  : prepareStagingConfigs(root, JSON.parse(readFileSync(resolve(args[1]!), 'utf8')));
const outputs = Object.entries(configs).map(([name, value]) => ({ path: resolve(directory, name + '.json'), text: JSON.stringify(value, null, 2) + '\n' }));
for (const output of outputs) {
  if (existsSync(output.path) && readFileSync(output.path, 'utf8') !== output.text) throw new Error('An existing staging config differs; select a new review directory.');
}
mkdirSync(directory, { recursive: true });
for (const output of outputs) if (!existsSync(output.path)) writeFileSync(output.path, output.text, { flag: 'wx' });
console.log(JSON.stringify({ files: outputs.map((output) => output.path), remoteChanges: 0,
  next: 'Read actual returned resource descriptors and review every binding before deployment. No secrets are included.' }));
