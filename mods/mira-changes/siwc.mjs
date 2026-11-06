#!/usr/bin/env node
// Sign in with ChatGPT ("ChatGPT plan usage" for open-source, locally hosted apps) for the
// mira layout's commit messages. Node 24, no dependencies.
//
//   node siwc.mjs login [--no-open] [--port N]   register/authorize in the browser, save the session
//   node siwc.mjs token                          print a valid access token (refreshing it if needed)
//   node siwc.mjs status                         print {signedIn, email, model} as JSON (no secrets)
//   node siwc.mjs models                         print the account's models as JSON [{slug, display_name}]
//   node siwc.mjs model <slug>                   choose the model the panel uses
//   node siwc.mjs logout                         forget the session (keeps the registered client id)
//
// Docs: https://developers.openai.com/siwc/token-sharing-open-source
// Files: ~/.config/mira-layout/ (0700): host.json, session.json, registration.json, config.json (0600).
// Exit codes: 0 ok, 1 error, 3 not signed in, 4 session no longer valid (sign in again).

import { createHash, randomBytes, randomUUID, createPublicKey, verify as verifySignature } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, lstat, open, rename, rm, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const AGENT_NAME = "Herdr Commit";
const PLAN_SCOPES = ["resource.invoke", "chatgpt.tokens.use.direct"];
const DIR = process.env.MIRA_LAYOUT_HOME ?? join(homedir(), ".config", "mira-layout");

export class ExitError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }

// ---------- protected files ----------

async function ensureDir(dir = DIR) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await lstat(dir);
  if (s.isSymbolicLink() || !s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700)
    throw new ExitError(`${dir} must be a directory owned by you with mode 700.`);
}

export async function readJson(name, dir = DIR) {
  const path = join(dir, name);
  let handle;
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink() || !s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600)
      throw new ExitError(`${path} must be a file owned by you with mode 600.`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e instanceof ExitError ? e : new ExitError(`Cannot read ${path}: ${e.message}`);
  } finally { await handle?.close(); }
}

export async function writeJson(name, data, dir = DIR) {
  await ensureDir(dir);
  const path = join(dir, name), temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temp, path);
  } finally { await handle?.close(); await rm(temp, { force: true }); }
}

/** One process at a time refreshes or signs in: refresh tokens rotate. */
async function withLock(fn, dir = DIR) {
  await ensureDir(dir);
  const path = join(dir, "session.lock");
  for (let attempt = 0; ; attempt++) {
    try {
      const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await h.writeFile(String(process.pid)); await h.close();
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      let alive = false;
      try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch {}
      if (!alive) { await rm(path, { force: true }); continue; }
      if (attempt > 100) throw new ExitError("Another sign-in or refresh is still running.");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { await rm(path, { force: true }); }
}

export async function hostId(dir = DIR) {
  const stored = await readJson("host.json", dir);
  if (stored?.id) {
    if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(stored.id)) throw new ExitError("host.json has an invalid host id.");
    return stored.id;
  }
  const id = `urn:uuid:${randomUUID()}`;
  await writeJson("host.json", { id }, dir);
  return id;
}

// ---------- OAuth ----------

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** A fresh authorization attempt (state, nonce, PKCE) and its URL. */
export function loginAttempt({ redirectUri, host, registration }) {
  const uri = new URL(redirectUri);
  if (uri.protocol !== "http:" || uri.hostname !== "127.0.0.1" || uri.pathname !== "/auth/callback" || uri.search || uri.hash)
    throw new ExitError("The callback must be http://127.0.0.1:<port>/auth/callback.");
  const state = b64url(randomBytes(32)), nonce = b64url(randomBytes(32)), verifier = b64url(randomBytes(64));
  const params = {
    client_id: registration?.client_id ?? "dynamic_agent_client",
    ext_agent_host_id: host,
    ...(registration ? {} : { agent_name_hint: AGENT_NAME }),
    ...(registration?.id_token ? { id_token_hint: registration.id_token } : {}),
    ...(registration?.email ? { login_hint: registration.email } : {}),
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state, nonce,
    code_challenge_method: "S256",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
  };
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams(params).toString();
  return { url: url.toString(), redirectUri, host, state, nonce, verifier, registration, expiresAt: Date.now() + 5 * 60_000 };
}

/** Validates the callback; returns { code, clientId }. Throws on mismatch, error or missing pieces. */
export function checkCallback(attempt, callback) {
  if (Date.now() > attempt.expiresAt) throw new ExitError("The sign-in took too long; start it again.");
  if (callback.searchParams.get("state") !== attempt.state) throw new ExitError("The sign-in answer doesn't match this attempt (state).");
  const error = callback.searchParams.get("error");
  if (error) throw new ExitError(error === "access_denied" ? "Sign-in was declined." : `Sign-in failed: ${error}`);
  const issued = callback.searchParams.get("client_id");
  const clientId = attempt.registration?.client_id ?? issued;
  if (attempt.registration && issued && issued !== attempt.registration.client_id) throw new ExitError("ChatGPT returned a different client than the one registered; not replacing it.");
  if (!clientId || clientId === "dynamic_agent_client") throw new ExitError("ChatGPT didn't return the registered client id; registration is incomplete.");
  const code = callback.searchParams.get("code");
  if (!code) throw new ExitError("The sign-in answer has no authorization code.");
  return { code, clientId };
}

async function tokenRequest(form, send = fetch) {
  const r = await send(`${ISSUER}/api/accounts/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new ExitError(`ChatGPT refused the token request (${r.status}${body.error ? `: ${body.error}` : ""}).`, r.status === 400 || r.status === 401 ? 4 : 1);
    err.oauth = body.error;
    throw err;
  }
  return body;
}

let jwksCache;
async function jwks(send = fetch) {
  if (!jwksCache) {
    const r = await send(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new ExitError(`Cannot read OpenAI's signing keys (${r.status}).`);
    jwksCache = (await r.json()).keys ?? [];
  }
  return jwksCache;
}

/** Verifies an OpenAI ID token (RS256 against the JWKS); returns its payload. */
export async function verifyIdToken(token, { audience, nonce }, keys) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new ExitError("The ID token is malformed.");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (header.alg !== "RS256") throw new ExitError(`Unexpected ID token algorithm ${header.alg}.`);
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : null);
  if (!jwk) throw new ExitError("The ID token's signing key isn't published by OpenAI.");
  const ok = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new ExitError("The ID token's signature is invalid.");
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== ISSUER) throw new ExitError("The ID token has the wrong issuer.");
  if (!aud.includes(audience)) throw new ExitError("The ID token isn't for this client.");
  if (typeof payload.exp !== "number" || payload.exp + 5 < now) throw new ExitError("The ID token has expired.");
  if (nonce && payload.nonce !== nonce) throw new ExitError("The ID token doesn't match this sign-in (nonce).");
  if (typeof payload.sub !== "string" || !payload.sub) throw new ExitError("The ID token has no subject.");
  return payload;
}

