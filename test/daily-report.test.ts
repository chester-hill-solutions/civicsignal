import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compareHouse, housePublication, houseSnapshot, receiptKey, sourceInstance } from '../services/daily/report';
import { testD1 } from './helpers/d1';

it('requires the same House rows, links, head and archived publication receipt before using the last good generation', async () => {
  const schema = ['preview/committees/migrations/0001_committee_preview.sql', 'services/house/migrations/0001_call_observations.sql']
    .map(path => readFileSync(path, 'utf8')).join('\n');
  const { db, sqlite, close } = testD1({ schema });
  try {
    const scheduledTime = Date.parse('2026-11-26T00:15:00Z');
    const instanceId = sourceInstance('house', scheduledTime);
    const observedAt = '2026-11-26T00:16:34.215000Z';
    const cutoff = '2026-11-25T08:33:25+00:00';
    const sha256 = 'a'.repeat(64);
    sqlite.prepare('INSERT INTO cc_snapshot VALUES (\'45-1\',?)').run(cutoff);
    sqlite.prepare("INSERT INTO cc_house_runs VALUES (?,'45-1',?,?,?,?,?)").run(instanceId, scheduledTime, observedAt, sha256, sha256, '{}');
    sqlite.exec("INSERT INTO cc_records SELECT '45-1','call','en','call','house','house-test','A study',null,'indexed','{}',null");
    sqlite.exec("INSERT INTO cc_links VALUES ('45-1','en','committee','call','publishes')");
    const key = receiptKey('house', instanceId);
    const packetRef = { key: `committee/house-calls/inventories/${sha256}.json`, sha256, bytes: 124 };
    let archived = JSON.stringify({ instanceId, scheduledTime, packetRef, published: { observedAt, cutoff, packetSha256: sha256 } });
    const bucket = { async get(path: string) {
      if (path !== key) return null;
      return { size: Buffer.byteLength(archived), arrayBuffer: async () => Uint8Array.from(Buffer.from(archived)).buffer };
    }} as R2Bucket;

    const before = await houseSnapshot(db);
    const lastGood = await housePublication(bucket, before);
    expect(lastGood).toMatchObject({ instanceId, receiptKey: key, observedAt, cutoff, packetRef });
    expect(compareHouse(before, await houseSnapshot(db), lastGood, lastGood))
      .toMatchObject({ unchanged: true, receiptRetained: true, lastGood });
    archived += '\n';
    expect(compareHouse(before, await houseSnapshot(db), lastGood, await housePublication(bucket, before)))
      .toMatchObject({ unchanged: true, receiptRetained: false, lastGood: null });
    sqlite.exec("UPDATE cc_links SET relation='study-call' WHERE child_id='call'");
    expect(compareHouse(before, await houseSnapshot(db), lastGood, lastGood))
      .toMatchObject({ unchanged: false, lastGood: null });
    sqlite.exec("UPDATE cc_links SET relation='publishes' WHERE child_id='call'");
    sqlite.exec("UPDATE cc_records SET title='Changed' WHERE id='call'");
    expect(compareHouse(before, await houseSnapshot(db), lastGood, lastGood))
      .toMatchObject({ unchanged: false, lastGood: null });
  } finally {
    close();
  }
});
