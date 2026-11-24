import type { DiscoverySource } from './discovery-sources';

export interface ResearchQuestion {
  id: 'apprenticeship';
  language: 'en' | 'fr';
  question: string;
  status: 'available' | 'partial' | 'unavailable';
  steps: { source: 'committees' | 'esdc'; instruction: string; request: string }[];
  missingSources: string[];
  limits: string;
}

export function apprenticeshipQuestions(sources: DiscoverySource[]): ResearchQuestion[] {
  return (['en', 'fr'] as const).map(language => {
    const french = language === 'fr';
    const steps: ResearchQuestion['steps'] = [];
    const missingSources: string[] = [];
    const edition = (id: string) => sources.find(source => source.id === id)?.editions.find(row =>
      row.language === language && (id !== 'committees' || row.scope === '45-1'));
    const committees = edition('committees');
    const funding = edition('esdc');
    if (committees) {
      steps.push({ source: 'committees', instruction: french ? 'Retrouver la recommandation dans les mémoires du Comité des finances.' :
        'Find the recommendation in submissions to the House Finance Committee.',
        request: committees.request + '&kind=brief&committeeId=house-fina' });
      steps.push({ source: 'committees', instruction: french ? 'Chercher d’autres témoignages et citer les intervenants.' :
        'Search testimony across committees and cite the speakers.',
        request: '/api/committees/search?' + new URLSearchParams({ session: committees.scope, language,
          kind: 'evidence', query: french ? 'apprentis formation' : 'apprenticeship training' }) });
    } else missingSources.push('committees');
    if (funding) {
      steps.push({ source: 'esdc', instruction: french ? 'Retrouver l’appel et consulter sa fiche par identifiant pour vérifier son statut et ses critères.' :
        'Find the call, then open its record by ID to verify intake status and eligibility.', request: funding.request });
    } else missingSources.push('esdc');
    return { id: 'apprenticeship', language, question: french
      ? 'Qui demande plus de places en apprentissage, et quels programmes fédéraux pourraient financer cette capacité?'
      : 'Who is asking for more apprenticeship training places, and which federal programs could fund that capacity?',
      status: !steps.length ? 'unavailable' : missingSources.length ? 'partial' : 'available',
      steps, missingSources, limits: french ? 'Distinguer les propositions, les critères publiés, les subventions accordées et les effets sur les listes d’attente. Les deux derniers exigent des preuves supplémentaires.' :
        'Distinguish proposals and published program terms from awards and measured changes in waitlists. The latter require separate evidence.' };
  });
}
