import { WorkerEntrypoint } from 'cloudflare:workers';
import { checkHousePacket, type HouseServingEnv, type HouseServingInput } from './house-calls';
import { metered, type ProductEnv } from './product';

export class HouseServingCheck extends WorkerEntrypoint<ProductEnv & HouseServingEnv> {
  async verify(input: HouseServingInput) {
    const { result, requests, before, after } = await metered(this.env, read => checkHousePacket(read, this.env, input));
    return { ...result, usage: { before, after, retrievals: requests.length }, correlationIds: requests.map(request => request.correlationId) };
  }
}
