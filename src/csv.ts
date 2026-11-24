export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

/**
 * Carries quote and line-ending state across arbitrarily split input chunks.
 *
 * A quote that is not followed by a delimiter, line break or end of input is
 * retained as text. This repairs the unescaped quotes found in publisher data.
 */
export class CsvParser {
  private row: string[] = [];
  private field = '';
  private quoted = false;
  private pendingQuote = false;
  private afterCR = false;

  private endRow(): string[] | undefined {
    this.row.push(this.field);
    const row = this.row;
    this.row = [];
    this.field = '';
    return row.length === 1 && row[0] === '' ? undefined : row;
  }

  *read(text: string): Generator<string[]> {
    for (const char of text) {
      if (this.afterCR) {
        this.afterCR = false;
        if (char === '\n') continue;
      }
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (char === '"') {
          this.field += '"';
          continue;
        }
        if (char !== ',' && char !== '\r' && char !== '\n') {
          this.field += '"' + char;
          continue;
        }
        this.quoted = false;
      }
      if (this.quoted) {
        if (char === '"') this.pendingQuote = true;
        else this.field += char;
        continue;
      }
      if (char === '"' && this.field === '') {
        this.quoted = true;
        continue;
      }
      if (char === ',') {
        this.row.push(this.field);
        this.field = '';
      } else if (char === '\r' || char === '\n') {
        this.afterCR = char === '\r';
        const row = this.endRow();
        if (row) yield row;
      } else this.field += char;
    }
  }

  *finish(): Generator<string[]> {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.quoted = false;
    }
    if (this.quoted) throw new CsvError('unterminated quoted field at end of file');
    const row = this.endRow();
    if (row) yield row;
  }
}

/** Parse complete UTF-8 CSV text, including a possible leading BOM. */
export function parseCsvText(text: string): string[][] {
  const parser = new CsvParser();
  const input = text.replace(/^\uFEFF/, '');
  return [...parser.read(input), ...parser.finish()];
}
