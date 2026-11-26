export const AUTH_GUIDE = '/auth.md';
export const AGENT_GUIDE = '/docs/agents.md';

export function agentGuide(path: string, origin: string): string | undefined {
  const manifest = `[live capabilities](${origin}/.well-known/civicsignal.json)`;
  if (path === AUTH_GUIDE) {
    return [
      '# CivicSignal authentication',
      '',
      'Discovery and documentation are public. API and MCP retrieval require a workspace API key.',
      'Send the key in the `Authorization: Bearer <workspace API key>` header. Store it in your client’s secret configuration.',
      'When a key is missing the API returns HTTP 401 with `KEY_REQUIRED`. An invalid key returns `KEY_INVALID`.',
      `Check ${manifest} for this deployment’s key types, pricing, monthly allowance, and request scopes.`,
      '',
    ].join('\n');
  }
  if (path === AGENT_GUIDE) {
    return [
      '# CivicSignal agent guide',
      '',
      `Read ${manifest} first to find the API version, available sources, HTTP endpoints, and MCP tools.`,
      `Configure ${origin}/mcp as a Streamable HTTP server and send the workspace key in the Authorization header.`,
      `For an HTTP brief, send \`GET ${origin}/api/brief?topic=housing\` with the same header when the manifest lists that route.`,
      'Use the source URLs and citations returned by the API. Discover the supported lookups and filters before selecting a source.',
      `[Authentication guide](${origin}${AUTH_GUIDE})`,
      '',
    ].join('\n');
  }
  return undefined;
}
