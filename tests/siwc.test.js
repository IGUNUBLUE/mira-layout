import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, chmodSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as siwc from "../mods/mira-changes/siwc.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(claims) {
  const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" }), body = b64(claims);
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
function tempDir() { const d = mkdtempSync(join(tmpdir(), "mira-siwc-")); chmodSync(d, 0o700); return d; }

test("loginAttempt: first registration vs returning account", () => {
  const first = siwc.loginAttempt({ redirectUri: "http://127.0.0.1:1455/auth/callback", host: "urn:uuid:0", registration: undefined });
  const u = new URL(first.url);
  assert.equal(u.origin + u.pathname, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(u.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(u.searchParams.get("agent_name_hint"), "Herdr Commit");
  assert.equal(u.searchParams.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(u.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), first.state);
  const again = siwc.loginAttempt({ redirectUri: "http://127.0.0.1:5000/auth/callback", host: "urn:uuid:0", registration: { client_id: "oaiapp_1", id_token: "t", email: "a@b" } });
  const v = new URL(again.url);
  assert.equal(v.searchParams.get("client_id"), "oaiapp_1");
  assert.equal(v.searchParams.get("agent_name_hint"), null);
  assert.equal(v.searchParams.get("id_token_hint"), "t");
  assert.throws(() => siwc.loginAttempt({ redirectUri: "http://localhost:1/auth/callback", host: "h" }), /127\.0\.0\.1/);
});

test("checkCallback validates state, errors and the issued client id", () => {
  const a = siwc.loginAttempt({ redirectUri: "http://127.0.0.1:1455/auth/callback", host: "h" });
  const cb = (q) => new URL(`http://127.0.0.1:1455/auth/callback?${new URLSearchParams(q)}`);
  assert.deepEqual(siwc.checkCallback(a, cb({ state: a.state, code: "c", client_id: "oaiapp_9" })), { code: "c", clientId: "oaiapp_9" });
  assert.throws(() => siwc.checkCallback(a, cb({ state: "x", code: "c", client_id: "oaiapp_9" })), /state/);
  assert.throws(() => siwc.checkCallback(a, cb({ state: a.state, error: "access_denied" })), /declined/);
  assert.throws(() => siwc.checkCallback(a, cb({ state: a.state, code: "c" })), /client id/);
  const r = siwc.loginAttempt({ redirectUri: "http://127.0.0.1:1455/auth/callback", host: "h", registration: { client_id: "oaiapp_1" } });
  assert.equal(siwc.checkCallback(r, cb({ state: r.state, code: "c" })).clientId, "oaiapp_1");
  assert.throws(() => siwc.checkCallback(r, cb({ state: r.state, code: "c", client_id: "oaiapp_2" })), /different client/);
});

test("verifyIdToken checks signature, issuer, audience, expiry and nonce", async () => {
  const good = idToken({ iss: "https://auth.openai.com", aud: "oaiapp_1", sub: "u1", exp: now() + 60, iat: now(), nonce: "n" });
  assert.equal((await siwc.verifyIdToken(good, { audience: "oaiapp_1", nonce: "n" }, [jwk])).sub, "u1");
  await assert.rejects(siwc.verifyIdToken(good, { audience: "other", nonce: "n" }, [jwk]), /client/);
  await assert.rejects(siwc.verifyIdToken(good, { audience: "oaiapp_1", nonce: "m" }, [jwk]), /nonce/);
  const expired = idToken({ iss: "https://auth.openai.com", aud: "oaiapp_1", sub: "u1", exp: now() - 60 });
  await assert.rejects(siwc.verifyIdToken(expired, { audience: "oaiapp_1" }, [jwk]), /expired/);
  const [h, p] = good.split(".");
  await assert.rejects(siwc.verifyIdToken(`${h}.${p}.${Buffer.from("nope").toString("base64url")}`, { audience: "oaiapp_1" }, [jwk]), /signature/);
});

test("sessionFrom requires the plan scopes", () => {
  const tokens = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope: "openid email" };
  assert.throws(() => siwc.sessionFrom(tokens, { clientId: "c", host: "h", subject: "u" }), /plan usage/);
  const s = siwc.sessionFrom({ ...tokens, scope: siwc.SCOPE }, { clientId: "c", host: "h", subject: "u" });
  assert.equal(s.access_token, "a");
  assert.ok(s.expires_at > Date.now());
});

test("protected files: written 0600 in a 0700 dir, and loose permissions are refused", async () => {
  const dir = tempDir();
  try {
    await siwc.writeJson("x.json", { a: 1 }, dir);
    assert.equal(statSync(join(dir, "x.json")).mode & 0o777, 0o600);
    assert.deepEqual(await siwc.readJson("x.json", dir), { a: 1 });
    writeFileSync(join(dir, "loose.json"), "{}"); chmodSync(join(dir, "loose.json"), 0o644);
    await assert.rejects(siwc.readJson("loose.json", dir), /mode 600/);
    const id = await siwc.hostId(dir);
    assert.match(id, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(await siwc.hostId(dir), id, "host id is stable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("accessToken returns a fresh token, refreshes a stale one, and reports a missing session", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(siwc.accessToken({ dir }), (e) => e.code === 3);
    const base = { issuer: siwc.ISSUER, subject: "u1", client_id: "oaiapp_1", ext_agent_host_id: "h", refresh_token: "r1", scopes: siwc.SCOPE.split(" ") };
    await siwc.writeJson("session.json", { ...base, access_token: "fresh", expires_at: Date.now() + 3600_000 }, dir);
    assert.equal(await siwc.accessToken({ dir, send: () => { throw new Error("no network expected"); } }), "fresh");
    await siwc.writeJson("session.json", { ...base, access_token: "stale", expires_at: Date.now() + 1000 }, dir);
    const calls = [];
    const send = async (url, init) => {
      calls.push([url, String(init?.body ?? "")]);
      if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
      return Response.json({ access_token: "new", refresh_token: "r2", token_type: "Bearer", expires_in: 3600, scope: siwc.SCOPE,
        id_token: idToken({ iss: siwc.ISSUER, aud: "oaiapp_1", sub: "u1", exp: now() + 60 }) });
    };
    assert.equal(await siwc.accessToken({ dir, send }), "new");
    assert.match(calls[0][1], /grant_type=refresh_token/);
    assert.match(calls[0][1], /refresh_token=r1/);
    assert.equal((await siwc.readJson("session.json", dir)).refresh_token, "r2", "rotated refresh token saved");
    await siwc.writeJson("session.json", { ...base, access_token: "stale", expires_at: 0 }, dir);
    await assert.rejects(siwc.accessToken({ dir, send: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) }), (e) => e.code === 4);
    assert.equal(await siwc.readJson("session.json", dir), undefined, "revoked session removed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("listModels keeps displayable models in server order", () => {
  assert.deepEqual(siwc.listModels({ models: [{ slug: "a", display_name: "A", visibility: "list" }, { slug: "h", visibility: "hide" }, { slug: "b" }] }),
    [{ slug: "a", display_name: "A" }, { slug: "b", display_name: "b" }]);
});
