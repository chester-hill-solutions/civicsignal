import type { Capabilities } from './capabilities';
import { landingPageResponse } from './landing-page';

export function agentLandingResponse(correlationId: string, capabilities: Capabilities): Response {
  const sources = capabilities.sources.flatMap(source => source.status === 'available' && source.openapi
    ? [{ path: source.openapi, label: source.name }] : []);
  return landingPageResponse(correlationId, {
    discovery: { instructions: '/llms.txt', capabilities: '/.well-known/civicsignal.json' },
    sourcePreviews: sources,
  });
}
