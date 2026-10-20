import { GitHubCorpusSource, INSTRUMENT_PATHS, FRENCH_INSTRUMENT_PATHS } from './src/ingest/source';
import { parseStatuteXml, buildRows } from './src/ingest/statutes';
const source = new GitHubCorpusSource();
const started = Date.now();
const head = await source.head();
process.stderr.write(`  head: ${head.commit.slice(0, 9)} (${head.date}) in ${Date.now() - started} ms\n`);
for (const [label, paths] of [['english', INSTRUMENT_PATHS], ['french', FRENCH_INSTRUMENT_PATHS]] as const) {
  const t0 = Date.now();
  let files = 0, provisions = 0, bytes = 0;
  for await (const file of source.instruments(head.commit, paths)) {
    files++; bytes += file.content.length;
    const stem = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.xml$/, '');
    const kind = file.path.includes('regulations/') || file.path.includes('reglements/') ? 'regulations' : 'acts';
    const language = file.path.startsWith('fra/') ? 'fr' : 'en';
    const parsed = parseStatuteXml(file.content, { citation: kind === 'regulations' ? stem : undefined });
    if (!parsed) continue;
    provisions += buildRows(parsed, { kind, language }).length;
  }
  process.stderr.write(`  ${label}: ${files} file(s), ${Math.round(bytes / 1048576)} MB -> ${provisions} provision(s) in ${Math.round((Date.now() - t0) / 1000)} s\n`);
}
process.stderr.write(`  total ${Math.round((Date.now() - started) / 1000)} s\n`);
process.exit(0);
