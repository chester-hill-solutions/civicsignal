import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import homepage from '../services/home/worker';
import apiGuides from '../services/api-guides/worker';
import type { Env } from '../src/types';

function request(path: string, method = 'GET', env: Env = {}) {
  return worker.fetch(new Request(`https://civicsignal.test${path}`, { method }), env, {
    waitUntil() {}, passThroughOnException() {}, props: {},
    get tracing(): never { throw new Error('Public discovery should not require tracing.'); },
  });
}

const databaseBinding = {} as D1Database;
const previews: { path: string; config: Env; bindings?: Env }[] = [
  { path: '/api/funding-programs/openapi.json', config: { FUNDING_PREVIEW: 'on' }, bindings: { CIVIC_DB: databaseBinding } },
  { path: '/api/gazette/openapi.json', config: { GAZETTE_PREVIEW: 'on' }, bindings: { GAZETTE_DB: databaseBinding } },
  { path: '/api/debates/openapi.json', config: { HANSARD_PREVIEW: 'on' }, bindings: { CIVIC_DB: databaseBinding } },
  { path: '/api/geds/openapi.json', config: { GEDS_PREVIEW: 'on' }, bindings: { CIVIC_DB: databaseBinding } },
  { path: '/api/parliament/openapi.json', config: { PARLIAMENT_CATALOGUE_PREVIEW: 'on' }, bindings: { CIVIC_DB: databaseBinding } },
  { path: '/api/bills/openapi.json', config: { BILL_PREVIEW: 'on' }, bindings: { BILL_DB: databaseBinding } },
  { path: '/api/committees/openapi.json', config: { COMMITTEE_CORPUS_PREVIEW: 'on' }, bindings: { COMMITTEE_DB: databaseBinding } },
  { path: '/api/committees/openapi.json', config: { BILL_PREVIEW: 'on' } },
  { path: '/api/written-questions/openapi.json', config: { WRITTEN_QUESTIONS_PREVIEW: 'on' }, bindings: { CIVIC_DB: databaseBinding } },
];

describe('public agent landing page', () => {
  it.each([
    ['/auth.md', 'Authorization: Bearer'],
    ['/docs/agents.md', 'Streamable HTTP'],
  ])('serves the advertised guide %s anonymously on both deployments', async (path, expected) => {
    const url = new URL(path, 'https://civicsignal.test');
    for (const response of [await request(path), apiGuides.fetch(new Request(url))]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/markdown');
      const text = await response.text();
      expect(text).toContain(expected);
      expect(text).toContain(new URL('/.well-known/civicsignal.json', url).href);
    }
    expect(apiGuides.fetch(new Request(url, { method: 'POST' })).status).toBe(405);
    expect(await apiGuides.fetch(new Request(url, { method: 'HEAD' })).text()).toBe('');
    const llms = await request('/llms.txt');
    expect(await llms.text()).toContain(url.href);
  });

  it('serves the quickstart without credentials or database bindings', async () => {
    const response = await request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('link')).toBe('</llms.txt>; rel="help"');
    const html = await response.text();
    expect(html).toContain('Canadian policy research, with sources.');
    expect(html).toContain('Authorization: Bearer &lt;workspace API key&gt;');
    expect(html).toContain('<code>/mcp</code>');
    expect(html).toContain('curl "$CIVICSIGNAL_URL/.well-known/civicsignal.json"');
    expect(html).not.toContain('Source previews');
    expect(html).not.toContain('/openapi.json');
    expect(html).not.toContain('<script');
  });

  it.each([
    ['/llms.txt', 'text/plain'],
    ['/.well-known/civicsignal.json', 'application/json'],
  ])('links to the public resource %s', async (path, contentType) => {
    const page = await request('/');
    expect(await page.text()).toContain(`href="${path}"`);
    const resource = await request(path);
    expect(resource.status).toBe(200);
    expect(resource.headers.get('content-type')).toContain(contentType);
  });

  it.each([
    ...new Set(previews.map(({ path }) => path)),
    '/api/consultations/openapi.json',
    '/api/departmental-publications/openapi.json',
  ])('serves the generated OpenAPI contract at %s without preview bindings', async (path) => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const contract = await response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(contract.openapi).toBe('3.1.0');
    expect(Object.keys(contract.paths).length).toBeGreaterThan(0);
  });

  it.each(previews)('withholds $path when publication cannot be verified ($config)', async ({ path, config, bindings }) => {
    const disabled = await request('/', 'GET', bindings);
    expect(await disabled.text()).not.toContain(`href="${path}"`);
    if (bindings) {
      const unbound = await request('/', 'GET', config);
      expect(await unbound.text()).not.toContain(`href="${path}"`);
    }

    const enabled = await request('/', 'GET', { ...config, ...bindings });
    const html = await enabled.text();
    expect(html).not.toContain(`href="${path}"`);
    expect(html).not.toContain('href="#previews"');
    expect(html).toContain('href="#http-example"');

    const resource = await request(path);
    expect(resource.status).toBe(200);
    expect(resource.headers.get('content-type')).toContain('application/json');
  });

  it('rejects a write to the landing page', async () => {
    const response = await request('/', 'POST');
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
  });
});

describe('dedicated CivicSignal homepage', () => {
  const origin = 'https://civicsignal.chesterhillsolutions.ca';
  const apiOrigin = 'https://api.civicsignal.chesterhillsolutions.ca';

  it('provides its own quickstart with working in-page links', async () => {
    const response = homepage.fetch(new Request(origin));
    expect(response.status).toBe(200);
    expect(response.headers.get('link')).toBe(`<${apiOrigin}/llms.txt>; rel="help"`);
    const html = await response.text();
    expect(html).toContain('Canadian policy research, with sources.');
    expect(html).toContain(`<code>${apiOrigin}/mcp</code>`);
    expect(html).toContain(`curl "${apiOrigin}/.well-known/civicsignal.json"`);
    for (const path of ['/llms.txt', '/.well-known/civicsignal.json']) {
      expect(html).toContain(`href="${apiOrigin}${path}"`);
      for (const method of ['GET', 'HEAD']) {
        const redirect = homepage.fetch(new Request(origin + path, { method }));
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get('location')).toBe(apiOrigin + path);
      }
      expect(homepage.fetch(new Request(origin + path, { method: 'POST' })).status).toBe(405);
    }
    expect(html).not.toContain('/openapi.json');
    for (const target of ['content', 'connect', 'http-example']) {
      expect(html).toContain(`id="${target}"`);
    }
  });

  it('supports HEAD and does not claim API paths on the homepage host', async () => {
    const head = homepage.fetch(new Request(origin, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toContain('text/html');
    expect(await head.text()).toBe('');
    expect(homepage.fetch(new Request(origin + '/api/statutes')).status).toBe(404);
    const post = homepage.fetch(new Request(origin, { method: 'POST' }));
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});
