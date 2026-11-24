import { describe, expect, it } from 'vitest';
import { splitWrittenQuestionText } from '../scripts/materialize-written-questions';

describe('local written-question D1 materialization SQL', () => {
  it('keeps every character in bounded display chunks and overlaps search boundaries', () => {
    const source = `${'alpha 😀 '.repeat(1400)}Unique token at late page. ${'omega 😀 '.repeat(1600)}`;
    const chunks = [...splitWrittenQuestionText(source)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => [...chunk.text].length <= 8192 && [...chunk.searchText].length <= 8256)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
    expect(chunks.some((chunk) => chunk.searchText.includes('Unique token at late page.'))).toBe(true);
  });
});
