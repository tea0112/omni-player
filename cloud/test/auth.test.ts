import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyAccess } from "../src/auth";
import { makeAccessJwt } from "./helpers_jwt";

const env = { ACCESS_TEAM: "team", ACCESS_AUD: "aud123" } as any;

describe("verifyAccess", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("401 khi thiếu header", async () => {
    expect(await verifyAccess(new Request("https://x/api/me"), env)).toBeNull();
  });
  it("pass với JWT hợp lệ đúng aud", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "aud123", email: "me@gmail.com" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } })));
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    const v = await verifyAccess(req, env);
    expect(v).toEqual({ email: "me@gmail.com" });
  });
  it("null với aud sai", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "OTHER", email: "me@gmail.com" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(jwks))));
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).toBeNull();
  });
  it("null với token hết hạn", async () => {
    const { token, jwks } = await makeAccessJwt({ aud: "aud123", email: "e@x", exp: Math.floor(Date.now() / 1000) - 100 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(jwks))));
    expect(await verifyAccess(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": token } }), env)).toBeNull();
  });
});
