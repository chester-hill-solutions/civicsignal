#!/usr/bin/env bun
/**
 * Check prose against the two rules a machine can test.
 *
 * ASD-STE100 has many rules and most of them need a reader. Two do not: a
 * sentence has a maximum length, and the passive voice is not permitted. This
 * finds those two, and it reports a count for each file. It does not correct
 * anything.
 *
 *     bun scripts/check-prose.ts docs/WRITING.md
 *     bun scripts/check-prose.ts docs/*.md
 */
import { readFileSync } from 'node:fs';

const MAX_WORDS = 25;
/** The passive voice: a form of "to be" and a past participle. */
const PASSIVE =
  /\b(is|are|was|were|be|been|being)\s+(\w+ed|written|made|given|taken|shown|found|held|sent|read|built|kept|left|put|set|run|done|seen|known|chosen|drawn|grown|thrown)\b/gi;

/** The text of a markdown file, without the parts that are not prose. */
function prose(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inCode = false;
  text.split('\n').forEach((raw, at) => {
    if (raw.trimStart().startsWith('```')) {
      inCode = !inCode;
      return;
    }
    if (inCode) return;
    if (/^\s*[|>#*-]/.test(raw)) return;
    if (raw.trim() === '') return;
    out.push({ line: at + 1, text: raw });
  });
  return out;
}

function sentences(text: string): string[] {
  return text
    .replace(/`[^`]*`/g, ' code ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

let longTotal = 0;
let passiveTotal = 0;

for (const path of process.argv.slice(2)) {
  const lines = prose(readFileSync(path, 'utf8'));
  let long = 0;
  let passive = 0;

  for (const { line, text } of lines) {
    for (const sentence of sentences(text)) {
      const words = sentence.split(/\s+/).filter((word) => word.length > 0);
      if (words.length > MAX_WORDS) {
        long++;
        console.log(`${path}:${line}  ${words.length} words  ${sentence.slice(0, 80)}`);
      }
      const found = sentence.match(PASSIVE);
      if (found) {
        passive += found.length;
        console.log(`${path}:${line}  passive  ${sentence.slice(0, 80)}`);
      }
    }
  }
  longTotal += long;
  passiveTotal += passive;
  console.log(`${path}: ${long} long sentence(s), ${passive} passive construction(s)`);
}

console.log(`\n${longTotal} long sentence(s) and ${passiveTotal} passive construction(s) in total`);
console.log(`the limit is ${MAX_WORDS} words for a description and 20 for a procedure`);
if (longTotal === 0 && passiveTotal === 0) {
  console.log('the checked files obey the two rules that a machine can test');
} else {
  process.exit(1);
}
