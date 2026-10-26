# Local Run and Public Handover

Read this when running the app on a VM and handing over a URL (steps 6 and 7 of `defi-fact-pipeline`). It holds the environment constraints and the delivery checks; the pipeline rules themselves stay in SKILL.md.

## Runtime choice

Node 24 executes `.ts` directly and ships `node:sqlite`, so a zero-dependency stack fits a small VM where a framework build would OOM. Prefer it until the box has headroom.

## Restarting a dev server

`pkill -f "app/server.ts"` also matches the shell running that command and kills the exec session with SIGTERM. Free the port and detach instead:

```bash
fuser -k 3000/tcp; sleep 1
setsid nohup node app/server.ts > /tmp/lp-server.log 2>&1 < /dev/null &
sleep 3; curl -s localhost:3000/api/health
```

Verify a TypeScript module by importing it, not with `node --check`. The flag checks JS and reports nothing useful about a `.ts` file, so it passes on code that will throw on load:

```bash
node --input-type=module -e "import('./core/db.ts')"
```

**A local variable can shadow the imported helper it calls.** `const body = await body(req)` reads as an ordinary assignment and fails with `Cannot access 'body' before initialization` — a temporal-dead-zone error, because the local `const` is hoisted and the initializer can no longer see the import. The message points at a variable read before init, not at the shadowing, so it sends you looking at the wrong line. Rename the local (`const b = ...`). Any time a helper is named after its payload — `body`, `data`, `result` — check the call site before trusting the error text.

**The same blind spot applies to slicing edits in plain JS.** Replacing a block by index/`slice` produced two calls to a function that was never defined, and `node --check` passed because the file was still syntactically valid. A syntax check answers "will it parse", never "does it still say what I meant". After any surgical replacement, read the changed region back and confirm the call sites and definitions pair up — the compiler will not do it for you.

SQL held in a template literal must not contain a backtick. A backtick inside a SQL comment closes the template early, and the error surfaces as a TypeScript syntax complaint pointing at the SQL text — which reads like a parser bug rather than an escaping one. Use a plain `--` comment without backticks.

In SQLite, string literals take **single** quotes only. Writing `role="user"` inside a query lets the engine read `"user"` as an identifier and fail with `no such column: "user"` — the same family of error, one layer down, and it reads like a missing column rather than a quoting mistake. Reserve double quotes for identifiers, single quotes for values.

Never `.unref()` a Promise. `setInterval(fn, ms)` returns a timer and `.unref()` on it is correct, but a refresh helper returning a Promise is not a timer: chaining `.unref()` onto it throws `TypeError: ... .unref is not a function` from *inside* the timer callback. The process starts cleanly and dies on the first tick, so a short smoke test never sees it. Keep `.unref()` on the timer only, put a `.catch()` on the promise, and let the server survive past one full interval before calling a scheduled job done.

A tool payload can arrive masked. Writing a line that builds a session token — `randomBytes(18).toString("base64url")` — landed on disk as `***"base64url")`, twice in one session, and the loader reported `Expression expected` at that line. The symptom points at the syntax, not at the payload. When a line containing a credential-looking expression is suddenly malformed, read the file back before debugging the logic, and rewrite the statement in smaller pieces (assign the bytes, then encode) so a masked fragment cannot swallow the surrounding call.

## Verifying layout, not just rendering

A page can render correctly and still be unusable: content past the fold is unreachable when nothing scrolls.

```css
/* broken: the implicit grid row is sized by its content */
.shell { display: grid; grid-template-columns: 232px 1fr 300px; height: 100vh; }

/* fixed: pin the row track so a tall column cannot grow the grid */
.shell { grid-template-rows: minmax(0, 1fr); }
.main  { min-height: 0; }
```

With `body { overflow: hidden }` that implicit row lets the grid exceed `100vh`; the overflow is clipped rather than scrollable, and the inner `.scroll` reports `scrollHeight === clientHeight`, so it never shows a scrollbar either. A screenshot at a fixed viewport looks correct because it shows only the visible slice — this is exactly the class of fault a picture hides.

Measure instead of trusting the picture:

```js
const s = document.querySelector('.scroll');
s.scrollHeight > s.clientHeight;   // true whenever content exceeds the view
s.scrollTop = 1e6; s.scrollTop;    // must move away from 0
```

Do this whenever a list can grow — positions, events, cards. Check every container in the chain: `min-height: 0` on the flex/grid parent is what allows the child to scroll at all.

**A flex-basis on a child of a column container is a height, not a width.** Writing `flex: 1 1 320px` to mean "minimum width" inside a `flex-direction: column` parent sets a 320px *block size*: one line of headline text expanded into ~320px of empty space and pushed the real content off the card (measured: card 948px, headline 320px, actual text height 22px). Fix by removing the basis and letting the row-level wrapper govern width (`min-width: 0`). When an unexplained band of whitespace appears, measure the parent's computed `flex-direction` and each child's height before touching any spacing value — the fault is usually the axis, not the number.

**Cap long repeated lists and fold the rest.** A card whose event log grows with every action ends up taller than the screen and pushes its own buttons out of reach. Render the newest few, put the remainder behind `<details>` — native, no JS state, and the collapsed height stays stable as history accumulates. Prefer the count in the summary ("查看更早的 4 条") so the user knows what is hidden.

## Auditing a build against stated requirements

Read this when asked whether a flow is finished, or when reporting progress on a multi-step build. The failure mode is not lying — it is summarising from memory a tree that has since diverged from the plan.

