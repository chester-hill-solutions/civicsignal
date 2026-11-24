import { AccessError } from '../access';
import { RequestInputError } from '../http';
import type { Env } from '../types';
import type { GedsDatabase } from '../geds/db';
import {
  GedsQueryError,
  getHierarchy,
  getOrganization,
  getOrganizationPeople,
  getPerson,
  getPersonContact,
  readContext,
  searchOrganizations,
  searchPeople,
  withSnapshot,
} from '../geds/repository';

/**
 * The GEDS HTTP surface.
 *
 * Every route is a Server-key route: `Authorization: Bearer sk_…`. A successful
 * response is one billable unit; a denial, a bad parameter and a missing id are
 * not. That is the same contract as `/api/brief`, `/api/statutes` and the rest
 * of the product.
 */

export const GEDS_PREFIXES = ['/api/organizations', '/api/people'] as const;

export function isGedsPath(pathname: string): boolean {
  return GEDS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

type GedsRoute =
  | { kind: 'organizations' | 'people' }
  | { kind: 'organization' | 'organization-people' | 'organization-hierarchy' | 'person' | 'person-contact'; id: string };

const operationParams: Record<GedsRoute['kind'], readonly string[]> = {
  organizations: ['q', 'limit', 'offset', 'exact', 'match'],
  people: ['q', 'limit', 'offset', 'exact', 'match', 'organizationId'],
  'organization-people': ['descendants', 'limit', 'offset'],
  'person-contact': ['organizationId', 'roleId'],
  organization: [], 'organization-hierarchy': [], person: [],
};

function checkParams(params: URLSearchParams, kind: GedsRoute['kind']) {
  const allowed = new Set(['lang', 'asOf', ...operationParams[kind]]);
  for (const [key, value] of params) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new GedsQueryError('INVALID_ARGUMENT', 'Unexpected or repeated directory parameter.', 400);
    if ((key === 'exact' || key === 'descendants') && !['true', 'false'].includes(value)) {
      throw new GedsQueryError('INVALID_ARGUMENT', `${key} must be true or false.`, 400);
    }
    if (key === 'match' && value !== 'exact') throw new GedsQueryError('INVALID_ARGUMENT', 'match must be exact.', 400);
  }
}

function parseRoute(pathname: string): GedsRoute | null {
  let parts: string[];
  try { parts = pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new GedsQueryError('INVALID_ARGUMENT', 'Invalid directory identifier encoding.', 400); }
  if (parts[0] !== 'api') return null;
  if (parts[1] === 'organizations') {
    if (parts.length === 2) return { kind: 'organizations' };
    if (parts.length === 3) return { kind: 'organization', id: parts[2] };
    if (parts.length === 4 && parts[3] === 'people') return { kind: 'organization-people', id: parts[2] };
    if (parts.length === 4 && parts[3] === 'hierarchy') {
      return { kind: 'organization-hierarchy', id: parts[2] };
    }
    return null;
  }
  if (parts[1] === 'people') {
    if (parts.length === 2) return { kind: 'people' };
    if (parts.length === 3) return { kind: 'person', id: parts[2] };
    if (parts.length === 4 && parts[3] === 'contact') return { kind: 'person-contact', id: parts[2] };
    return null;
  }
  return null;
}

/** Resolve one authenticated GEDS request. Exported for handler tests. */
export async function answerGedsRequest(
  db: GedsDatabase,
  requestUrl: URL,
) {
  const route = parseRoute(requestUrl.pathname);
  if (!route) {
    throw new GedsQueryError('NOT_FOUND', `No GEDS route for ${requestUrl.pathname}`, 404);
  }
  const params = requestUrl.searchParams;
  checkParams(params, route.kind);
  const ctx = await readContext(db, {
    lang: params.get('lang'),
    asOf: params.get('asOf'),
  });

  switch (route.kind) {
    case 'organizations': {
      const result = await searchOrganizations(ctx, {
        q: params.get('q'),
        limit: params.get('limit'),
        offset: params.get('offset'),
        exact: params.get('exact') === 'true' || params.get('match') === 'exact',
      });
      return {
        status: 200,
        body: withSnapshot(ctx, { query: params.get('q') ?? '', ...result }),
      };
    }
    case 'organization': {
      const result = await getOrganization(ctx, route.id);
      return { status: 200, body: withSnapshot(ctx, result) };
    }
    case 'organization-hierarchy': {
      const result = await getHierarchy(ctx, route.id);
      return { status: 200, body: withSnapshot(ctx, result) };
    }
    case 'organization-people': {
      const result = await getOrganizationPeople(ctx, route.id, {
        limit: params.get('limit'),
        offset: params.get('offset'),
        descendants: params.get('descendants') === 'true',
      });
      return { status: 200, body: result };
    }
    case 'people': {
      const result = await searchPeople(ctx, {
        q: params.get('q'),
        limit: params.get('limit'),
        offset: params.get('offset'),
        exact: params.get('exact') === 'true' || params.get('match') === 'exact',
        organizationId: params.get('organizationId'),
      });
      return {
        status: 200,
        body: withSnapshot(ctx, {
          query: params.get('q') ?? '',
          organizationId: params.get('organizationId'),
          ...result,
        }),
      };
    }
    case 'person': {
      const result = await getPerson(ctx, route.id);
      return { status: 200, body: result };
    }
    case 'person-contact': {
      const result = await getPersonContact(ctx, route.id, {
        organizationId: params.get('organizationId'),
        roleId: params.get('roleId'),
      });
      return { status: 200, body: result };
    }
  }
}

/** Match and prepare a GEDS request for the Worker’s shared auth and billing path. */
export type GedsResponse = Awaited<ReturnType<typeof answerGedsRequest>>['body'];

export function prepareGeds(url: URL): ((env: Env) => () => Promise<GedsResponse>) | undefined {
  if (!isGedsPath(url.pathname)) return undefined;
  return (env) => {
    if (env.GEDS_PREVIEW !== 'on') {
      throw new AccessError('UNSUPPORTED_COVERAGE', 'GEDS directory preview is disabled.', 501);
    }
    const db = env.CIVIC_DB;
    if (!db) {
      throw new AccessError('RETRIEVAL_UNAVAILABLE', 'GEDS directory database is unavailable.', 503);
    }
    return async () => {
      try {
        return (await answerGedsRequest(db, url)).body;
      } catch (error: unknown) {
        if (error instanceof GedsQueryError) {
          if (error.code === 'INVALID_ARGUMENT') throw new RequestInputError(error.message);
          throw new AccessError(error.code, error.message, error.status);
        }
        throw new AccessError('RETRIEVAL_UNAVAILABLE', 'Unable to read the directory snapshot.', 503);
      }
    };
  };
}
