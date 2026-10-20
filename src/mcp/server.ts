import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildBrief, type BriefRequest } from '../routes/brief';
import { CORPUSES_BY_ID } from '../corpora/registry';
import { emitCorpusItem } from "@chester-hill-solutions/corpus";
import { policyFor } from '../corpora/policies';
import type { CorpusContext, Scope } from '../corpora/types';
import type { Env } from '../types';

/**
 * The MCP surface.
 *
 * Three tools, deliberately. The tool schemas are the most expensive thing an agent
 * pays for — Cloudflare's own MCP server uses search-and-execute Code Mode because
 * 2,594 native tools cost ~1.17M tokens against ~1,000 for two — so a small,
 * non-colliding surface is a feature, not a limitation.
 *
 * Each tool returns one complete answer. There is no "search then fetch" round trip.
 */

export interface CivicSignalMcpOptions {
  request: Request;
  env: Env;
  ctx: CorpusContext;
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function corpusContext(env: Env, request: Request): CorpusContext {
  return {
    db: env.CIVIC_DB,
    fetch,
    now: () => new Date(),
  };
}

export function createCivicSignalMcpHandler(options: CivicSignalMcpOptions) {
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: 'CivicSignal', version: '0.1.0' },
      {
        instructions:
          'Situational awareness for Canada. Ask about any topic and you get what is in the news, how tone in coverage is moving, ' +
          'which statutes are in force, what is proposed, and what Parliament has said — each item cited to its official source. ' +
          'Debates are quoted as short excerpts with citations, never republished in full. ' +
          'News is headline and link only. Statutes are reproduced under the Open Government Licence - Canada.',
      },
    );

    server.registerTool(
      'brief_topic',
      {
        title: 'Brief a topic in Canada',
        description:
          'One call: what is in the news about a topic, how coverage tone is trending, which statutes are in force, what bills are moving, ' +
          'and what Parliament has said. Every item carries a link to its official source. ' +
          'Use this for "what is happening with X in Canada" questions.',
        inputSchema: z.object({
          topic: z.string().min(1).max(200).describe('The topic, e.g. "housing", "pharmacare", "clean electricity".'),
          keywords: z.array(z.string().min(1).max(80)).max(8).optional().describe('Additional terms that must also match.'),
          jurisdiction: z.string().min(2).max(40).optional().describe('Province or territory code, e.g. "ON", "BC", "QC".'),
          riding: z.string().min(2).max(40).optional().describe('Federal or provincial riding code.'),
          scope_type: z
            .enum(['topic', 'riding', 'municipality', 'jurisdiction', 'region'])
            .optional()
            .describe(
              'How to frame the question geographically. Defaults to "topic". Use "riding" with scope_code, ' +
                '"jurisdiction" with scope_code (e.g. "ON"), "municipality" with scope_name, or "region" with scope_name. ' +
                'The brief also reports where the topic is live across Canada, whichever scope you choose.',
            ),
          scope_code: z.string().min(1).max(40).optional().describe('Riding code or province code for the scope.'),
          scope_name: z.string().min(1).max(120).optional().describe('Municipality or region name for the scope.'),
          since: z.string().min(4).max(30).optional().describe('ISO date, inclusive.'),
          until: z.string().min(4).max(30).optional().describe('ISO date, inclusive.'),
          limit: z.number().int().min(1).max(100).optional().describe('Maximum items per section (default 25).'),
        }),
        outputSchema: z.object({
          summary: z.string(),
          result: z.record(z.string(), z.unknown()),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const request: BriefRequest = {
          topic: args.topic,
          keywords: args.keywords,
          jurisdiction: args.jurisdiction,
          riding: args.riding,
          since: args.since,
          until: args.until,
          limit: args.limit,
          scope: scopeFromArgs(args.scope_type, args.scope_code, args.scope_name),
        };
        const brief = await buildBrief(request, options.ctx);
        return {
          structuredContent: {
            summary: summarise(brief),
            result: brief as unknown as Record<string, unknown>,
          },
          ...text(brief),
        };
      },
    );

    server.registerTool(
      'statute_lookup',
      {
        title: 'Look up Canadian statutes in force',
        description:
          'Search federal (and, where indexed, provincial) statutes and regulations by topic or keyword. ' +
          'Returns section text with a link to the official source. Reproduced under the Open Government Licence - Canada; ' +
          'not an official version of the law.',
        inputSchema: z.object({
          topic: z.string().min(1).max(200).describe('Topic or keyword to search for.'),
          keywords: z.array(z.string().min(1).max(80)).max(8).optional().describe('Additional terms that must also match.'),
          jurisdiction: z.string().min(2).max(40).optional().describe('Province or territory code.'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum sections to return (default 25).'),
        }),
        outputSchema: z.object({
          summary: z.string(),
          result: z.record(z.string(), z.unknown()),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const corpus = CORPUSES_BY_ID.get('statutes-canada');
        if (!corpus) return { isError: true, ...text({ error: 'Statute corpus unavailable.' }) };
        const raw = await corpus.retrieve(
          {
            topic: args.topic,
            keywords: args.keywords,
            jurisdiction: args.jurisdiction,
            limit: args.limit,
          },
          options.ctx,
        );
        const policy = policyFor(corpus.id);
        const items = policy ? raw.map((r) => emitCorpusItem(policy, r)) : [];
        return {
          structuredContent: {
            summary: `${items.length} section(s) matching "${args.topic}".`,
            result: { items, attribution: policy?.attribution ?? '' },
          },
          ...text({ items, attribution: policy?.attribution ?? '' }),
        };
      },
    );

    server.registerTool(
      'debate_citations',
      {
        title: 'Find what Parliament said about a topic',
        description:
          'Search House of Commons debates for a topic and return short quoted excerpts with the speaker, the sitting date and a link to the official Hansard record. ' +
          'The corpus is Crown copyright: passages are cited, not republished.',
        inputSchema: z.object({
          topic: z.string().min(1).max(200).describe('Topic or keyword to search for.'),
          keywords: z.array(z.string().min(1).max(80)).max(8).optional().describe('Additional terms that must also match.'),
          since: z.string().min(4).max(30).optional().describe('ISO date, inclusive.'),
          until: z.string().min(4).max(30).optional().describe('ISO date, inclusive.'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum passages to return (default 25).'),
        }),
        outputSchema: z.object({
          summary: z.string(),
          result: z.record(z.string(), z.unknown()),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const corpus = CORPUSES_BY_ID.get('hansard-federal');
        if (!corpus) return { isError: true, ...text({ error: 'Debate corpus unavailable.' }) };
        const raw = await corpus.retrieve(
          {
            topic: args.topic,
            keywords: args.keywords,
            since: args.since,
            until: args.until,
            limit: args.limit,
          },
          options.ctx,
        );
        const policy = policyFor(corpus.id);
        const items = policy ? raw.map((r) => emitCorpusItem(policy, r)) : [];
        return {
          structuredContent: {
            summary: `${items.length} passage(s) matching "${args.topic}".`,
            result: { items, attribution: policy?.attribution ?? '' },
          },
          ...text({ items, attribution: policy?.attribution ?? '' }),
        };
      },
    );

    return server;
  });
}

/**
 * Build a scope from the flat tool arguments.
 *
 * MCP clients get flat parameters rather than a nested object, so the scope is
 * expressed as a type plus whichever of code or name it needs.
 */
function scopeFromArgs(
  type: 'topic' | 'riding' | 'municipality' | 'jurisdiction' | 'region' | undefined,
  code: string | undefined,
  name: string | undefined,
): Scope | undefined {
  if (!type) return undefined;
  switch (type) {
    case 'topic':
      return { type: 'topic' };
    case 'riding':
      return code ? { type: 'riding', code: code.toUpperCase() } : undefined;
    case 'jurisdiction':
      return code ? { type: 'jurisdiction', code: code.toUpperCase() } : undefined;
    case 'municipality':
      return name ? { type: 'municipality', name } : undefined;
    case 'region':
      return name ? { type: 'region', name } : undefined;
    default:
      return undefined;
  }
}

function summarise(brief: {  news: unknown[];
  debate: unknown[];
  legislation: unknown[];
  bills: unknown[];
  sentiment: { mean: number | null; volume: number };
}): string {
  const parts: string[] = [];
  parts.push(`${brief.news.length} news item(s)`);
  parts.push(`${brief.debate.length} debate passage(s)`);
  parts.push(`${brief.legislation.length} statute section(s)`);
  parts.push(`${brief.bills.length} bill(s)`);
  if (brief.sentiment.volume > 0) {
    parts.push(`mean coverage tone ${brief.sentiment.mean ?? 'n/a'} over ${brief.sentiment.volume} item(s)`);
  }
  return parts.join(', ');
}
