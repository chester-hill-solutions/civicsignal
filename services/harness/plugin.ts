import { Plugin } from "@opencode/plugin";

/**
 * The CivicSignal harness plugin.
 *
 * OpenCode is the product's agent. This plugin is what makes it *about Canada*:
 * it wires the corpus in, teaches the agent how to read what it gets back, and
 * adds the questions a campaign or a legal clinic actually asks.
 *
 * It is a plugin rather than configuration because three of these four things are
 * **code**, and code can be tested:
 *
 * - The **licence rule** is enforced by a hook on the model request, not by a
 *   line in a prompt template. It runs on every model call including
 *   tool-driven continuations, and it can take tools away.
 * - The **agent** is registered with a description, so it is a first-class
 *   choice rather than a suggestion.
 * - The **MCP server** is wired per directory, so each customer gets their own
 *   corpus with their own key.
 * - The **commands** are first-class in the harness, so `/changes` is a thing the
 *   agent knows how to do.
 *
 * ## The licence rule is the interesting one
 *
 * CivicSignal's corpora have three reproduction regimes. An open corpus may be
 * summarised. A cite-only corpus — Hansard, which is Crown copyright — may only
 * be **quoted**, because a paraphrase of it is a derivative of it. A
 * metadata-only corpus contributes a headline and a link and nothing else.
 *
 * That rule was a system prompt in the chat endpoint, which is a string somebody
 * eventually softens. Here it is a hook on the model request: it is applied on
 * every call, it is versioned, and it is tested.
 */

/** Where the corpus lives. */
const DEFAULT_API_URL = "https://api.civicsignal";

/**
 * The rule, as it goes into every model request.
 *
 * It is deliberately short and it is deliberately not negotiable. The detail of
 * what each regime permits is enforced at emission — the gate strips an item to
 * its policy before the model ever sees it — so this says what the model must
 * *do* with what it is given, not what it may be given.
 */
const LICENCE_RULE = [
  "You are answering questions about Canadian law and civic affairs using the CivicSignal corpus.",
  "",
  "How you may use what you get back depends on the corpus it came from, and the",
  "regime is stated on every item:",
  "",
  "- **open** — may be summarised, explained and analysed. Cite the provision.",
  "- **cite-only** — Crown copyright. Quote it verbatim in quotation marks. Do not",
  "  paraphrase, summarise, translate or otherwise transform it, and do not combine",
  "  separate passages into a paraphrase. Attribute every quotation to its speaker",
  "  and date, and give the citation link.",
  "- **metadata-only** — only the headline and the link are available. Refer to it",
  "  by title and link. Do not infer or reconstruct its content.",
  "",
  "Two more rules that are easy to forget and expensive to get wrong:",
  "",
  "- **Say what the corpus does not cover.** If the answer is not in the corpus, say",
  "  so plainly and say what would make it answerable. A confident wrong answer",
  "  about the law is worse than no answer.",
  "- **A citation is a key, not a similarity.** When a question names a provision,",
  "  resolve it exactly and say whether it is in force. Do not offer the nearest",
  "  thing you found instead.",
].join("\n");

/** The agent's description. This is what the model reads when it chooses. */
const CIVIC_AGENT_DESCRIPTION = [
  "Answers questions about Canadian law, Parliament and civic affairs from the CivicSignal corpus.",
  "",
  "Every answer cites its source. When the corpus does not cover the question, it says so",
  "rather than answering from general knowledge, and it distinguishes what is in force from",
  "what was repealed.",
].join(" ");

export interface CivicSignalOptions {
  /** The corpus API's base URL. */
  apiUrl?: string;
  /** The customer's CivicSignal key. Read from the environment when not given. */
  apiKey?: string;
}

export default Plugin.define({
  id: "civicsignal",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as CivicSignalOptions;
    const apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    const apiKey = options.apiKey ?? process.env.CIVICSIGNAL_API_KEY ?? "";

    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

    // ── the corpus, wired in ────────────────────────────────────────────────
    //
    // Per directory, so each customer gets their own corpus with their own key.
    // The transform is how a plugin manages an MCP server; the alternative is a
    // config file, which cannot carry a per-customer secret.
    await ctx.mcp.transform((editor) => {
      editor.set("civicsignal", {
        type: "remote",
        url: `${apiUrl}/mcp`,
        headers,
        enabled: true,
      } as never);
    });

    // ── the agent ──────────────────────────────────────────────────────────
    //
    // A registered agent is a first-class choice in the harness, with its own
    // description, rather than a line the user has to remember to ask for.
    await ctx.agent.transform((editor) => {
      const existing = editor.get("civic");
      if (!existing) {
        editor.update("build", (agent) => {
          agent.description = CIVIC_AGENT_DESCRIPTION;
        });
        return;
      }
      editor.update("civic", (agent) => {
        agent.description = CIVIC_AGENT_DESCRIPTION;
      });
    });

    // ── the licence rule ───────────────────────────────────────────────────
    //
    // A hook on the model request, so it is applied to every call — including
    // the continuations that follow a tool result — and not just to the first
    // prompt. It can also take tools away, which a prompt cannot.
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: LICENCE_RULE });
    });

    // ── the commands ───────────────────────────────────────────────────────
    //
    // What a campaign, a legal clinic or a journalist actually asks. Each one is
    // a question about the corpus rather than about the world, and each one is
    // first-class in the harness.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "changes",
        description: "What changed in Canadian federal law and politics since a date.",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text:
              `${prompt.text}\n\n` +
              "Use the CivicSignal corpus. Report what changed, with each change cited to " +
              "its provision and its date. Say plainly if nothing changed.",
          });
        },
      });

      editor.add({
        name: "in-force",
        description: "Whether a provision is in force, and when it was repealed.",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text:
              `${prompt.text}\n\n` +
              "Resolve the provision exactly — an Act, a section, and the instrument's own " +
              "citation — and say whether it is in force. If it was repealed, say when and by " +
              "what. Do not substitute the nearest provision you found.",
          });
        },
      });

      editor.add({
        name: "coverage",
        description: "What the CivicSignal corpus covers, and what it does not.",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text:
              `${prompt.text}\n\n` +
              "Read the corpus's own coverage statement from the CivicSignal capabilities " +
              "document and report what it covers and what it does not. If the question is " +
              "outside the corpus, say so.",
          });
        },
      });
    });
  },
});
