# GEDS directory backend

Build a standalone, bilingual Government Electronic Directory Services directory for CivicSignal on the Cloudflare backend. A client should be able to find a federal unit in either language, look up its people and retrieve a cited professional contact as it appeared on a selected date.

## Inputs and scope

Use the Aboiteau Work conversation `work-civicsignal-geds`. Start from `main` in `chester-hill-solutions/civicsignal` and implement on `aboiteau/geds`. The work can proceed independently of the local committee changes. The official dataset identifier is `8ec4a9df-b76b-4a67-8f93-cdbc2e040098`. Discover the bilingual bulk export through the catalogue and inspect its actual fields, identifiers and encoding. [Official GEDS dataset](https://open.canada.ca/data/dataset/8ec4a9df-b76b-4a67-8f93-cdbc2e040098)

1. Acquire the entire export. Provide a daily refresh entry point, archive changed originals by hash and record the official URL, observation time and source date where available. Publish a completed snapshot atomically so an interrupted refresh can resume and readers can still query the previous snapshot.
2. Preserve published people, roles, organizations, parent units, professional contact details and missing fields. Document how IDs behave across editions and snapshots. Keep same-name entries distinguishable. Record how a contact is labelled by the publisher, including when it reaches a general office.
3. Implement typed, authenticated Worker handlers for people and organization search and exact lookup, organizational hierarchy, and `GET /api/organizations/{id}/people`. Support bilingual lookup, bounded pagination and historical reads using `asOf`. Reuse the branch's auth, metering, error and OpenAPI conventions. Supply local Cloudflare replay instructions using `cf`.

## Acceptance

- Run a complete local import. Report the observation time, original hash, source and stored counts, language coverage, missing fields and unresolved records.
- Through authenticated requests, resolve one real unit from both its English and French names to the same ID. Traverse to a person or office and return its published contact with a citation.
- Replay the same export and demonstrate stable IDs and zero duplicate records or change events. Use fixtures for same-name people, a person moving units between snapshots, and a unit with only a general office number. Verify that the earlier snapshot still returns the earlier role.
- Return the implementation, English and French OpenAPI examples, handler and refresh tests, a coverage receipt, and exact local replay commands. Committee appearances and written-reply links are a follow-on assignment that can consume these IDs.
