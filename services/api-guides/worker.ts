import { agentGuide } from '../../src/routes/agent-guides';

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const guide = agentGuide(url.pathname, url.origin);
    if (guide === undefined) return new Response(null, { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    return new Response(request.method === 'HEAD' ? null : guide, {
      headers: { 'Content-Type': 'text/markdown; charset=UTF-8' },
    });
  },
} satisfies ExportedHandler;
