import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {parseCitation} from '@chester-hill-solutions/corpus';
import raw from '../src/eval/data/v1-successor-questions.json';
import priorRaw from '../src/eval/data/v1-questions.json';
import {QUESTIONS,UNANSWERABLE_QUESTIONS} from '../src/eval/questions';
import {eligibleQuestions,goldRank,scoreV1,validateV1Dataset,type V1Dataset,type V1Observation,type V1Question} from '../src/eval/v1';
import {inputDataset,selection} from '../src/eval/v1-cli';
import {verifyLabelSources} from '../src/eval/v1-source';
import {buildRows,parseStatuteXml} from '../src/ingest/statutes';
import {SNAPSHOT_PARSER_VERSION} from '../src/ingest/snapshot-format';

const dataset=validateV1Dataset(raw),prior=validateV1Dataset(priorRaw);
const revision='0507465393c224c0491fc8c17c88340217acc656';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const normalized=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('en-CA').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
const positives=dataset.questions.filter(q=>q.answerable),negatives=dataset.questions.filter(q=>!q.answerable);
const observation=(q:V1Question):V1Observation=>({id:q.id,outcome:'ok',elapsedMs:1,items:q.gold?[{id:q.gold.rowIds[0]!,language:q.language}]:[]});
const priorIds=new Set([...prior.questions,...QUESTIONS,...UNANSWERABLE_QUESTIONS].map(q=>q.id));
const priorText=new Set([...prior.questions,...QUESTIONS,...UNANSWERABLE_QUESTIONS].map(q=>normalized(q.question)));
const knownActs=[...new Set([...positives,...prior.questions].flatMap(q=>q.gold?[q.gold.act]:[]).concat(QUESTIONS.map(q=>q.act)))];
const expectedActs=['A-2','B-3','C-1.68','C-10.4','C-15.31','C-44','C-5','E-5.401','F-11','F-14','I-21','P-8.6'];

