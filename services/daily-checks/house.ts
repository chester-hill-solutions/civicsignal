import { WorkerEntrypoint } from 'cloudflare:workers';
import { checkHouseLanguage, requireMatch } from './house-calls';
import { inventoryReference, readVerified, type PacketRef } from '../house/archive';
import { HousePacket } from '../house/publish';
import { metered, type ProductEnv } from './product';

interface Env extends ProductEnv { ARCHIVE: R2Bucket; COMMITTEE_DB: D1Database }
export class HouseServingCheck extends WorkerEntrypoint<Env> {
  async verify(input: { observedAt: string; cutoff: string; packetRef: PacketRef }) {
    const ref = inventoryReference(input.packetRef);
    const bytes = await readVerified(this.env.ARCHIVE, ref);
    const packet = HousePacket.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
    requireMatch(packet.observedAt === input.observedAt, 'packet observation differs from publication');
    const asOf = new Date(input.observedAt).toISOString();
    const seal = () => this.env.COMMITTEE_DB.prepare("SELECT cutoff FROM cc_snapshot WHERE session='45-1'").first<string>('cutoff');
    requireMatch(await seal() === input.cutoff, 'published cutoff has moved');
    const { result, requests, before, after } = await metered(this.env, async read => {
      const out = [];
      for (const language of ['en', 'fr'] as const) {
        out.push(await checkHouseLanguage(read, this.env.COMMITTEE_DB, packet.calls.filter(row => row.language === language), language, asOf));
      }
      return out;
    });
    requireMatch(await seal() === input.cutoff, 'cutoff changed during product reads');
    return { observedAt: input.observedAt, cutoff: input.cutoff, packetSha256: ref.sha256, languages: result,
      usage: { before, after, retrievals: requests.length }, correlationIds: requests.map(request => request.correlationId) };
  }
}
