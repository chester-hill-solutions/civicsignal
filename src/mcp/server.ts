import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildBrief, type BriefRequest, type BriefResponse } from '../routes/brief';
import { readStatuteChanges } from '../routes/changes';
import { loadCorpusAvailability, UnsupportedCoverageError } from '../corpora/registry';
import { RequestInputError } from '../http';
import { BillableDenied } from '../metering';
import { citeProvision } from './cite';
import type { CorpusContext } from '../corpora/types';
import type { Env } from '../types';
import { observeRetrievalContext, type RetrievalObservation } from '../corpora/retrieval-observation';

export interface CivicSignalMcpOptions {
  request: Request;
  env: Env;
  ctx: CorpusContext;
  /** Required: the authenticated entry point authorizes and meters successful work. */
  runRetrieval: <T>(work: () => Promise<T>) => Promise<T>;
}

function result(data: object, summary: string) {
  return {
    structuredContent: { summary, result: data as Record<string, unknown> },
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const outputSchema = z.object({ summary: z.string(), result: z.record(z.string(), z.unknown()) });
const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const topic = z.string().trim().min(1).max(4_000);
const keywords = z.array(z.string().trim().min(1).max(80)).max(8).optional();
const language = z.enum(['en', 'fr']).optional().describe('Official language wanted; inferred from the question when absent.');

async function runTool(options: CivicSignalMcpOptions, work: (context: CorpusContext, retrieval: RetrievalObservation[]) => Promise<ReturnType<typeof result>>): Promise<ReturnType<typeof result> & { isError?: boolean }> {
  const observed = observeRetrievalContext(options.ctx);
  try {
    return await options.runRetrieval(() => work(observed.ctx, observed.retrieval));
  } catch (error) {
    // Provider and database exceptions may contain request details. The MCP SDK
    // receives only deliberate client messages and the bounded observations.
    const denied = error instanceof BillableDenied ? error.outcome : undefined;
    const code = denied ? String(denied.body?.['code'] ?? 'USAGE_UNAVAILABLE') : error instanceof UnsupportedCoverageError
      ? error.code : error instanceof RequestInputError ? 'INVALID_ARGUMENT' : 'UPSTREAM_UNAVAILABLE';
    const message = error instanceof RequestInputError || error instanceof UnsupportedCoverageError ? error.message
      : error instanceof BillableDenied ? error.message : 'The retrieval could not complete. Retry later.';
    return { ...result({ ...denied?.body, code, message, ...(denied ? { status: denied.status } : {}),
      retrieval: observed.retrieval }, message), isError: true };
  }
}

/** Tool discovery and protocol messages never enter runRetrieval. */
export function createCivicSignalMcpHandler(options: CivicSignalMcpOptions) {
  return createMcpHandler(async () => {
    const availability = await loadCorpusAvailability(options.ctx);
    const populated = Boolean(options.ctx.db && availability['statutes-canada']?.available);
    const semantic = populated && Boolean(options.ctx.vector && options.ctx.embedQuery);
    const server = new McpServer({ name: 'CivicSignal', version: '1.0.0-rc' }, {
      capabilities: { tools: {} },
      maxToolInputElements: 128,
      instructions: 'Cited Canadian federal statute retrieval in English and French. ' +
        'News, debate, bills, provincial law, tone and geographic distribution are unavailable in v1. ' +
        'Riding, municipality, region, provincial and historical-version filtering are unsupported. ' +
        'Use cite_provision for exact citations, statute_lookup for topics and statute_changes for observed source updates. ' +
        'Tools are listed only when their published corpus and required backends are available. ' +
        'Every retrieval tool requires a workspace API key with civicsignal.retrieve and consumes one unit on success. ' +
        'Initialization, discovery, notifications and retrieval failures consume no units. ' +
        'A lost usage acknowledgement can leave a committed unit and an uncertain usage error; retain the operation ID for reconciliation. ' +
        'Results are not an official version of the law; consult their source links.',
    });

    if (semantic) {
      server.registerTool('brief_topic', {
        title: 'Brief a federal statute topic',
        description: 'Retrieve cited federal statute provisions. Coverage explicitly identifies unsupported news, debate, bills, tone and geography.',
        inputSchema: z.object({ topic, keywords, language,
          jurisdiction: z.literal('CA').optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }).strict(),
        outputSchema, annotations,
      }, async (args) => runTool(options, async (context, retrieval) => {
        const brief = await buildBrief(args as BriefRequest, context);
        return result({ ...brief, retrieval }, summarise(brief));
      }));

      server.registerTool('statute_lookup', {
        title: 'Search federal statutes and regulations',
        description: 'Search the current Canadian federal corpus by topic and optional keywords. Returns accepted matches and official source citations. Provincial and historical law are unavailable.',
        inputSchema: z.object({ topic, keywords, language,
          jurisdiction: z.literal('CA').optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }).strict(),
        outputSchema, annotations,
      }, async (args) => runTool(options, async (context, retrieval) => {
        const brief = await buildBrief({ ...args, include: ['statutes-canada'] }, context);
        const data = { items: brief.legislation, coverage: brief.coverage.filter((entry) => entry.corpusId === 'statutes-canada'), attribution: brief.attribution, retrieval };
        return result(data, `${brief.legislation.length} accepted federal statute section(s).`);
      }));
    }

    if (populated) {
      server.registerTool('cite_provision', {
        title: 'Resolve an exact federal statute citation',
        description: 'Resolve a provision by instrument title and section label, including repealed provisions. Prefer this tool whenever a question names a section. Results state status and link to the official source.',
        inputSchema: z.object({
          act: z.string().trim().min(2).max(200), section: z.string().trim().min(1).max(60), language,
          limit: z.number().int().min(1).max(20).optional(),
        }).strict(),
        outputSchema, annotations,
      }, async (args) => runTool(options, async (context, retrieval) => {
        const cited = await citeProvision(args, context);
        return result({ items: cited.items, language: cited.language, retrieval }, cited.summary);
      }));

      server.registerTool('statute_changes', {
        title: 'Read observed federal statute changes',
        description: 'Read corpus additions, changes and removals in ascending ingestion event order. Use nextAfter as the next after cursor. Returns citation and provenance metadata without full text. Source revision dates do not establish when a legal change took effect.',
        inputSchema: z.object({
          after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          since: z.string().min(10).max(24).optional().describe('Source revision date or UTC timestamp, inclusive.'),
          until: z.string().min(10).max(24).optional().describe('Source revision date or UTC timestamp, inclusive.'),
          change: z.enum(['added', 'changed', 'removed']).optional(),
        }).strict(),
        outputSchema, annotations,
      }, async (args) => runTool(options, async () => {
        const changes = await readStatuteChanges(args, options.ctx);
        return result(changes, `${changes.count} observed federal statute change(s)${changes.hasMore ? '; more available' : ''}.`);
      }));
    }
    return server;
  }, { maxRequestBodySize: 128 * 1024 });
}

function summarise(brief: BriefResponse): string {
  const unavailable = brief.coverage.filter((entry) => entry.status === 'unavailable').map((entry) => entry.corpusId);
  return `${brief.legislation.length} accepted federal statute section(s).${unavailable.length ? ` Unavailable: ${unavailable.join(', ')}.` : ''}`;
}
