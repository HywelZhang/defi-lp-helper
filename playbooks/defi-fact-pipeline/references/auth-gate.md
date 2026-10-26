# Auth Gate Implementation

Read this when step 7 says the site needs a login gate. It records the implementation that held up, and the failure modes it avoids.

## Threat model that matters here

The link is the perimeter. A tunnel publishes whatever the app serves, so the realistic risks are:

1. Anyone with the URL uses the paid AI endpoint and burns the API budget.
2. Someone with the URL reads position or portfolio data.
3. The URL leaks further (chat logs, screenshots) and the same two problems widen.

Login addresses (1) and (2). A spend cap addresses (1) independently, because a shared or leaked credential still bounds loss. Do both — the gate alone does not bound spend.

## Credential storage

- Store only a scrypt hash. Never plaintext, never in the repo, never in a client bundle.
- Format that works: `scrypt$N$r$p$saltB64$hashB64`, verified with `timingSafeEqual`.
- File mode `0600`, written by a CLI that reads the password from an environment variable — not from argv, which lands in shell history and the process list.
- Set env vars in the invocation, not exported into the shell: `LP_USER=... LP_PASS=... node cli/set-password.ts`.

## Sessions

- Random 32-byte token in the cookie; store only its SHA-256. A copied database then yields no live session.
- Server-side rows with `expires_at`; delete expired rows on read and periodically.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`. Add `Secure` only when the request arrived over HTTPS — behind a tunnel, decide from `x-forwarded-proto`, which the tunnel sets, not from the local socket.

## Login endpoint

- Per-IP lockout after ~5 failures (15 min works). Without it, a public link is a brute-force target.
- On an unknown username, still run one hash verify against a dummy value. Returning early makes response timing an account oracle.
- One error message for both wrong-user and wrong-password.
- Response shape identical enough on both paths that the caller cannot distinguish them.

## Public allowlist

The gate must exempt the login page **and its assets**:

```
/login, /login.css, /api/auth/login, /api/auth/status, /favicon.ico
```

Symptom when the asset is missed: every auth check passes, but the browser's request for `/login.css` gets a 302 to `/login`, so the login page renders as unstyled HTML. It looks like a CSS bug and reads as "the styling broke", sending you into the stylesheet instead of the allowlist.

Gate the app shell and assets too — leaving `/app.js` open lets anyone read API shapes without logging in.

## Spend cap

- Count only real model calls; a cache hit is free and must not consume quota.
- Persist the counter (a daily row), so a restart does not reset the day's usage.
- Enforce before enqueuing the expensive job and return 429 with the reason, so the UI can show why rather than failing silently.

## Verifying the gate

Run all five; the first three pass even when the gate is broken:

1. Unauthenticated page request → 302 to the login page.
2. Unauthenticated API request → 401.
3. Correct login → session cookie set, subsequent request succeeds.
4. Login page renders **styled** in a screenshot taken over the public URL.
5. Wrong password → 401; repeated failures → 429.

## Testing the login endpoint from a shell

Write the JSON body to a file and pass `-d @body.json`.

An inline credential can be masked in the command before it runs, so the request carries a different secret than intended. Every attempt then returns the same auth failure, which is indistinguishable from a real bug and sends you debugging working code. Confirm the password against the stored hash separately (`verifyPassword(pw, record.hash)`) before concluding the endpoint is broken.
