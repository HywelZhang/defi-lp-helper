---
name: ai-chat-surface
description: Build a chat page over a data app — live context per turn, prose budget, safe rendering, SSE streaming with abort, skill toggles, sessions.
---

# AI Chat Surface

A chat box bolted onto a data product answers with confidence in both directions: it can be fluent, specific, and disagree with the page behind it. The work is making it cite the same numbers the pages show.

Distinct from `defi-research-report` (structured JSON reports from an evidence bundle) and `defi-fact-pipeline` (the facts and infra underneath). This covers the conversational surface only.

## 1. Ground every turn in the tables the UI reads

Build a fresh context block each turn from the same source the pages query — positions, plans, rankings, derived profile, connected integrations. Not a cached summary, not conversation memory alone.

Carry the caveats the pages already show. A derived profile flagged unreliable must arrive flagged, or the assistant presents a disabled signal as fact. State emptiness explicitly ("no positions"): an omitted section reads as "nothing to say" and invites invention.

Rebuild, never append — last hour's snapshot beside today's numbers is worse than no context.

Measured: with this block the first reply quoted the same figures as the assets page ($0.96 deployed, −1.80% / −2.70%); without it there is nothing for the model to be right about.

Complete when: a question about the user's own holdings returns figures matching another page of the same app, and a category with no rows is stated as empty rather than skipped.

### Scoped questions: send an identifier, never a transcript

A drawer or detail view needs its own ask box — after reading a research report the user's next question is "so should I enter?", and routing them to a general chat means re-describing the subject. But the client must send only what identifies the subject (`{chain, address, question}`), and the **server rebuilds the context** from the same tools the page rendered.

Never accept the page's rendered numbers as the prompt context. Client-supplied text is unattributable: it can be stale from an earlier render, or edited, and the reply then quotes figures no tool produced — which is exactly the failure §1 exists to prevent, reintroduced through a different door. Verified effect of rebuilding server-side: a follow-up on a pool answered with its real score (B 71/100), its volatility/IL dimension (72/100) and its actual 24h move (−0.06%), all matching the open drawer.

Persist the exchange as a normal session so "continue this in the assistant" is a link, not a copy — and read that session parameter on the assistant page, or the link lands on a blank landing page. A new entry point with no destination reads as a broken feature.

Complete when: the reply's numbers match the drawer that asked, and a tampered or stale client payload changes nothing about them.

## 2. Prose needs the opposite budget from JSON

JSON extraction wants thinking off — `defi-research-report` §3 owns that rule and the empty-content failure it prevents. Prose is the reverse branch: deliberation is the product, so thinking stays on, and the cap has to pay for it.

Verified: `maxTokens: 1200` returned empty content on a longer question (`finish_reason: length`, every token spent on hidden reasoning); 4000 returned a normal 565-character reply.

Reasoning scales with the question, so no fixed cap is safe. On truncation, retry **once** with thinking off — trading deliberation for an answer beats a blank bubble. Report empty content with `finish_reason: length` as an error naming the reasoning tokens, never as "the model returned nothing".

Complete when: a long question yields text, and a deliberately truncated call retries rather than rendering an empty reply.

## 3. Escape before formatting model output

Replies arrive with light markdown. Escape first, then format the escaped string:

```js
let out = esc(text);
out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
```

Reversed order promotes model-emitted tags to live markup. Limit to bold, italic, inline code and stop — past that you are writing a renderer, and the payload is prose.

User-authored text gets escaping only, never the format pass.

Complete when: `**加粗**` renders bold with no literal asterisks, and a `<script>` in a reply renders as text.

## 4. Read the catalogue from disk, store only the choice

Enumerate skill files on each request; persist only the enabled flag. A skill added later then appears without a migration, and the catalogue cannot go stale.

Disabling must remove that text from the assembled system prompt. A toggle that only writes a flag leaves the skill loaded — the switch is cosmetic, and the user believes something it is not doing.

Show how many are on (`技能 3/4`): "off" is indistinguishable from "missing" without a count.

Complete when: adding a skill file makes it appear enabled without touching the database, and turning one off changes the assembled prompt.

## 5. Sessions are their own table

Never share a table name or helper names with auth sessions. The collision is not stylistic: importing both under one name fails at module load with `Identifier '...' has already been declared`, which reads as a broken file rather than a naming clash. Alias at the import so an auth session and a chat session cannot be confused at a call site either.

- Name the session from the first user turn (first ~40 chars). A sidebar of identical "新对话" entries cannot be navigated.
- Deleting a session deletes its messages in the same operation; orphans accumulate silently.
- List order is `updated_at` descending, with message count and a last-message snippet — that is what makes the rail usable.
- Route chat sends through the same spend cap as every other model call — see `defi-fact-pipeline/references/auth-gate.md` § Spend cap. An ungated chat box is an unmetered loop on a paid API.

Complete when: a returning user can tell their conversations apart, a deleted one leaves no rows, and the chat budget appears in the same counter as other calls.

## 6. Streaming, when the wait is worth removing

Buffered replies are acceptable if the wait is signalled: a typing indicator plus a stated 3–10 s expectation. Measured here, a buffered reply took ~5 s and streaming's first token ~2 s — enough to change how the page feels, not to justify a transport nobody consumes. Do not list streaming as "coming" unless chunks are actually rendered.

Once you decide to build it, read `references/streaming-sse.md` for the transport: POST + SSE, the abort binding, frame buffering, usage accounting, and how to prove chunks actually arrive through a proxy. Three of those fail silently — the stop button that stops only the UI, the ledger that records zero, and the stream that renders as one jump.

The decision that belongs here: **the transcript must reflect what was generated.** Aborted before any text → delete the placeholder row and keep the question, or an empty bubble reappears on every reload. Aborted mid-answer → keep the partial text plus a "(stopped)" marker, because hiding it conceals that the answer was cut.

Complete when: text visibly accumulates over time through the public URL, stop leaves the transcript in the state its timing implies, and an aborted run is neither billed twice nor shown as a failure.

## Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Chat quotes numbers that contradict the page | context built once or from memory | rebuild from live tables each turn |
| Blank reply bubble, tokens billed | reasoning consumed the cap | prose branch: raise the cap, retry once with thinking off |
| Literal `**` visible in a reply | text inserted before escaping | escape first, format second |
| Every conversation named 新对话 | title never derived from content | name from the first user turn |
| `Identifier 'x' has already been declared` at boot | chat helper shadows an auth helper | alias at import |
| Skill switch appears on but behaviour is unchanged | flag stored, prompt not filtered | filter injected text by the flag |
| Deleted conversation still costs storage | messages not cascaded | delete both in one operation |
| Stop button stops the UI, reply keeps generating | abort bound to `req` close (fires on body read, or already fired) | bind `res.on("close")` |
| Reasoning text appears in the reply | forwarded `reasoning_content` deltas | forward `content` only; show a thinking state |
| Token ledger stays at zero in chat | streamed request omitted `include_usage` | request usage on the final chunk |
| Streamed reply renders as one jump | proxy buffering, not a code fault | send `x-accel-buffering: no` **and** verify growth over the public URL |
| Blank reply bubble after a stop | placeholder row kept when nothing was generated | delete it when no text arrived |
