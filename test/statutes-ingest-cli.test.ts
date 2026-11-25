import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('publishes separate language exports and retains them when a subsequent refresh fails', () => {
  const base = mkdtempSync(join(tmpdir(), 'civicsignal-statutes-cli-'));
  const source = join(base, 'source');
  const output = join(base, 'out');
  const run = (...extra: string[]) => spawnSync(process.env.CIVICSIGNAL_BUN_BINARY ?? 'bun',
    ['scripts/ingest-statutes.ts', '--corpus', source, '--out', output, ...extra], { encoding: 'utf8' });
  try {
    for (const dir of ['eng/acts', 'eng/regulations', 'fra/lois', 'fra/reglements']) {
      mkdirSync(join(source, dir), { recursive: true });
    }
    for (const [directory, language] of [['eng/acts', 'en'], ['fra/lois', 'fr']]) {
      writeFileSync(join(source, directory, 'A-1.xml'), `<Statute xml:lang="${language}" xmlns:lims="http://justice.gc.ca/lims">
        <Identification><ShortTitle>Title ${language}</ShortTitle><Chapter><ConsolidatedNumber official="yes">A-1</ConsolidatedNumber></Chapter></Identification>
        <Body><Section lims:id="17"><Label>1</Label><Text>Text ${language}</Text></Section></Body></Statute>`);
    }
    const built = run('--no-fetch');
    expect(built.stderr).toBe('');
    expect(built.status).toBe(0);
    for (const [suffix, language] of [['', 'en'], ['-fr', 'fr']]) {
      const row = JSON.parse(readFileSync(join(output, `statutes${suffix}.jsonl`), 'utf8').trim());
      expect(row.language).toBe(language);
      expect(existsSync(join(output, `statutes${suffix}.sql`))).toBe(true);
    }
    const git = (...args: string[]) => spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    expect(git('add', 'eng', 'fra').status).toBe(0);
    expect(git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '-qm', 'Official source fixture').status).toBe(0);
    expect(git('remote', 'add', 'origin', 'https://github.com/justicecanada/laws-lois-xml.git').status).toBe(0);
    expect(git('update-ref', 'refs/remotes/origin/main', 'HEAD').status).toBe(0);
    const published = run('--no-fetch', '--publish-current');
    expect(published.status, published.stderr).toBe(0);
    const generation = readlinkSync(join(output, 'current'));
    const receipt = JSON.parse(readFileSync(join(output, 'current', 'receipt.json'), 'utf8'));
    expect(Object.keys(receipt.files)).toHaveLength(6);
    expect(run('--no-fetch', '--publish-current').status).toBe(0);
    expect(readlinkSync(join(output, 'current'))).toBe(generation);
    writeFileSync(join(source, 'eng/acts/B-2.xml'), '<unexpected/>');
    expect(git('add', 'eng/acts/B-2.xml').status).toBe(0);
    expect(git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '-qm', 'Add malformed instrument').status).toBe(0);
    expect(run('--no-fetch', '--publish-current').stderr).toContain('observed Justice Canada main revision');
    expect(git('update-ref', 'refs/remotes/origin/main', 'HEAD').status).toBe(0);
    expect(run('--no-fetch', '--publish-current').stderr).toContain('Failed to parse');
    expect(readlinkSync(join(output, 'current'))).toBe(generation);
    expect(git('remote', 'remove', 'origin').status).toBe(0);
    rmSync(join(source, 'fra/lois/A-1.xml'));
    const original = readFileSync(join(output, 'statutes.jsonl'), 'utf8');
    writeFileSync(join(source, 'eng/acts/A-1.xml'), readFileSync(join(source, 'eng/acts/A-1.xml'), 'utf8').replace('Text en', 'Revised'));
    expect(run('--no-fetch').status).not.toBe(0);
    expect(run('--no-fetch', '--publish-current').status).not.toBe(0);
    expect(readlinkSync(join(output, 'current'))).toBe(generation);
    expect(readFileSync(join(output, 'statutes.jsonl'), 'utf8')).toBe(original);
    const failed = run();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('git pull failed');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
