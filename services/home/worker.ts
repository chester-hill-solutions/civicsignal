import { landingPageResponse } from '../../src/routes/landing-page';

const apiOrigin = 'https://api.civicsignal.chesterhillsolutions.ca';

export default {
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (!['/', '/llms.txt', '/.well-known/civicsignal.json'].includes(path)) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    if (path !== '/') return Response.redirect(apiOrigin + path, 302);
    const discovery = { instructions: apiOrigin + '/llms.txt', capabilities: apiOrigin + '/.well-known/civicsignal.json' };
    const page = landingPageResponse(crypto.randomUUID(), { apiOrigin, discovery });
    return request.method === 'HEAD' ? new Response(null, { headers: page.headers }) : page;
  },
} satisfies ExportedHandler;
