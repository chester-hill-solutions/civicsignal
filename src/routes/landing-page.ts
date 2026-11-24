import { securityHeaders } from '../security-headers';

interface LandingOptions {
  apiOrigin?: string;
  discovery?: { instructions: string; capabilities: string };
  sourcePreviews?: { path: string; label: string }[];
}

function renderLanding({ apiOrigin, discovery, sourcePreviews = [] }: LandingOptions): string {
  const hasPreviews = sourcePreviews.length > 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Discover which Canadian policy sources you can query, their coverage dates and example research questions.">
  ${discovery ? `<link rel="help" href="${discovery.instructions}">` : ''}
  <title>CivicSignal | Agent quickstart</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #fbfaf8;
      --white: #fff;
      --ink: #242329;
      --muted: #595456;
      --action: #2d2e33;
      --action-hover: #42424a;
      --signal: #a63d2e;
      --link: #6f3a32;
      --focus: #903f33;
      --line: #d7d2ce;
      --inset: #f8f6f3;
      --heading: "Instrument Sans", system-ui, sans-serif;
      --body: "Noto Sans", system-ui, sans-serif;
      --mono: "Noto Sans Mono", ui-monospace, monospace;
      font: 100%/1.6 var(--body);
      background: var(--paper);
      color: var(--ink);
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; }
    .shell { max-inline-size: 74rem; margin-inline: auto; padding-inline: clamp(1rem, 4vw, 2.75rem); }
    .skip {
      position: absolute; z-index: 1; inset-block-start: .5rem; inset-inline-start: .5rem;
      padding: .55rem .85rem; background: var(--white); transform: translateY(-150%);
    }
    .skip:focus { transform: none; }
    .masthead { background: var(--white); border-block-end: 1px solid var(--line); }
    .masthead-inner, .identity, .masthead nav {
      display: flex; align-items: center; flex-wrap: wrap; gap: .25rem 1rem;
    }
    .masthead-inner { justify-content: space-between; padding-block: .65rem; }
    .identity { gap: .25rem .85rem; }
    .wordmark {
      display: inline-flex; align-items: center; gap: .65rem; min-block-size: 2.75rem;
      color: var(--ink); font: 900 1.55rem/1 Lato, system-ui, sans-serif;
      letter-spacing: -.038em; text-decoration: none;
    }
    .mark {
      display: grid; place-items: center; flex: none; inline-size: 2.1rem;
      aspect-ratio: 1; background: var(--signal); color: var(--white);
    }
    .bars { display: grid; gap: .16rem; inline-size: 62%; transform: skewY(-17deg); }
    .bars span { block-size: .16rem; background: currentColor; }
    .bars span:first-child { inline-size: 47%; justify-self: end; }
    .bars span:nth-child(2) { inline-size: 74%; justify-self: center; }
    .tagline {
      border-inline-start: 1px solid var(--line); margin: 0; padding-inline-start: .85rem;
      color: var(--muted); font-size: .875rem;
    }
    a { color: var(--link); font-weight: 650; text-underline-offset: .18em; }
    a:hover { text-decoration-thickness: .12em; }
    a:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    .masthead nav a { display: inline-flex; align-items: center; min-block-size: 2.75rem; font-size: .875rem; }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
      padding-block-end: clamp(2rem, 5vw, 3.5rem);
    }
    .intro, .connect, .example, .preview { min-inline-size: 0; padding-block: clamp(1.5rem, 4vw, 2.8rem); }
    .intro, .example { padding-inline-end: clamp(1.5rem, 4.25vw, 3.4rem); }
    .connect, .preview {
      background: var(--inset); border-inline-start: 1px solid var(--line);
      padding-inline: clamp(1.25rem, 3vw, 2.35rem);
    }
    .example, .preview { border-block-start: 1px solid var(--line); }
    .example:last-child { grid-column: 1 / -1; padding-inline-end: 0; }
    h1, h2 { font-family: var(--heading); font-weight: 750; margin: 0; }
    h1 {
      max-inline-size: 17ch; font-size: clamp(2.2rem, 1.45rem + 3.4vw, 4rem);
      line-height: 1.04; letter-spacing: -.04em;
    }
    h2 { font-size: clamp(1.3rem, 1.14rem + .5vw, 1.65rem); line-height: 1.2; letter-spacing: -.026em; }
    p { max-inline-size: 62ch; margin-block: .75rem 0; color: var(--muted); }
    .intro p { font-size: clamp(1rem, .92rem + .35vw, 1.16rem); margin-block-start: 1rem; }
    .actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-block-start: 1.35rem; }
    .action {
      display: inline-flex; align-items: center; justify-content: center; min-block-size: 2.75rem;
      padding: .45rem .9rem; border: 1px solid var(--action); border-radius: .4rem; text-decoration: none;
    }
    .primary { background: var(--action); color: var(--white); }
    .primary:hover { background: var(--action-hover); }
    .secondary { color: var(--ink); }
    .secondary:hover { background: var(--inset); }
    .connect ol { margin-block: .8rem 0; padding-inline-start: 1.25rem; }
    .connect li + li { margin-block-start: .55rem; }
    .connect li::marker { font-weight: 700; color: var(--link); }
    code { font: .9em var(--mono); overflow-wrap: anywhere; }
    pre {
      margin-block: .9rem 0; padding: .85rem 1rem; background: var(--inset);
      border: 1px solid var(--line); border-radius: .4rem; white-space: pre-wrap;
    }
    .resource-list { list-style: none; margin-block: .8rem 0; padding: 0; border-block-start: 1px solid var(--line); }
    .resource-list li { border-block-end: 1px solid var(--line); }
    .resource-list a { display: flex; align-items: center; min-block-size: 2.75rem; padding-block: .3rem; }
    @media (max-width: 49rem) {
      .layout { grid-template-columns: minmax(0, 1fr); }
      .intro, .example { padding-inline-end: 0; }
      .connect, .preview {
        border-inline-start: 0; border-block-start: 1px solid var(--line);
        padding-inline: 0; background: transparent;
      }
    }
    @media (max-width: 29rem) {
      .tagline { border-inline-start: 0; padding-inline-start: 0; }
      .masthead nav { column-gap: .85rem; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#content">Skip to main content</a>
  <header class="masthead">
    <div class="shell masthead-inner">
      <div class="identity">
        <a class="wordmark" href="/">
          <span class="mark" aria-hidden="true"><span class="bars"><span></span><span></span><span></span></span></span>
          CivicSignal
        </a>
        <p class="tagline">Canadian policy research</p>
      </div>
      <nav aria-label="On this page">
        <a href="#connect">Connect an agent</a>
        <a href="#http-example">HTTP example</a>
        ${hasPreviews ? '<a href="#previews">Source previews</a>' : ''}
      </nav>
    </div>
  </header>
  <main class="shell layout" id="content">
    <section class="intro" aria-labelledby="page-title">
      <h1 id="page-title">Canadian policy research, with sources.</h1>
      <p>See which sources this deployment can query, how current each edition is and what questions you can investigate.</p>
      ${discovery ? `
      <nav class="actions" aria-label="Agent resources">
        <a class="action primary" href="${discovery.instructions}">Agent instructions</a>
        <a class="action secondary" href="${discovery.capabilities}">Live capabilities (JSON)</a>
      </nav>` : ''}
    </section>

    <section class="connect" aria-labelledby="connect">
      <h2 id="connect">Connect an agent</h2>
      <ol>
        ${discovery ? '<li>Read live capabilities. Choose an available edition and follow its example request.</li>' : ''}
        <li>Send <code>Authorization: Bearer &lt;workspace API key&gt;</code> with <code>civicsignal.retrieve</code>. Store the key in your agent’s secret store.</li>
        <li>For MCP, connect to <code>${apiOrigin ?? ''}/mcp</code> using Streamable HTTP. Initialize the session, then discover tools with <code>tools/list</code>. The manifest lists the available statute tools.</li>
      </ol>
      ${discovery ? '<p>Each successful retrieval costs one workspace unit. Reading instructions, checking capabilities, and listing MCP tools are free.</p>' : ''}
    </section>

    <section class="example" aria-labelledby="http-example">
      <h2 id="http-example">Discover sources over HTTP</h2>
      <pre><code>curl "${apiOrigin ?? '$CIVICSIGNAL_URL'}/.well-known/civicsignal.json"</code></pre>
      <p>Look under <code>sources</code> for editions and dates. The apprenticeship example under <code>researchQuestions</code> lists the requests you can run and any missing coverage.</p>
    </section>${hasPreviews ? `
    <section class="preview" aria-labelledby="previews">
      <h2 id="previews">Source previews</h2>
      <p>Preview API requests require a workspace key.</p>
      <ul class="resource-list">
        ${sourcePreviews.map(({ path, label }) => `<li><a href="${path}">${label} OpenAPI</a></li>`).join('\n        ')}
      </ul>
    </section>` : ''}
  </main>
</body>
</html>`;
}

export function landingPageResponse(correlationId: string, options: LandingOptions): Response {
  return new Response(renderLanding(options), {
    headers: {
      ...securityHeaders(),
      'Content-Type': 'text/html; charset=UTF-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      ...(options.discovery && { Link: `<${options.discovery.instructions}>; rel="help"` }),
      'X-Correlation-ID': correlationId,
    },
  });
}
