/** buildRows emits a numbered-section page only for a real numeric Section.
 * Legacy general provisions can share its ordinal label and have FullText URLs.
 * Prefer that source distinction before LIMIT; headings and in-force status do
 * not establish whether a row is the section the caller named. */
const CANONICAL_SECTION_URL = ` AND source_url IN (
  'https://laws-lois.justice.gc.ca/en/acts/' || citation || '/section-' || section || '.html',
  'https://laws-lois.justice.gc.ca/en/regulations/' || citation || '/section-' || section || '.html',
  'https://laws-lois.justice.gc.ca/fr/lois/' || replace(citation, ',', '%2C') || '/section-' || section || '.html',
  'https://laws-lois.justice.gc.ca/fr/reglements/' || replace(citation, ',', '%2C') || '/section-' || section || '.html'
)`;

export async function loadExactProvisionRows(section: string,
  load: (additionalWhere: string) => Promise<Record<string, unknown>[]>): Promise<Record<string, unknown>[]> {
  if (/^[0-9]+(\.[0-9]+)?$/.test(section)) {
    const canonical = await load(CANONICAL_SECTION_URL);
    if (canonical.length) return canonical;
  }
  // Lettered, schedule and noncanonical/amending provisions remain resolvable.
  return load('');
}