// These are unchanged Section XML excerpts from the pinned I-21 English/French
// blobs, in small instrument wrappers. They test the real parser and verifier
// seam portably. They do NOT stand in for complete original-blob verification;
// the separate --dataset/--verify-only run checks all 24 original XML blobs.
const parserFixtures = [
  {
    "language": "en",
    "sourcePath": "eng/acts/I-21.xml",
    "xml": "<Statute in-force=\"yes\" xmlns:lims=\"http://justice.gc.ca/lims\"><Identification><ShortTitle>Interpretation Act</ShortTitle><Chapter><ConsolidatedNumber>I-21</ConsolidatedNumber></Chapter></Identification><Body><Section lims:inforce-start-date=\"2002-12-31\" lims:lastAmendedDate=\"2002-12-31\" lims:fid=\"279254\" lims:id=\"279254\"><MarginalNote lims:inforce-start-date=\"2002-12-31\" lims:fid=\"279255\" lims:id=\"279255\">Enactments deemed remedial</MarginalNote><Label>12</Label><Text>Every enactment is deemed remedial, and shall be given such fair, large and liberal construction and interpretation as best ensures the attainment of its objects.</Text><HistoricalNote><HistoricalNoteSubItem lims:inforce-start-date=\"2002-12-31\" lims:fid=\"279257\" lims:id=\"279257\">R.S., c. I-23, s. 11</HistoricalNoteSubItem></HistoricalNote></Section><Section lims:inforce-start-date=\"2002-12-31\" lims:lastAmendedDate=\"2002-12-31\" lims:fid=\"279383\" lims:id=\"279383\"><MarginalNote lims:inforce-start-date=\"2002-12-31\" lims:fid=\"279384\" lims:id=\"279384\">Time limits and holidays</MarginalNote><Label>26</Label><Text>Where the time limited for the doing of a thing expires or falls on a holiday, the thing may be done on the day next following that is not a holiday.</Text><HistoricalNote><HistoricalNoteSubItem lims:inforce-start-date=\"2002-12-31\" lims:fid=\"279386\" lims:id=\"279386\">R.S., 1985, c. I-21, s. 26; 1999, c. 31, s. 147(F)</HistoricalNoteSubItem></HistoricalNote></Section></Body></Statute>"
  },
  {
    "language": "fr",
    "sourcePath": "fra/lois/I-21.xml",
    "xml": "<Statute in-force=\"yes\" xmlns:lims=\"http://justice.gc.ca/lims\"><Identification><ShortTitle>Loi d’interprétation</ShortTitle><Chapter><ConsolidatedNumber>I-21</ConsolidatedNumber></Chapter></Identification><Body><Section lims:inforce-start-date=\"2002-12-31\" lims:lastAmendedDate=\"2002-12-31\" lims:fid=\"272479\" lims:id=\"272479\"><MarginalNote lims:inforce-start-date=\"2002-12-31\" lims:fid=\"272480\" lims:id=\"272480\">Principe et interprétation</MarginalNote><Label>12</Label><Text>Tout texte est censé apporter une solution de droit et s’interprète de la manière la plus équitable et la plus large qui soit compatible avec la réalisation de son objet.</Text><HistoricalNote><HistoricalNoteSubItem lims:inforce-start-date=\"2002-12-31\" lims:fid=\"272482\" lims:id=\"272482\">S.R., ch. I-23, art. 11</HistoricalNoteSubItem></HistoricalNote></Section><Section lims:inforce-start-date=\"2002-12-31\" lims:lastAmendedDate=\"2002-12-31\" lims:fid=\"272605\" lims:id=\"272605\"><MarginalNote lims:inforce-start-date=\"2002-12-31\" lims:fid=\"272606\" lims:id=\"272606\">Jour férié</MarginalNote><Label>26</Label><Text>Tout acte ou formalité peut être accompli le premier jour ouvrable suivant lorsque le délai fixé pour son accomplissement expire un jour férié.</Text><HistoricalNote><HistoricalNoteSubItem lims:inforce-start-date=\"2002-12-31\" lims:fid=\"272608\" lims:id=\"272608\">L.R. (1985), ch. I-21, art. 26; 1999, ch. 31, art. 147(F)</HistoricalNoteSubItem></HistoricalNote></Section></Body></Statute>"
  }
] as const;