/** Token response → stored session. Checks the plan scopes and bearer type. */
export function sessionFrom(tokens, { clientId, host, subject, email, previous }) {
  const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
  if (!PLAN_SCOPES.every((s) => scopes.includes(s))) throw new ExitError("ChatGPT plan usage wasn't authorized for this app. Sign in again and allow it.", 4);
  if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new ExitError("The token response has no access token.");
  if (tokens.token_type && String(tokens.token_type).toLowerCase() !== "bearer") throw new ExitError("Unexpected token type.");
  const refresh = tokens.refresh_token ?? previous?.refresh_token;
  if (!refresh) throw new ExitError("The token response has no refresh token.");
  const expiresIn = Number(tokens.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new ExitError("The token response has no valid expiry.");
  return {
    issuer: ISSUER, subject, email: email ?? previous?.email ?? null, client_id: clientId, ext_agent_host_id: host,
    access_token: tokens.access_token, refresh_token: refresh, id_token: tokens.id_token ?? previous?.id_token ?? null,
    scopes, expires_at: Date.now() + expiresIn * 1000, saved_at: new Date().toISOString(),
  };
}

export async function refreshSession(session, send = fetch) {
  const tokens = await tokenRequest({ grant_type: "refresh_token", client_id: session.client_id, refresh_token: session.refresh_token, resource: RESOURCE }, send);
  let subject = session.subject, email = session.email;
  if (tokens.id_token) {
    const payload = await verifyIdToken(tokens.id_token, { audience: session.client_id }, await jwks(send));
    if (payload.sub !== session.subject) throw new ExitError("The refreshed session belongs to another account.", 4);
    email = payload.email ?? email;
  }
  return sessionFrom(tokens, { clientId: session.client_id, host: session.ext_agent_host_id, subject, email, previous: session });
}

/** A valid access token, refreshed (and saved) when less than a minute is left. */
export async function accessToken({ dir = DIR, send = fetch } = {}) {
  let session = await readJson("session.json", dir);
  if (!session) throw new ExitError("Not signed in with ChatGPT.", 3);
  if (session.expires_at - Date.now() > 60_000) return session.access_token;
  return withLock(async () => {
    session = await readJson("session.json", dir); // another process may have refreshed meanwhile
    if (!session) throw new ExitError("Not signed in with ChatGPT.", 3);
    if (session.expires_at - Date.now() > 60_000) return session.access_token;
    try {
      const next = await refreshSession(session, send);
      await writeJson("session.json", next, dir);
      return next.access_token;
    } catch (e) {
      if (e.oauth === "invalid_grant" || e.code === 4) await rm(join(dir, "session.json"), { force: true });
      throw e.code === 4 || e.oauth ? new ExitError("The ChatGPT session is no longer valid. Sign in again.", 4) : e;
    }
  }, dir);
}

// ---------- commands ----------

function openBrowser(url) {
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.log("Open the link above in your browser."));
  child.unref();
}

