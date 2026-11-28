import { createHash } from 'node:crypto';
import type { WorkflowStep } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { refSchema } from '../services/federal-register/inventory';
import { runArchiveRefresh } from '../services/weekly-archive/refresh';

const base = 'weekly/library-fixture';

function objectRef(folder: string, body: string) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  return { key: `${base}/${folder}/${sha256}.json`, sha256, bytes: Buffer.byteLength(body) };
}

it('preserves the archive head when a completed report names a different workspace', async () => {
  const previousBody = '{"workspace":"previous"}';
  const previous = objectRef('manifests', previousBody);
  const claimed = objectRef('manifests', '{"workspace":"claimed"}');
  const actualBody = '{"workspace":"actual"}';
  const actual = objectRef('manifests', actualBody);
  const reportBody = JSON.stringify({ complete: true, workspace: claimed });
  const report = objectRef('reports', reportBody);
  const id = ({ scheduledTime }: { scheduledTime: number }) => `library-${scheduledTime}`;
  const receiptKey = `${base}/runs/library-1.json`;
  const head = JSON.stringify({ instanceId: 'library-1', scheduledTime: 1, receiptKey, status: 'complete', state: previous });
  const objects = new Map([
    [`${base}/latest-complete.json`, head], [previous.key, previousBody], [actual.key, actualBody],
    [claimed.key, '{"workspace":"claimed"}'], [report.key, reportBody],
  ]);
  const put = vi.fn();
  const bucket = {
    put,
    async get(key: string) {
      const body = objects.get(key);
      if (body === undefined) return null;
      const bytes = new TextEncoder().encode(body);
      return { etag: key, size: bytes.length, json: async () => JSON.parse(body), arrayBuffer: async () => bytes.buffer };
    },
  };
  const step = { do: (_name: string, run: () => unknown) => run() };
  const destroy = vi.fn(async () => {});
  const runtime = {
    destroy,
    async fetch(url: string) {
      return url.endsWith('/start') ? new Response(null, { status: 202 }) :
        Response.json({ status: 'complete', instanceId: 'library-2', report, state: actual });
    },
  };
  await expect(runArchiveRefresh(step as unknown as WorkflowStep, bucket as unknown as R2Bucket, runtime, { scheduledTime: 2 }, {
    id, base, label: 'Library summaries', schema: z.object({ scheduledTime: z.number() }),
    report: z.object({ complete: z.literal(true), workspace: refSchema }), verifyReportWorkspace: true,
  })).rejects.toThrow('The Library summaries report pins a different workspace.');
  expect(put).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalledOnce();
});
