import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/auth";
import { makeAccessJwt } from "./helpers_jwt";

let verifyAccess: (request: Request, env: Env) => Promise<{ email: string } | null>;


const env = { ACCESS_TEAM: "team", ACCESS_AUD: "aud123" } as any;

async function withJwks(jwks: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } })));
}

describe("verifyAccess", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Ngoại lệ dynamic import: jwksCache nằm ở mức module trong src/auth.ts; static import
    // chia sẻ cache giữa các test (kid của test trước không có trong JWKS test sau → null).
    vi.resetModules();
    ({ verifyAccess } = await import("../src/auth"));
  });
  it("401 khi thiếu header", async () => {
    expect(await verifyAccess(new Request("https://x/api/me"), env)).toBeNull();
  });
  it("pass với JWT RS256 hợp lệ, aud dạng mảng (payload thật của Access)", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: ["aud123", "other-aud"], email: "me@gmail.com" });
    await withJwks(jwks);
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    const v = await verifyAccess(req, env);
    expect(v).toEqual({ email: "me@gmail.com" });
  });
  it("pass với aud scalar string (một số parser phát kiểu string)", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "aud123", email: "me@gmail.com" });
    await withJwks(jwks);
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(await verifyAccess(req, env)).toEqual({ email: "me@gmail.com" });
  });
  it("null với aud sai", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "OTHER", email: "me@gmail.com" });
    await withJwks(jwks);
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).toBeNull();
  });
  it("null với aud array không chứa tag của mình", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: ["OTHER", "another"], email: "me@gmail.com" });
    await withJwks(jwks);
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).toBeNull();
  });
  it("null với token ES256 (Access không dùng)", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "aud123", email: "me@gmail.com", alg: "ES256" });
    await withJwks(jwks);
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).toBeNull();
  });
  it("null với iss sai (ACCESS_TEAM được set)", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "aud123", email: "me@gmail.com", iss: "https://evil.example.com" });
    await withJwks(jwks);
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).toBeNull();
  });
  it("pass khi iss sai nhưng ACCESS_TEAM rỗng (dev/test)", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "aud123", email: "me@gmail.com", iss: "https://evil.example.com" });
    await withJwks(jwks);
    const emptyTeam = { ACCESS_TEAM: "", ACCESS_AUD: "aud123" } as any;
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), emptyTeam)).toEqual({ email: "me@gmail.com" });
  });
  it("null với token hết hạn", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "aud123", email: "e@x", exp: Math.floor(Date.now() / 1000) - 100 });
    await withJwks(jwks);
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).toBeNull();
  });
});