describe('separate successor serving holdout',()=>{
 it('keeps the original bundled runner dataset and historical parsed digest unchanged',()=>{
  const original=inputDataset();expect(original.dataset.version).toBe('v1-2026-10-22');expect(original.datasetSha256).toBe('5947e2417cebd4883df368a4aeca1dccdb79bd0329056155d7420016431f8cf9');
  expect(original.dataset.questions).toHaveLength(86);expect(dataset.version).toBe('v1-successor-2026-10-31');expect(dataset.revision).toBe(revision);expect(SNAPSHOT_PARSER_VERSION).toBe('statutes-v2');
 });
 it('contains 24 new provision pairs in 12 Acts and eight unsupported source pairs, all held out',()=>{
  expect(dataset.questions).toHaveLength(64);expect(positives).toHaveLength(48);expect(negatives).toHaveLength(16);
  expect(new Set(positives.map(q=>q.pairId)).size).toBe(24);expect(new Set(negatives.map(q=>q.pairId)).size).toBe(8);
  expect([...new Set(positives.map(q=>q.group.slice(4)))].sort()).toEqual(expectedActs);
  expect(new Set(positives.flatMap(q=>q.gold!.rowIds)).size).toBe(48);expect(new Set(positives.map(q=>q.provenance.sourcePath)).size).toBe(24);
  expect(dataset.questions.every(q=>q.split==='holdout'&&q.status!=='unverified')).toBe(true);
  for(const group of expectedActs)expect(positives.filter(q=>q.group==='act:'+group)).toHaveLength(4);
 });
 it('keeps prior IDs, pair IDs, gold rows, Act groups, Act titles and normalized question text disjoint',()=>{
  const priorPairs=new Set(prior.questions.map(q=>q.pairId)),priorRows=new Set(prior.questions.flatMap(q=>q.gold?.rowIds??[]));
  const priorGroups=new Set(prior.questions.map(q=>q.group)),priorActs=new Set([...prior.questions.flatMap(q=>q.gold?[q.gold.act]:[]),...QUESTIONS.map(q=>q.act)].map(normalized));
  for(const q of dataset.questions){expect(priorIds.has(q.id),q.id).toBe(false);expect(priorPairs.has(q.pairId),q.pairId).toBe(false);expect(priorText.has(normalized(q.question)),q.id).toBe(false);expect(priorGroups.has(q.group),q.group).toBe(false);}
  for(const q of positives){expect(priorActs.has(normalized(q.gold!.act)),q.gold!.act).toBe(false);for(const id of q.gold!.rowIds)expect(priorRows.has(id),id).toBe(false);}
 });
 it('uses the actual shared citation parser to keep every positive on the semantic question path',()=>{
  for(const q of positives)expect(parseCitation(q.question,knownActs),q.id).toBeNull();
 });
 it('keeps both language versions of every scope and source label together',()=>{
  const pairs=new Map<string,V1Question[]>();for(const q of dataset.questions)pairs.set(q.pairId,[...(pairs.get(q.pairId)??[]),q]);
  for(const pair of pairs.values()){
   expect(pair).toHaveLength(2);expect(pair.map(q=>q.language).sort()).toEqual(['en','fr']);
   expect(new Set(pair.map(q=>`${q.group}:${q.split}:${q.answerable}:${q.status}:${q.provenance.kind}`)).size).toBe(1);
   expect(pair[0]!.question).not.toBe(pair[1]!.question);
   if(pair[0]!.answerable){expect(pair[0]!.gold!.section).toBe(pair[1]!.gold!.section);expect(pair[0]!.gold!.rowIds).not.toEqual(pair[1]!.gold!.rowIds);expect(pair[0]!.provenance.sourceSha256).not.toBe(pair[1]!.provenance.sourceSha256);}
   else expect(pair[0]!.provenance.evidence).toBe(pair[1]!.provenance.evidence);
  }
 });
 it('pins positive source URLs, blob/text digests, languages and the distinct instrument identity',()=>{
  for(const q of positives){
   expect(q.status).toBe('verified-source');expect(q.provenance.kind).toBe('corpus-provision');expect(q.provenance.revision).toBe(revision);expect(q.gold!.rowIds).toHaveLength(1);expect(q.gold!.rowIds[0]).toMatch(new RegExp(`^acts-${q.language}-[0-9]+$`));
   const path=`${q.language==='en'?'eng/acts':'fra/lois'}/${q.group.slice(4)}.xml`;expect(q.provenance.sourcePath).toBe(path);expect(q.provenance.sourceUrl).toBe(`${dataset.sourceRepository}/blob/${revision}/${path}`);
   expect(q.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/);expect(q.provenance.rowSha256).toMatch(/^[a-f0-9]{64}$/);expect(q.provenance.evidence.length).toBeGreaterThan(40);expect(q.provenance.annotation).toContain('Headed in-force Section');expect(q.provenance.annotation).toContain('no hosted execution');
  }
 });
 it('labels negative questions by the explicitly requested source in both languages, not inferred legal absence',()=>{
  const markers:Record<string,[string,string]>={
   'nz-tenancies':['New Zealand','Nouvelle-Zélande'],'eu-digital-services':['European Union','Union européenne'],'bc-meal-breaks':['British Columbia','Colombie-Britannique'],'calgary-noise-bylaw':['municipal bylaw','règlement municipal'],'roncarelli-reasons':['judicial reasons','motifs judiciaires'],'c18-hansard-passage':['Hansard','hansard'],'c11-recorded-division':['parliamentary voting record','relevé parlementaire du vote'],'election-newspaper':['newspaper article','article du journal'],
  };
  for(const q of negatives){const slug=q.group.replace('successor-scope:',''),pair=markers[slug]!;expect(pair,q.id).toBeDefined();expect(q.question).toContain(pair[q.language==='en'?0:1]);expect(q.gold).toBeUndefined();expect(q.status).toBe('verified-scope');expect(q.provenance.kind).toBe('scope-exclusion');expect(q.provenance.revision).toBeUndefined();expect(q.provenance.sourceSha256).toBeUndefined();expect(q.provenance.annotation).toContain('No external-law, administrative-amount, source-content, legal-applicability or generated-answer finding');}
 });
 it('requires explicit successor selection and cannot supply calibration observations',()=>{
  expect(eligibleQuestions(dataset,revision,'holdout').eligible).toHaveLength(64);expect(selection(dataset,revision,'holdout').eligible).toHaveLength(64);expect(()=>selection(dataset,revision,'calibration')).toThrow('both answerability classes');
  expect(inputDataset().dataset.version).not.toBe(dataset.version);
 });
 it('excludes all positive labels at another source revision while retaining the scope controls',()=>{
  const selected=eligibleQuestions(dataset,'f'.repeat(40));expect(selected.eligible).toHaveLength(16);expect(selected.eligible.every(q=>!q.answerable)).toBe(true);expect(selected.excluded).toHaveLength(48);expect(selected.excluded.every(q=>q.reason==='label source revision differs from target corpus')).toBe(true);
 });
});

