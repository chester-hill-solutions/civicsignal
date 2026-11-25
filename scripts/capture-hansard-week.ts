import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { hansardSpeechId } from '../src/corpora/hansard';
import { parseHansardXml } from '../src/ingest/hansard';
import { discoverHouseHansardWeek, fetchHouseHansardEdition } from './lib/hansard-house-source';
import { discoverSenateHansardWeek, fetchSenateHansardEdition } from './lib/hansard-senate-source';
import { parseSenateHansard } from './lib/senate-hansard-html';

async function capture(chamber: 'house' | 'senate', session: string, monday: string, root: string) {
  const house = chamber === 'house';
  const { weekOf, sittings } = await (house ? discoverHouseHansardWeek : discoverSenateHansardWeek)(session, monday);
  const source = house ? fetchHouseHansardEdition : fetchSenateHansardEdition;
  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(root, '.capture-'));
  const manifest = [];
  const samples = [];
  try {
    for (const sitting of sittings) {
      const files = { ...sitting, en: '', fr: '' };
      for (const edition of ['en', 'fr'] as const) {
        const expected = { ...sitting, edition };
        const bytes = await source(expected);
        if (!bytes) throw new Error(`Missing ${sitting.sittingId} ${edition}`);
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed = house ? parseHansardXml(content) : parseSenateHansard(content, expected);
        if (parsed.edition !== edition || parsed.sitting.sittingId !== sitting.sittingId || parsed.sitting.sittingDate !== sitting.sittingDate) {
          throw new Error('Publication identity differs from its calendar entry');
        }
        const first = parsed.sitting.speeches[0];
        if (!first) throw new Error('No citable speech in a published edition');
        const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
        samples.push({ ...sitting, id: hansardSpeechId(edition, sitting.sittingId, first.interventionId, chamber),
          language: edition, speaker: first.speaker, citationUrl: first.citationUrl, sourceSha256 });
        files[edition] = sourceSha256 + (house ? '.xml' : '.html');
        writeFileSync(join(tmp, files[edition]), bytes);
      }
      manifest.push(files);
    }
    const packet = JSON.stringify({ weekOf, sittings: manifest });
    const receipt = JSON.stringify({ chamber, session, weekOf, lookupSamples: samples });
    writeFileSync(join(tmp, 'week.json'), packet);
    writeFileSync(join(tmp, 'receipt.json'), receipt);
    const generation = join(root, createHash('sha256').update(packet).update(receipt).digest('hex'));
    if (existsSync(generation)) {
      if (readFileSync(join(generation, 'week.json'), 'utf8') !== packet || readFileSync(join(generation, 'receipt.json'), 'utf8') !== receipt) {
        throw new Error('Previously captured Hansard manifest differs');
      }
      for (const edition of manifest.flatMap(row => [row.en, row.fr])) {
        if (createHash('sha256').update(readFileSync(join(generation, edition))).digest('hex') !== edition.split('.')[0]) {
          throw new Error('Previously captured Hansard original differs');
        }
      }
    } else {
      renameSync(tmp, generation);
    }
    const next = join(root, '.current-' + randomUUID());
    symlinkSync(basename(generation), next);
    renameSync(next, join(root, 'current'));
    console.log(JSON.stringify({ chamber, weekOf, editions: samples.length, generation }));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const [chamber, session, monday, directory] = process.argv.slice(2);
if ((chamber !== 'house' && chamber !== 'senate') || !session || !monday || !directory) {
  throw new Error('Usage: bun scripts/capture-hansard-week.ts <house|senate> <session> <week-of> <archive-directory>');
}
await capture(chamber, session, monday, resolve(directory));