async function login(args) {
  const noOpen = args.includes("--no-open");
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 1455;
  return withLock(async () => {
    const host = await hostId();
    const registration = await readJson("registration.json");
    let attempt, settle;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const server = createServer(async (req, res) => {
      const callback = new URL(req.url ?? "/", attempt.redirectUri);
      if (callback.pathname !== "/auth/callback") { res.writeHead(404); res.end(); return; }
      if (callback.searchParams.get("state") !== attempt.state) { res.writeHead(400); res.end("This sign-in link is not the current one."); return; }
      try {
        const { code, clientId } = checkCallback(attempt, callback);
        const tokens = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE });
        if (!tokens.id_token) throw new ExitError("ChatGPT didn't return a signed identity.");
        const payload = await verifyIdToken(tokens.id_token, { audience: clientId, nonce: attempt.nonce }, await jwks());
        if (registration?.subject && registration.subject !== payload.sub) throw new ExitError("You signed in with a different ChatGPT account than the registered one. Run logout --forget to register another.");
        const session = sessionFrom(tokens, { clientId, host, subject: payload.sub, email: payload.email });
        await writeJson("session.json", session);
        await writeJson("registration.json", { client_id: clientId, subject: payload.sub, email: payload.email ?? null, id_token: tokens.id_token });
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("Herdr Commit is connected to ChatGPT. You can close this tab.");
        settle.resolve(session);
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end(`Sign-in failed: ${e.message}`);
        settle.reject(e);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && portArg < 0) { server.listen(0, "127.0.0.1", resolve); return; }
        reject(new ExitError(`Cannot listen on 127.0.0.1:${port}: ${e.message}`));
      });
      server.listen(port, "127.0.0.1", resolve);
    });
    attempt = loginAttempt({ redirectUri: `http://127.0.0.1:${server.address().port}/auth/callback`, host, registration });
    console.log("Sign in with ChatGPT to let Herdr Commit use your ChatGPT plan for commit messages.");
    console.log("Only the staged diff of the repository you're in is sent, when you click ✦.\n");
    console.log(attempt.url + "\n");
    if (!noOpen) openBrowser(attempt.url);
    const timer = setTimeout(() => settle.reject(new ExitError("The sign-in expired after 5 minutes; run it again.")), 5 * 60_000);
    try {
      const session = await done;
      console.log(`Signed in${session.email ? ` as ${session.email}` : ""}. You can close this terminal.`);
    } finally { clearTimeout(timer); server.close(); }
  });
}

async function models() {
  const token = await accessToken();
  const r = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 401) throw new ExitError("The ChatGPT session is no longer valid. Sign in again.", 4);
  if (!r.ok) throw new ExitError(`Cannot read your plan's models (${r.status}).`);
  return listModels(await r.json());
}

/** The catalog's displayable models, in server order. */
export function listModels(catalog) {
  const list = Array.isArray(catalog?.models) ? catalog.models : Array.isArray(catalog?.data) ? catalog.data : [];
  return list.filter((m) => typeof m?.slug === "string" && (m.visibility === undefined || m.visibility === "list"))
    .map((m) => ({ slug: m.slug, display_name: m.display_name ?? m.slug }));
}

async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "login": await login(args); return;
    case "token": process.stdout.write(await accessToken()); return;
    case "status": {
      const session = await readJson("session.json"), config = (await readJson("config.json")) ?? {};
      console.log(JSON.stringify({ signedIn: Boolean(session), email: session?.email ?? null, model: config.model ?? null }));
      return;
    }
    case "models": console.log(JSON.stringify(await models())); return;
    case "model": {
      const slug = args[0];
      if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(slug)) throw new ExitError("Usage: siwc.mjs model <slug>");
      await writeJson("config.json", { ...((await readJson("config.json")) ?? {}), model: slug });
      return;
    }
    case "logout": {
      await rm(join(DIR, "session.json"), { force: true });
      if (args.includes("--forget")) await rm(join(DIR, "registration.json"), { force: true });
      console.log("Signed out.");
      return;
    }
    default:
      console.error("Usage: siwc.mjs login|token|status|models|model <slug>|logout [--forget]");
      process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof ExitError ? e.message : `Error: ${e.message}`);
    process.exitCode = e instanceof ExitError ? e.code : 1;
  });
}
