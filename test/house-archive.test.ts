import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { inventoryReference, prefix, readHouseInventory } from '../services/house/archive';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const checked = '2026-11-26T00:15:20.000000Z';
  const scheduledTime = Date.parse('2026-11-26T00:15:00Z');
  const instanceId = `house-calls-${scheduledTime}`;
  const body = '<html><body>Test publisher page</body></html>';
  const digest = sha(body);
  const key = `${prefix}/sources/${digest}.html`;
  const calls = (['en', 'fr'] as const).map(language => ({
    session: '45-1', id: 'house-abc-call-123', language, kind: 'call', chamber: 'house',
    committee_id: 'house-abc', title: 'Study', status: 'indexed',
    url: `https://www.ourcommons.ca/committees/${language}/ABC/StudyActivity?studyActivityId=123`,
    metadata: {
      committeeCode: 'ABC', studyId: '123', listingUrl: `https://www.ourcommons.ca/Committees/${language}/Participate`,
      termsUrl: 'https://apps.ourcommons.ca/en/important-notices', delivery: 'excerpt',
      instructionUrl: null, instructions: null, deadline: null, contentWarning: false, contentWarningText: null,
      listed: true, lastListedAt: checked, observedAt: checked, firstObservedAt: checked,
      revision: 1, contentDigest: 'a'.repeat(64), pendingDigest: null, contentConflict: false,
    },
  }));
  const house = calls.flatMap(({ url, language, metadata }) => [url, metadata.listingUrl].map(sourceUrl => ({
    url: sourceUrl, resolvedUrl: sourceUrl, chamber: 'house', language,
    checked, key, sha256: digest, bytes: Buffer.byteLength(body), status: 200, state: 'archived',
  })));
  const senate = [
    'en/committees/', 'en/committees/aefa/', 'en/committees/aefa/briefs/45-1', 'en/committees/aefa/studiesandbills/45-1',
    'fr/comites/', 'fr/comites/aefa/', 'fr/comites/aefa/memoires/45-1', 'fr/comites/aefa/etudesetprojetsdeloi/45-1',
  ].map(path => ({
    url: 'https://sencanada.ca/' + path, chamber: 'senate', language: path.slice(0, 2),
    checked, status: 503, state: 'unavailable', error: 'Publisher returned HTTP 503.', listing: 'unreadable',
  }));
  const sources = [...house, ...senate];
  const packet = { session: '45-1', instanceId, scheduledTime, observedAt: checked, priorSha256: 'b'.repeat(64), sources, calls };
  const data = JSON.stringify(packet);
  const ref = inventoryReference({ key: `${prefix}/inventories/${sha(data)}.json`, sha256: sha(data), bytes: Buffer.byteLength(data) });
  const objects = new Map([[ref.key, data], [key, body]]);
  const checkpoint = (url: string) => `${prefix}/observations/${instanceId}/pages/${sha(url)}.json`;
  for (const source of sources) objects.set(checkpoint(source.url), JSON.stringify(source));
  const bucket = { async get(name: string) {
    const value = objects.get(name);
    if (!value) return null;
    return { size: Buffer.byteLength(value), arrayBuffer: async () => Uint8Array.from(Buffer.from(value)).buffer };
  }};
  return { read: () => readHouseInventory(bucket, ref, instanceId, scheduledTime), objects, checkpoint, packet, body, key, senate };
}

it('compares the captured publisher pages and unavailable Senate checkpoints before returning the inventory', async () => {
  const { read, packet, key, objects, body, checkpoint, senate } = fixture();
  expect(await read()).toEqual(packet);
  objects.set(key, body.replace('Test', 'Fake'));
  await expect(read()).rejects.toThrow('digest mismatch');
  objects.set(key, body);
  const denied = senate[0];
  objects.set(checkpoint(denied.url), JSON.stringify({ ...denied, error: 'HTTP 404' }));
  await expect(read()).rejects.toThrow('checkpoint differs from inventory');
});