describe('successor denominator contract, with synthetic observations only',()=>{
 it('counts the entire frozen selection and bilingual pairs without manufacturing completion',()=>{
  const r=scoreV1(dataset.questions,[]);expect(r.overall).toMatchObject({planned:64,attempted:0,completed:0,missing:64,answerable:48,unanswerable:16,hitAt5:{numerator:0,denominator:48,value:0},falseAcceptance:{numerator:0,denominator:0,value:null}});
  for(const language of ['en','fr'] as const)expect(r.byLanguage[language]).toMatchObject({planned:32,answerable:24,unanswerable:8});expect(r.paired.answerablePairs).toBe(24);expect(r.paired.bothHitAt5.denominator).toBe(24);
 });
 it('uses exact expected denominators for deterministic gold fixtures, not live-quality evidence',()=>{
  const r=scoreV1(dataset.questions,dataset.questions.map(observation));expect(r.overall.hitAt5).toEqual({numerator:48,denominator:48,value:1});expect(r.overall.falseAcceptance).toEqual({numerator:0,denominator:16,value:0});expect(r.paired.bothHitAt5).toEqual({numerator:24,denominator:24,value:1});
 });
 it('keeps failed/missing positives in hit denominators and outside completed refusal denominators',()=>{
  const en=positives[0]!,fr=positives.find(q=>q.pairId===en.pairId&&q.language==='fr')!,unsupported=negatives[0]!;
  const observations=dataset.questions.filter(q=>q.id!==fr.id).map(q=>q.id===en.id?{...observation(q),outcome:'http-error' as const,status:503,items:[]}:q.id===unsupported.id?{...observation(q),items:[{id:'distractor',language:q.language}]}:observation(q));
  const r=scoreV1(dataset.questions,observations);expect(r.overall).toMatchObject({planned:64,attempted:63,completed:62,missing:1,requestErrors:1});expect(r.overall.hitAt5).toEqual({numerator:46,denominator:48,value:46/48});expect(r.overall.falseRejection).toEqual({numerator:0,denominator:46,value:0});expect(r.overall.falseAcceptance).toEqual({numerator:1,denominator:16,value:1/16});expect(r.paired.bothHitAt5.numerator).toBe(23);
 });
 it('rejects old observation IDs and treats the right ID in the wrong language as a miss',()=>{
  expect(()=>scoreV1(dataset.questions,[{...observation(positives[0]!),id:prior.questions[0]!.id}])).toThrow('Unexpected observation');const q=positives[0]!;expect(goldRank(q,{...observation(q),items:[{id:q.gold!.rowIds[0]!,language:'fr'}]})).toBeNull();
 });
});