Walk the requirement list and check each item in the source, not in recollection:

- **A nav entry pointing at `href="#"` is an unimplemented page.** These accumulate silently because clicking one reloads the current screen instead of erroring. Grep the nav markup for `href="#"` and treat each as missing work.
- **A capability exists only if something imports and calls it.** Finding the helper is not evidence: grep for the consumer. Verified here — a scoring override was exported and unit-tested, imported by the plan module alone, and the feed module held zero references to it, so the feed was never personalised while the profile that would drive it existed. The helper's presence had been read as the feature's presence.
- **A stored table is not a running job.** A scheduler that ingests on a timer says nothing about whether positions are monitored; check which functions the timers call, not that timers exist.
- **A data column is not a feature.** Fields for realized PnL or cash-back being present does not mean the arithmetic that uses them is wired into the response the page reads.
- **A rendered control is not a wired control.** A `<button>` carrying only a class is decoration: no `id`, no `data-act`, no listener, nothing happens and nothing errors. It hides because its neighbours are real — the pool drawer's two dead buttons sat beside a working `GeckoTerminal ↗` `<a href>`, so the pair read as a styling choice rather than an unimplemented action. Grep the binding (`getElementById('btnX')`, `data-act`, `addEventListener`) for every control you claim works; no hits means unimplemented. The same test catches its link-shaped twin: a `href` whose target page reads no query parameter is live markup with a dead action. That one recurred across two features in the same build (a board's 查看 link, then a chat deep link), so check the destination's reader, not just the presence of the URL.
- **A reader is not a writer.** A table already consumed by the read path looks half-built, not unbuilt: `watchlist` scored news relevance and so read as a feature, while nothing ever inserted a row — zero rows, no write route, and a 关注 button with nowhere to save. For every write-shaped control, name the endpoint and the INSERT/UPDATE behind it. A table with consumers and no rows is the signature.

Report per item: status, and the module or file that proves it. A terse "four steps complete" that a ten-minute grep contradicts is worse than a longer honest table, because the user discovers the gap later, mid-decision, and has to re-audit everything you claimed.

Also treat your own inspection output as suspect before calling a page broken. Printing an object with `String(obj)` yields `[object Object]`; reading that as a rendering fault sends you into the template for a data-shape problem that does not exist. Read the parsed fields.

A DOM assertion that returns empty or identical before/after states is usually the same mistake one layer over: the control is gone because an earlier step swapped the view. A toggle measured as `{before:{}, after:{}, back:{}}` was a *working* button queried after the drawer had been switched to the plan form. Assert the control exists before asserting what it does; when both states are empty, re-open the view and measure again before touching the code.

### Leave the data as you found it

Verification writes: watch rows, chat sessions, plans, and any setting you flipped to exercise a path (an automation kill switch, a debug flag). Clean them before reporting, and state what was removed. A leftover test row is not cosmetic — a fake 关注 entry changes relevance scores, and a switch left on is unattended trading the user believes is off.

Delete by the specific keys the test created, never by a broad predicate that could match real rows. Report counts before and after (`清理测试关注: 1 条 | 剩余: 0`) so "cleaned" is a measured fact rather than a claim.

Complete when: the tables and settings your test touched match their pre-test counts, and the report names each item restored.

## Making it reachable

A 200 on `localhost` is not a delivery. This user asks "why didn't you give me a URL" when the page exists only on the box, and treats an unreachable link as unfinished work.

- Test reachability from off-host before promising a URL. `curl` the public IP from the host; `000` means inbound is blocked. Cloud VMs commonly allow SSH and nothing else, and a default-ACCEPT `iptables` policy still routes through a provider chain.
- When inbound is blocked, tunnel rather than editing firewall rules. Fetch the `cloudflared` release binary (no package on a minimal VM), then:

  ```bash
  cloudflared tunnel --url http://localhost:<port> --no-autoupdate
  ```

  Read the assigned `https://*.trycloudflare.com` hostname from its log.
- Verify through the tunnel, not locally: fetch health and the page over the public URL, then screenshot that URL. Localhost success hides absolute-URL, mixed-content and routing faults.
- Quick tunnels are ephemeral — a new random hostname on every restart. State the lifetime whenever handing one over; a URL that silently stopped working reads as a broken app.
- Diagnose by layer before debugging code: `localhost` answering 200 while the public URL returns 530 or shows a Cloudflare interstitial means the tunnel process died, not that the app broke. Check the process, restart it, expect a new hostname, and re-verify the gate on the new one.

## Gate before publishing

State the auth posture in the same message, and gate **before** handing over — a tunnel publishes whatever the app serves.

"Never tunnel a host holding credentials" is the wrong rule here: the host holds an API key, so it would forbid this very setup. The rule that holds is that nobody reaches the credential without passing the gate, and a spend cap bounds the paid call even when the credential is shared — count real model calls only, persist the count, return 429 with the reason.

The gate must exempt the login page **and its assets**. An allowlist holding `/login` but not `/login.css` leaves that CSS behind the gate, and the page renders as unstyled HTML while every API auth check still passes.

Read `auth-gate.md` for the credential and session implementation that held up, the five verification checks, and the shell pitfall that makes a correct password look wrong.

## Completion

The public URL returns health, the page renders in a screenshot taken from that URL, and the message states the link's lifetime and whether it is protected.

If gated, run all five checks in `auth-gate.md` — the first three pass even when the gate is broken.
