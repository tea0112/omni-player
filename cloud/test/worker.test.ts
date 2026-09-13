import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("worker router", () => {
  it("GET /api/me → 200 {email} qua SKIP_AUTH binding", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "dev@local" });
  });
  it("không set CORS headers (same-origin design)", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
  });
  it("route khác → ASSETS fetch (SPA fallback)", async () => {
    const res = await SELF.fetch("https://example.com/some-page");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.startsWith("text/html")).toBe(true);
  });
});
