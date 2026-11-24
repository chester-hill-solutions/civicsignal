export async function readHansardSource(url: URL, send: typeof fetch, mediaTypes: string[], byteLimit: number) {
  const response = await send(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const location = response.headers.get('location');
  const redirect = response.status === 302 && location ? new URL(location, url) : undefined;
  // Missing XML is sometimes reported by a redirect to the House's own 404 page.
  if (response.status === 404 || (url.hostname === 'www.ourcommons.ca' && redirect?.origin === url.origin &&
      redirect.pathname.toLowerCase() === '/errorpage/default.aspx' && redirect.searchParams.get('StatusCode') === '404')) {
    await response.body?.cancel();
    return null;
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || !mediaType || !mediaTypes.includes(mediaType) || !response.body) {
    await response.body?.cancel();
    throw new Error(`Unexpected Hansard source response (HTTP ${response.status}, ${mediaType || 'unknown content type'}).`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > byteLimit) throw new Error('Hansard source exceeded its response byte limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

