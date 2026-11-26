import { z } from 'zod';
import type { ProductClient } from './product';

export async function checkAccess(client: ProductClient, cutoff: string) {
  const denied = await client.request('/api/funding-programs/coverage?source=esdc', false);
  await denied.arrayBuffer();
  if (denied.status !== 401) throw new Error('Funding retrieval must require a workspace key.');
  const response = await client.request('/.well-known/civicsignal.json', false);
  if (!response.ok) throw new Error('Discovery unavailable.');
  const discovery = z.object({ sources: z.array(z.object({ id: z.string(), status: z.string(),
    editions: z.array(z.object({ language: z.string(), coverageThrough: z.string().optional() })) })),
    researchQuestions: z.array(z.object({ id: z.string(), language: z.string(), status: z.string() })) }).parse(await response.json());
  for (const id of ['consultations', 'committees', 'nserc', 'esdc']) {
    const source = discovery.sources.find(row => row.id === id);
    if (source?.status !== 'available' || !['en', 'fr'].every(lang => source.editions.some(e => e.language === lang &&
      (id !== 'committees' || Date.parse(e.coverageThrough ?? '') === Date.parse(cutoff))))) throw new Error('Missing verified discovery editions for ' + id);
  }
  for (const lang of ['en', 'fr']) {
    if (!discovery.researchQuestions.some(row => row.id === 'apprenticeship' && row.language === lang && row.status === 'available')) {
      throw new Error('Incomplete apprenticeship research instructions in ' + lang);
    }
  }
}