describe('pinned real Section excerpts through parser and immutable source verifier',()=>{
 let directory:string,fixture:V1Dataset;const env={PATH:process.env.PATH??'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
 const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-C',directory,...args],{encoding:'utf8',env,stdio:['ignore','pipe','pipe']}).trim();
 beforeAll(()=>{
  directory=mkdtempSync(join(tmpdir(),'civic-successor-source-'));git(['init','--quiet']);
  for(const entry of parserFixtures){const path=join(directory,entry.sourcePath);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,entry.xml);}
  git(['add','eng','fra']);git(['commit','--quiet','-m','Synthetic wrappers around pinned real Section excerpts']);const fixtureRevision=git(['rev-parse','HEAD']);
  fixture=validateV1Dataset({...dataset,version:'synthetic-successor-parser-seam',revision:fixtureRevision,questions:dataset.questions.filter(q=>q.group==='act:I-21').map(q=>{const entry=parserFixtures.find(x=>x.language===q.language)!;return {...q,provenance:{...q.provenance,revision:fixtureRevision,sourceSha256:sha(entry.xml),sourceUrl:`https://fixture.invalid/${fixtureRevision}/${entry.sourcePath}`}};})});
 });
 afterAll(()=>{if(directory)rmSync(directory,{recursive:true,force:true});});
 it('reproduces the actual gold IDs, headings, status, text hashes and evidence in both languages',()=>{
  for(const entry of parserFixtures){const parsed=parseStatuteXml(entry.xml)!;expect(parsed.inForce).toBe(true);const rows=buildRows(parsed,{kind:'acts',language:entry.language});const questions=positives.filter(q=>q.group==='act:I-21'&&q.language===entry.language);expect(rows).toHaveLength(2);
   for(const q of questions){const row=rows.find(row=>row.id===q.gold!.rowIds[0])!;expect(row).toBeDefined();expect(row).toMatchObject({act:q.gold!.act,section:q.gold!.section,status:'in-force',in_force:1,language:q.language,schedule:null,part:null});expect(row.heading).toBeTruthy();expect(q.provenance.annotation).toContain(row.heading!);expect(row.source_url).toContain(`/section-${q.gold!.section}.html`);expect(sha(row.text)).toBe(q.provenance.rowSha256);expect(row.text).toContain(q.provenance.evidence);expect(parsed.units.find(unit=>unit.anchor===row.id.split('-').at(-1))?.kind).toBe('section');}
  }
 });
 it('reuses the real verifier on committed fixture blobs and ignores later checkout changes',()=>{
  const result=verifyLabelSources(fixture,directory);expect(result).toMatchObject({parserVersion:'statutes-v2',sourceBlobs:2,rejected:[]});expect(result.verified).toHaveLength(4);
  writeFileSync(join(directory,parserFixtures[0]!.sourcePath),'Working-tree tamper must not supply labels.');expect(verifyLabelSources(fixture,directory)).toEqual(result);
 });
 it.each(['source-digest','row-digest','row-id','act','section','evidence'] as const)('refuses a mismatched %s at the existing source-verification seam',kind=>{
  const changed=structuredClone(fixture),q=changed.questions[0]!;
  if(kind==='source-digest')q.provenance.sourceSha256='f'.repeat(64);else if(kind==='row-digest')q.provenance.rowSha256='f'.repeat(64);else if(kind==='row-id')q.gold!.rowIds=['acts-en-missing'];else if(kind==='act')q.gold!.act='Wrong Act';else if(kind==='section')q.gold!.section='999';else q.provenance.evidence='Evidence absent from the pinned provision.';
  const result=verifyLabelSources(changed,directory);expect(result.rejected.map(q=>q.id)).toContain(q.id);expect(result.verified).not.toContain(q.id);
 });
});
