#!/usr/bin/env node
/**
 * Set the login credential.
 *
 *   LP_USER=admin LP_PASS='...' node cli/set-password.ts
 *
 * Reads from env rather than argv so the password never lands in shell history
 * or in the process list.
 */

import { saveAuth, loadAuth, authConfigured, hashPassword } from "../core/auth.ts";

const user = process.env.LP_USER;
const pass = process.env.LP_PASS;

if (!user || !pass) {
  console.error("usage: LP_USER=... LP_PASS=... node cli/set-password.ts");
  process.exit(1);
}

if (pass.length < 12) {
  console.error("password must be at least 12 characters");
  process.exit(1);
}

const existing = loadAuth();
saveAuth(user, pass);

console.log(`credential saved for user "${user}"`);
console.log(`  previous: ${existing ? `"${existing.username}" (since ${new Date(existing.createdAt).toISOString()})` : "none"}`);
console.log(`  hash:     ${hashPassword("x").slice(0, 7)}... (scrypt, N=16384)`);
console.log(`  sessions: existing sessions remain valid until they expire`);
console.log(`  configured: ${authConfigured()}`);
