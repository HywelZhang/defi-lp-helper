# Streaming a Chat Turn

Read this when `ai-chat-surface` §6 has been decided (the wait is worth removing) and you are writing the transport. It holds the parts that break silently; §6 holds when streaming is justified and the two abort outcomes that decide what the transcript keeps.

## Transport: POST + SSE

`EventSource` is GET-only, and a chat turn carries a message body. Write the stream over `fetch` and read `res.body`:

```js
const res = await fetch("/api/chat/stream", {method: "POST", body: JSON.stringify({...})});
const reader = res.body.getReader();
```

Send `x-accel-buffering: no` — but do not treat a local `200` as proof (see "Prove it through the proxy").

## Abort: bind `res.on("close")`, never `req.on("close")`

This one cost a full debugging cycle. Measured on Node 24 with a minimal server:

```
req.on("close")  → +4ms    the request BODY was consumed; client still connected
res.on("close")  → +994ms  the client actually hung up
```

Worse, the `req` listener is normally registered *after* `await body(req)` has already drained the body, so it has fired and will never fire again — the abort is unreachable.

Symptom: the user presses stop, the UI says stopped, and the server keeps generating and **saves a complete answer the user never saw** (observed: a 1627-character reply persisted after a deliberate stop).

Attach to `res`, and guard on `!res.writableEnded`.

## Forward `content` only

Reasoning models emit `reasoning_content` deltas first, running to thousands of tokens. Never render them: count them for the truncation check and surface a "thinking…" state instead. The prose budget and why that state exists are `SKILL.md` §2.

## Usage must be requested explicitly

Ask for it in the final chunk:

```js
stream_options: {include_usage: true}
```

Without it the token ledger records zero, the daily budget never advances, and the spend cap in `SKILL.md` §5 silently stops working — the cap keeps returning 200 while nothing is being counted.

## Buffer incomplete frames on both ends

SSE frames are separated by a blank line and a chunk can land mid-frame. Keep the unterminated tail in a string and prepend it to the next read:

```js
buf += chunk;
const parts = buf.split("\n\n");
buf = parts.pop();           // keep the incomplete tail
for (const frame of parts) { /* parse data: lines */ }
```

Parsing per-chunk drops the split events. The same applies to the client reading the server's stream.

## Throttle rendering to one paint per frame

Providers emit one delta per character — for CJK that is literally one event per glyph, dozens per second. Accumulate into a string and repaint via `requestAnimationFrame`; writing `innerHTML` per delta re-lays-out continuously.

Escape before rendering here too: `SKILL.md` §3 owns that rule, and a streamed reply is the same untrusted prose.

## Persist as you go

Create the assistant row empty, patch its content as text accumulates, finalise on completion. A reply that vanishes on reload is worse than a slow one.

Whether the row survives an abort depends on whether any text arrived — the table in `SKILL.md` §6.

## Prove it through the proxy

`x-accel-buffering: no` plus a local `200` does not demonstrate streaming: a buffering proxy holds the whole response and renders it as one jump, which looks identical to a fast buffered reply.

Verify by watching text length grow on the **public URL** — measured `0 → 50 → 134 → 201 → 252 → 299`.

## Honest limit

No reconnect and no cross-tab sync: a dropped connection ends the turn, and two tabs each stream independently. Say so rather than implying resumability.
