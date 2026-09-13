# Omni Player Cloud Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** omni-player phát video từ R2 qua Worker sau Cloudflare Access, AI proxy giấu key, cache AI + vị trí xem đồng bộ KV — local-first giữ nguyên.

**Architecture:** 1 Worker (`cloud/`) phục vụ app (static assets) + routes `/v/*`, `/api/*`. Access che toàn hostname (Email OTP + Google); Worker tự verify Access JWT (defense-in-depth). WAF/rate limit ở edge (dashboard), rate limit binding ở Worker cho `/api/ai`.

**Tech Stack:** Cloudflare Workers (TS), R2, KV, Workers Static Assets, Rate Limiting binding, vitest-pool-workers, wrangler 4.13+.

**Spec:** `docs/superpowers/specs/2026-09-13-cloudflare-backend-design.md`

## Global Constraints

- Local-first không đổi: `file://` và `http://localhost` phải chạy y hệt hiện trạng; mọi tính năng cloud tắt im lặng khi không ở Worker.
- KHÔNG set header CORS nào trong Worker (same-origin design).
- Secrets chỉ nằm trong `wrangler secret put` / `.dev.vars`; `.dev.vars` phải nằm trong `.gitignore`; KHÔNG commit key.
- App vẫn là 1 file `index.html` ở repo root; bản deploy copy sang `cloud/public/` — không tách file JS.
- UI strings mới bằng tiếng Việt, đúng giọng hiện có.
- KV free 1k ghi/ngày → progress PUT throttle ≥30s; cache AI debounce 5s.
- KHÔNG chạy `wrangler login`, `wrangler deploy`, hay lệnh đổi dashboard — chỉ in hướng dẫn cho user khi cần account thật.
- `wrangler dev` dùng `SKIP_AUTH=1` từ `.dev.vars` (không bao giờ deploy biến này).

---

### Task 1: Scaffold `cloud/` — wrangler config, router skeleton, Access JWT verify

**Files:**
- Create: `cloud/wrangler.jsonc`, `cloud/src/worker.ts`, `cloud/src/auth.ts`, `cloud/test/worker.test.ts`, `cloud/test/auth.test.ts`, `cloud/vitest.config.ts`, `cloud/package.json`, `cloud/tsconfig.json`, `cloud/.gitignore`, `cloud/.dev.vars.example`
- Modify: `.gitignore` (thêm `cloud/.dev.vars`, `cloud/.wrangler/`)

**Interfaces:**
- Produces: `verifyAccess(request: Request, env: Env): Promise<{email: string} | null>` trong `cloud/src/auth.ts`; `Env` type (bindings `VIDEOS: R2Bucket`, `DATA: KVNamespace`, `AI_RL: RateLimit`, vars `ACCESS_TEAM`, `ACCESS_AUD`, `SKIP_AUTH?`); worker `default export { fetch }` router với route `GET /api/me` → `200 {email}` hoặc `401`.

- [ ] **Step 1: Scaffold + deps**

`cloud/package.json`:
```json
{
  "name": "omni-player-cloud",
  "private": true,
  "scripts": { "test": "vitest run", "dev": "wrangler dev", "deploy": "wrangler deploy" },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8",
    "@cloudflare/workers-types": "^4",
    "typescript": "^5",
    "vitest": "~3.2",
    "wrangler": "^4"
  }
}
```
Chạy `cd cloud && npm install`. `cloud/wrangler.jsonc`:
```jsonc
{
  "name": "omni-player",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-01",
  "assets": { "directory": "./public", "not_found_handling": "single-page-application", "binding": "ASSETS" },
  "r2_buckets": [{ "binding": "VIDEOS", "bucket_name": "omni-videos" }],
  "kv_namespaces": [{ "binding": "DATA", "id": "PLACEHOLDER_RUN_WRANGLER_KV_CREATE" }],
  "ratelimits": [{ "name": "AI_RL", "namespace": 1001, "limit": 30, "period": 60 }],
  "vars": { "ACCESS_TEAM": "", "ACCESS_AUD": "" },
  "workers_dev": false
}
```
(Ghi chú trong file: `PLACEHOLDER...` thay bằng id thật khi user chạy `wrangler kv namespace create DATA` — đọc output in ra.)

`cloud/vitest.config.ts`:
```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { SKIP_AUTH: "1" } },
      },
    },
  },
});
```
`cloud/.gitignore`: `.dev.vars`, `.wrangler/`, `node_modules/`, `public/index.html`.
`cloud/.dev.vars.example`: `SKIP_AUTH=1`.

- [ ] **Step 2: Write failing tests cho verifyAccess**

`cloud/test/auth.test.ts` — dùng WebCrypto sinh cặp key ES256 thật, ký JWT, stub `globalThis.fetch` trả JWKS:
```ts
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
    const { jwks } = await makeAccessJwt({ aud: "aud123", email: "me@gmail.com" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } })));
    const req = new Request("https://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": (await makeAccessJwt({ aud: "aud123", email: "me@gmail.com" })).token } });
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
```
`cloud/test/helpers_jwt.ts`:
```ts
export async function makeAccessJwt(o: { aud: string; email: string; exp?: number }) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwk = { kty: "EC", crv: "P-256", x: "", y: "", kid: "testkid", alg: "ES256", use: "sig" };
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  jwk.x = pub.x!; jwk.y = pub.y!;
  const payload = { aud: o.aud, email: o.email, exp: o.exp ?? Math.floor(Date.now() / 1000) + 600, iss: "https://team.cloudflareaccess.com" };
  const head = b64u(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "testkid" })).buffer as ArrayBuffer);
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return { token: `${head}.${body}.${b64u(sig)}`, jwks: { keys: [jwk] } };
}
```
Chạy `npm test` → FAIL (module `../src/auth` chưa tồn tại).

- [ ] **Step 3: Implement `src/auth.ts` + `src/worker.ts` skeleton**

`src/auth.ts`:
```ts
export interface Env {
  VIDEOS: R2Bucket; DATA: KVNamespace;
  AI_RL: { limit(n: { key: string }): Promise<{ success: boolean }> };
  ASSETS: { fetch(req: Request): Promise<Response> };
  ACCESS_TEAM: string; ACCESS_AUD: string; SKIP_AUTH?: string;
}
let jwksCache: { keys: JsonWebKey[]; at: number } | null = null;

function b64u(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (s.length % 4)) % 4;
  const bin = atob(s + "=".repeat(pad));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
export async function verifyAccess(request: Request, env: Env): Promise<{ email: string } | null> {
  if (env.SKIP_AUTH === "1") return { email: "dev@local" };
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_AUD) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const head = JSON.parse(new TextDecoder().decode(b64u(h)));
  if (head.alg !== "ES256") return null;
  const claims = JSON.parse(new TextDecoder().decode(b64u(p)));
  if (claims.aud !== env.ACCESS_AUD) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  if (!jwksCache || Date.now() - jwksCache.at > 300_000) {
    const r = await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    jwksCache = { keys: (await r.json()).keys, at: Date.now() };
  }
  const jwk = jwksCache.keys.find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
  return ok ? { email: claims.email ?? "" } : null;
}
```
`src/worker.ts`:
```ts
import { verifyAccess, type Env } from "./auth";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const me = await verifyAccess(request, env);
    if (!me) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/api/me") return json({ email: me.email });
    return env.ASSETS.fetch(request); // các route sau bổ sung trong task kế
  },
};

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
```
Chạy `npm test` → PASS (4 test).

- [ ] **Step 4: Commit**
```bash
git add cloud/ .gitignore && git commit -m "cloud: scaffold worker + Access JWT verify (tests)"
```

---

### Task 2: Stream video từ R2 — Range parse, 206/416/404, HEAD

**Files:**
- Create: `cloud/src/video.ts`, `cloud/test/video.test.ts`
- Modify: `cloud/src/worker.ts` (route `/v/*`), `cloud/wrangler.jsonc` (không đổi)

**Interfaces:**
- Consumes: `Env.VIDEOS` (R2Bucket), `verifyAccess` từ Task 1.
- Produces: `parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid"` — `null` = không có header (trả full), `"invalid"` = sai cú pháp/không khả thi (416); `handleVideo(request, env, name): Promise<Response>`; `handleHls(request, env, name): Promise<Response>` (chung core R2-get, khác cache-control + content-type theo đuôi: `.m3u8` → `application/vnd.apple.mpegurl` + `public,max-age=60`; `.ts` → `video/mp2t` + `public,max-age=31536000,immutable`; video thường → `private,max-age=0` như cũ).
- Routes: `/v/<file>` range-request file raw (fallback file không HLS); `/hls/<dir>/index.m3u8` + `/hls/<dir>/segN.ts` (HLS chính).

- [ ] **Step 1: Failing tests**

`cloud/test/video.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseRange, handleVideo } from "../src/video";
import { env } from "cloudflare:test";

describe("parseRange", () => {
  it("đầu-giữa", () => expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 }));
  it("open-end", () => expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 }));
  it("suffix bytes=-200", () => expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 }));
  it("end vượt size -> kẹp", () => expect(parseRange("bytes=900-2000", 1000)).toEqual({ start: 900, end: 999 }));
  it("invalid", () => { expect(parseRange("bytes=abc", 1000)).toBe("invalid"); expect(parseRange("bytes=900-100", 1000)).toBe("invalid"); expect(parseRange("bytes=2000-", 1000)).toBe("invalid"); });
  it("null khi không header", () => expect(parseRange(null, 1000)).toBeNull());
});

describe("handleVideo", async () => {
  await env.VIDEOS.put("a.mp4", new Uint8Array(1024).fill(7), { httpMetadata: { contentType: "video/mp4" } });
  it("full 200", async () => {
    const r = await handleVideo(new Request("https://x/v/a.mp4"), env, "a.mp4");
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect((await r.arrayBuffer()).byteLength).toBe(1024);
  });
  it("206 + content-range", async () => {
    const r = await handleVideo(new Request("https://x/v/a.mp4", { headers: { range: "bytes=100-199" } }), env, "a.mp4");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 100-199/1024");
    expect((await r.arrayBuffer()).byteLength).toBe(100);
  });
  it("404", async () => { expect((await handleVideo(new Request("https://x/v/z.mp4"), env, "z.mp4")).status).toBe(404); });
  it("416", async () => {
    const r = await handleVideo(new Request("https://x/v/a.mp4", { headers: { range: "bytes=9999-" } }), env, "a.mp4");
    expect(r.status).toBe(416);
  });
});
```
Chạy `npm test` → FAIL.

- [ ] **Step 2: Implement `src/video.ts`**

```ts
import type { Env } from "./auth";

export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") { // suffix: bytes=-N = N byte cuối
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end && start < size ? { start, end } : "invalid";
}

export async function handleVideo(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method === "HEAD") {
    const obj = await env.VIDEOS.head(name);
    if (!obj) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: videoHeaders(obj.size, obj.httpMetadata?.contentType) });
  }
  const full = await env.VIDEOS.getWithMetadata(name);
  if (!full.object) return new Response(null, { status: 404 });
  const size = full.object.size;
  const pr = parseRange(request.headers.get("range"), size);
  if (pr === "invalid") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  if (!pr) {
    return new Response(full.object.body, { status: 200, headers: videoHeaders(size, full.object.httpMetadata?.contentType) });
  }
  const slice = await env.VIDEOS.get(name, { range: { offset: pr.start, length: pr.end - pr.start + 1 } });
  if (!slice) return new Response(null, { status: 404 });
  const h = videoHeaders(pr.end - pr.start + 1, full.object.httpMetadata?.contentType);
  h["content-range"] = `bytes ${pr.start}-${pr.end}/${size}`;
  return new Response(slice.body, { status: 206, headers: h });
}

function videoHeaders(len: number, contentType: string | undefined): Record<string, string> {
  return {
    "accept-ranges": "bytes",
    "content-type": contentType ?? "application/octet-stream",
    "content-length": String(len),
    "cache-control": "private, max-age=0",
  };
}
```

Router thêm trước `env.ASSETS.fetch`:
```ts
if (url.pathname.startsWith("/v/")) {
  const name = decodeURIComponent(url.pathname.slice(3));
  if (!name || name.includes("..")) return json({ error: "bad name" }, 400);
  return handleVideo(request, env, name);
}
if (url.pathname.startsWith("/hls/")) {
  const name = decodeURIComponent(url.pathname.slice(5));
  if (!name || name.includes("..") || !(name.endsWith(".m3u8") || name.endsWith(".ts"))) return json({ error: "bad name" }, 400);
  return handleHls(request, env, name);
}
```
Test thêm: `/hls/x/index.m3u8` trả content-type `application/vnd.apple.mpegurl` + cache-control `public,max-age=60`; `/hls/x/seg0.ts` → `video/mp2t` + immutable; `/hls/x/evil.txt` → 400.
Chạy `npm test` → PASS.

- [ ] **Step 3: Commit**
```bash
git add cloud/src/video.ts cloud/test/video.test.ts cloud/src/worker.ts && git commit -m "cloud: R2 video stream Range/206/416 + HLS /hls/* (m3u8/ts, cache immutable)"
```

---

### Task 3: KV data routes — cache AI + progress, body caps

**Files:**
- Create: `cloud/src/data.ts`, `cloud/test/data.test.ts`
- Modify: `cloud/src/worker.ts` (routes `/api/cache/*`, `/api/progress`, `/api/videos`)

**Interfaces:**
- Consumes: `Env.DATA` (KVNamespace), `Env.VIDEOS.list()`.
- Produces: `readBody(request, maxBytes): Promise<{ ok: true; text: string } | { ok: false }>`; routes: `GET /api/cache/<key>` → `200 <raw>` | 404; `PUT /api/cache/<key>` body ≤ 256KB → `204` | 413; `GET /api/progress` → JSON blob; `PUT /api/progress` body ≤ 256KB → 204; `GET /api/videos` → `200 [{name, size}]`. KV keys: `cache:<key>`, `progress` (1 blob map, client merge).

- [ ] **Step 1: Failing tests** (`cloud/test/data.test.ts`) — dùng `SELF.fetch` từ `cloudflare:test` với `run_worker_first` config nếu cần; test qua HTTP: PUT cache → GET lại khớp bytes; PUT 300KB → 413; GET cache thiếu → 404; GET /api/videos sau khi put 2 object → mảng 2 phần tử có name+size, không lộ key nội bộ. SKIP_AUTH=1 từ miniflare cho qua auth.

- [ ] **Step 2: Implement `src/data.ts`** — `readBody` đọc `request.body` qua `Content-Length` check trước (413 sớm) rồi `await request.text()` kiểm `byteLength`; `PUT /api/cache/<key>` → `env.DATA.put('cache:'+key, text)`; progress GET → `env.DATA.get('progress') ?? '{}'`; PUT → put nguyên blob. `/api/videos`: `const l = await env.VIDEOS.list(); return l.objects.filter(o => !o.key.endsWith('/')).map(o => ({ name: o.key, size: o.size }))` (paginate `cursor` loop tới hết — 1 user, vòng lặp while an toàn).

- [ ] **Step 3: PASS + commit** — `git commit -m "cloud: KV cache/progress + videos list + body caps"`

---

### Task 4: AI proxy — provider map, SSE passthrough, rate limit binding

**Files:**
- Create: `cloud/src/ai.ts`, `cloud/test/ai.test.ts`
- Modify: `cloud/src/worker.ts` (route `POST /api/ai`), `cloud/wrangler.jsonc` (thêm var `CUSTOM_BASE` optional)

**Interfaces:**
- Consumes: `Env.AI_RL`, secrets `NIM_KEY, DEEPSEEK_KEY, OPENROUTER_KEY, OPENAI_KEY, ZEN_KEY, GO_KEY, GEMINI_KEY, CUSTOM_KEY`.
- Produces: `handleAi(request, env): Promise<Response>`; request body `{ provider: string; model?: string; body: unknown }`; response = upstream nguyên trạng (status + headers content-type + body stream). 413 nếu body > 64KB; 429 nếu `AI_RL.limit` fail (kèm `Retry-After: 30`); 400 provider lạ; 502 nếu secret thiếu (message rõ: "chưa cấu hình key X — chạy wrangler secret put X").

- [ ] **Step 1: Failing tests** (`cloud/test/ai.test.ts`) — stub `globalThis.fetch` chụp `(url, init)` rồi trả SSE giả (`data: {...}\n\n`); assert: provider `deepseek` → url `https://api.deepseek.com/v1/chat/completions`, header `Authorization: Bearer sk-test`, body pass-through nguyên vẹn; provider `gemini` model `gemini-2.0-flash-001` → url chứa `models/gemini-2.0-flash-001:streamGenerateContent?alt=sse&key=`; status upstream 401 được pass về 401; body 70KB → 413; provider lạ → 400; rate limit (binding fake fail) → 429 + Retry-After. Binding fake qua miniflare binding override trong test setup.

- [ ] **Step 2: Implement `src/ai.ts`**
```ts
const PROVIDERS: Record<string, { url: (model: string, env: Env) => string; key: keyof AiSecrets; style: "openai" | "gemini" }> = {
  nim:        { url: m => `https://integrate.api.nvidia.com/v1/chat/completions`, key: "NIM_KEY", style: "openai" },
  deepseek:   { url: m => `https://api.deepseek.com/v1/chat/completions`, key: "DEEPSEEK_KEY", style: "openai" },
  openrouter: { url: m => `https://openrouter.ai/api/v1/chat/completions`, key: "OPENROUTER_KEY", style: "openai" },
  openai:     { url: m => `https://api.openai.com/v1/chat/completions`, key: "OPENAI_KEY", style: "openai" },
  zen:        { url: m => `https://opencode.ai/zen/v1/chat/completions`, key: "ZEN_KEY", style: "openai" },
  go:         { url: m => `https://opencode.ai/zen/go/v1/chat/completions`, key: "GO_KEY", style: "openai" },
  gemini:     { url: m => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`, key: "GEMINI_KEY", style: "gemini" },
  custom:     { url: m => `${new URL(m).origin}/chat/completions`, key: "CUSTOM_KEY", style: "openai" }, // CUSTOM_BASE var chứa full origin, vd https://host/v1
};
```
Body flow: đọc text (cap 64KB) → JSON.parse → tra PROVIDERS → nếu thiếu secret → 502 JSON → build upstream `Request(url, { method: "POST", headers: { content-type: "application/json", ...(style==='openai' ? { authorization: `Bearer ${key}` } : {}) , ...(id==='openrouter' ? { 'http-referer': origin, 'x-title': 'omni-player' } : {}) }, body: JSON.stringify(body) })` — gemini nhận key qua `?key=` append. Trả `fetch(upstream)` nguyên status + `content-type` + body stream (không buffer). Model override: nếu `req.model` khác model trong body (openai: `body.model = model`; gemini: dùng trong url).

- [ ] **Step 3: PASS + commit** — `git commit -m "cloud: AI proxy SSE + rate limit + body cap"`

---

### Task 5: App — cloud detect, nút ☁, danh sách video, phát từ cloud

**Files:**
- Modify: `index.html` (4 vùng: boot detect, toolbar button ~line 467, panel list + CSS, `setVideo` ~2025 + `sessionKey` 2140)

**Interfaces:**
- Consumes: `GET /api/me`, `GET /api/videos`, `GET /v/<name>`, `GET /hls/<dir>/index.m3u8` (Tasks 1–3).
- Produces: `state.cloud: { email: string } | null`; `state.videoFile` nhận thêm file-like cloud object `{ name, size, lastModified: 0, cloud: true, hls: true }` (plain object KHÔNG dùng `new File()` — `File.size`/`lastModified` là getter readonly, Object.assign không ghi đè được; code app chỉ đọc `.name/.size/.lastModified`); `cloudOpenVideo(name, size, hlsDir)`; nút `#btnCloud`; hls.js self-host tại `cloud/public/hls.js` (download 1 lần từ CDN lúc build, commit thẳng file — không CDN runtime vì Zero Trust domain không nên phụ thuộc third-party).

- [ ] **Step 1: Cloud detect lúc boot** — trong init chính (tìm chỗ gọi `loadSettings()`/init — chạy một lần DOMContentLoaded): 
```js
async function cloudInit(){
  try{
    const c=new AbortController(); const t=setTimeout(()=>c.abort(),3000);
    const r=await fetch('/api/me',{signal:c.signal}); clearTimeout(t);
    if(!r.ok) return;
    const j=await r.json(); if(!j.email) return;
    state.cloud={email:j.email}; btnCloud.hidden=false;
  }catch{}
}
```
`file://` → fetch relative URL ném TypeError ngay → catch → local mode. Không log lỗi ra console trong local mode.

- [ ] **Step 2: Nút ☁ + panel** — toolbar thêm `<button class="tb" id="btnCloud" hidden title="Video trên cloud">☁</button>` cạnh `#btnOpenVideo` (line ~467). Panel dạng popover (dùng pattern panel hiện có, ví vụ welcome list): click ☁ → `fetch('/api/videos')` → render danh sách `<div class="cv-row"> tên + (size MB)` → click row → `cloudOpenVideo(name,size)` → đóng panel. Empty → "Cloud trống — xem README phần upload." Loading state + lỗi → toast.

- [ ] **Step 3: `cloudOpenVideo` + setVideo hỗ trợ cloud/HLS**
```js
function cloudOpenVideo(name, size, hlsDir){
  setVideo({name, size, lastModified: 0, cloud: true, hls: !!hlsDir, hlsDir}, null);
}
```
`setVideo` sửa phần gán src (sau `saveSession()`, giữ các reset state hiện có):
```js
if(file.cloud){
  state.videoUrl=null;
  if(file.hls && window.Hls && Hls.isSupported()){
    if(state.hls){ state.hls.destroy(); state.hls=null; }
    state.hls=new Hls({maxBufferLength:30}); state.hls.loadSource('/hls/'+file.hlsDir+'/index.m3u8'); state.hls.attachMedia(video);
  } else if(file.hls && video.canPlayType('application/vnd.apple.mpegurl')){
    video.src='/hls/'+encodeURIComponent(file.hlsDir)+'/index.m3u8'; // Safari native
  } else {
    video.src='/v/'+encodeURIComponent(file.name); // fallback range-request
  }
} else { state.videoUrl=URL.createObjectURL(file); video.src=state.videoUrl; }
```
- `state.hls` thêm vào state object; `setVideo` đầu hàm destroy instance cũ; cleanup khi đóng app không cần (instance sống cùng page).
- `fileChip`/toast hiện tên file như cũ (`file.name` nguyên vẹn).
- **`/api/videos` hợp tác:** response mỗi item `{name, size, hlsDir|null}` — Task 3 định nghĩa: item có `<dir>/index.m3u8` cùng prefix → `hlsDir=<dir>`.
`sessionKey` (line 2140) không đổi — cloud file lastModified=0 cho key ổn định. `historyUpsert` (2133) đọc `.name/.size/.lastModified` — hoạt động. Patch thêm `cloud:!!file.cloud` vào historyUpsert call trong setVideo.
**Chú ý lỗi preload metadata:** HLS qua hls.js không set `video.src` trực tiếp — mọi chỗ app giả định `video.src` non-empty phải check `state.hls || video.src` (audit chỗ errOverlay/bigPlay logic line ~1812-1843).

**Kiểm tra không phá local:** `python3 -m http.server 8080` + mở app → phát file local, resume, phụ đề — như cũ (btnCloud vẫn hidden vì /api/me 404).

- [ ] **Step 4: Smoke qua wrangler dev** — `cd cloud && npm run dev` (cần `public/index.html` đã copy + R2 local có object test: `npx wrangler r2 object put omni-videos/test.mp4 --file fixtures/test.mp4 --local` — tạo fixture mp4 1KB bằng ffmpeg nếu chưa có). `browser.open http://localhost:8787` → ☁ hiện → danh sách có test.mp4 → click phát → video render, tua được (Range). Chụp screenshot làm bằng chứng.

- [ ] **Step 5: Commit** — `git commit -m "app: cloud mode — detect, ☁ panel, phát video từ R2"`

---

### Task 6: App — AI Cloud Proxy (builder refactor + chain)

**Files:**
- Modify: `index.html` (PROVS ~1213, `aiCallGeminiP` 1477, `aiCallOpenAIP` 1538, chain runner 1612, settings UI AI)

**Interfaces:**
- Consumes: `POST /api/ai` (Task 4).
- Produces: `buildOpenAIReq(p, cue, idx): { body }` (không chứa key); `buildGeminiReq(p, cue, idx, stream): { path, body }` (path không có `&key=`); `aiCallCloudP(p, cue, idx, signal, onDelta)`; provider id `cloud` vào `PROVS` với `type:'cloud'`.

- [ ] **Step 1: Refactor builders** — tách từ `aiCallOpenAIP` (1538) phần dựng `{messages, model, temperature, stream:true}` thành `buildOpenAIReq(p, cue, idx)` trả `{ body }`; `aiCallOpenAIP` gọi builder rồi tự `fetch(p.base+'/chat/completions', { headers: { authorization:'Bearer '+p.key, ...}, body: JSON.stringify(body) })` — hành vi local không đổi. Tương tự `buildGeminiReq(p, cue, idx, stream)` trả `{ path: '/v1beta/models/'+encodeURIComponent(p.model)+(stream?':streamGenerateContent?alt=sse':':generateContent'), body }`; `aiCallGeminiP` fetch với `'...'+path+'&key='+encodeURIComponent(p.key)`. Chạy smoke AI local (settings đã có key thật? nếu không có trong máy dev — dùng custom provider trỏ mock server) — không regression.

- [ ] **Step 2: `aiCallCloudP`** — provider entry `cloud` có thêm field `via` (id provider thật trong PROVS) và `model` override optional, cấu hình trong ⚙ AI: 1 hàng "☁ Cloud Proxy" với select via (nim/deepseek/openrouter/openai/zen/go/gemini/custom) + ô model:
```js
async function aiCallCloudP(p, cue, idx, signal, onDelta){
  const t=PROVS.find(x=>x.id===p.via);
  const built=t.type==='gemini'?buildGeminiReq(t,cue,idx,true):buildOpenAIReq(t,cue,idx);
  const r=await fetch('/api/ai',{method:'POST',signal,headers:{'content-type':'application/json'},
    body:JSON.stringify({provider:p.via,model:p.model||t.model,body:built.body})});
  if(!r.ok||!r.body) throw new Error('cloud '+r.status);
  // parse SSE: tái dùng đúng reader/parser của aiCallOpenAIP (tách hàm chung parseSSEStream(r, onDelta, style) nếu trùng lặp)
}
```
Chain runner (line ~1612): thêm nhánh `p.type==='cloud' ? await aiCallCloudP(p, cue, idx, signal, onDelta) : ...`. Khi `state.cloud`: prepend `{id:'cloud', name:'☁ Cloud', type:'cloud', via: saved || 'openrouter', model: saved}` vào `state.ai.chain` lúc load settings (chỉ khi user chưa tự bỏ nó ra — lưu chain có id 'cloud' như provider thường trong `op:ai`).

- [ ] **Step 3: Smoke streaming** — `wrangler dev` + mock upstream: set `.dev.vars` `CUSTOM_BASE=http://localhost:9999/v1`, chạy mock SSE server (node 10 dòng trong `cloud/test/mock-upstream.mjs`, trả `data: {"choices":[{"delta":{"content":"xin"}}]}\n\n` × 5). App: chọn via=custom → AI 1 câu → chữ hiện dần từng chunk (screenshot 2 thời điểm). Fallback: tắt mock → chain rơi sang provider kế, ghi chú "bỏ qua" như hiện có.

- [ ] **Step 4: Commit** — `git commit -m "app: AI Cloud Proxy đầu fallback chain (key ở Worker)"`

---

### Task 7: App — sync KV: cache AI + vị trí xem, merge "Tiếp tục xem"

**Files:**
- Modify: `index.html` (aiCache write/read ~1257–1269, 1350; `saveSession` 2141; `historyGet`/render "Tiếp tục xem" 2126+, ~2168+)

**Interfaces:**
- Consumes: `GET/PUT /api/cache/<key>`, `GET/PUT /api/progress` (Task 3).
- Produces: `cloudPut(path, body, {throttleMs, key})` helper debounce; cache AI 2-layers; progress throttle 30s + flush on pause/pagehide.

- [ ] **Step 1: Cache AI** — write path (`aiSaveCache` ~1266): giữ localStorage; nếu `state.cloud && !cloudDegraded` → schedule debounce 5s `PUT /api/cache/'+resumeKey` với body = cùng JSON object. Read path (1259): local miss → `await fetch('/api/cache/'+resumeKey)` → nếu 200: parse → merge vào map + ghi ngược localStorage (fire-and-forget, có flag in-flight chống double fetch). Nút 🔄 (bypass cache) hành vi giữ nguyên.

- [ ] **Step 2: Progress** — `saveSession` (2141): sau localStorage set, nếu cloud: `cloudPut('/api/progress', JSON.stringify(entryMap), {throttleMs: 30000, key: 'progress'})` — entry `{name, size, t, d, at, cloud}` keyed `name:size`; flush ngay khi `visibilitychange`/`pagehide`/pause (gửi luôn bỏ throttle). Server lưu 1 blob `progress` (client merge local+remote trước khi PUT — đọc local `op:history:v1` + entry hiện tại).

- [ ] **Step 3: Merge "Tiếp tục xem"** — render list (đọc `historyGet()`): nếu cloud, fetch `/api/progress` 1 lần lúc mở welcome → merge: map theo key `name:size`, lấy bản `at` mới nhất, sort lại. Entry cloud (`cloud:true`) click → `cloudOpenVideo(name,size)` thay vì picker. Label thêm ☁ nhỏ cạnh tên file cloud.

- [ ] **Step 4: Degraded + offline** — mọi fetch bọc try/catch; lỗi mạng/429 → `cloudDegraded=true` (dừng mọi PUT tới reload). Local mode không đi qua đường này.

- [ ] **Step 5: Smoke** — wrangler dev + 2 context browser (A phát đến 30s, đợi >30s throttle hoặc pause) → context B mở welcome → thấy entry + vị trí đúng. Cache AI: hỏi câu X trên A, trên B câu X trả từ KV (network tab: GET /api/cache hit, không gọi /api/ai). Screenshot + log network.

- [ ] **Step 6: Commit** — `git commit -m "app: sync KV cache AI + vị trí xem, merge tiếp tục xem"`

---

### Task 8: Deploy scripts, upload, README setup guide, regression

**Files:**
- Create: `cloud/upload.py`, `cloud/deploy.sh`, `cloud/README.md`, `cloud/fixtures/.gitkeep`
- Modify: `README.md` (mục Deploy thêm link cloud/README.md)

- [ ] **Step 1: `cloud/deploy.sh`**
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cp ../index.html public/index.html
npx wrangler deploy
```

- [ ] **Step 2: `cloud/upload.py`** — uploader Python thuần (stdlib `boto3`-free: dùng `boto3` nếu có, fallback S3 REST + SigV4 tự ký bằng stdlib), hỗ trợ **multipart upload cho mọi kích thước** (R2: part ≥ 5MB, part number 1–10000, complete sau khi upload hết parts):

Giao diện dòng lệnh:
```
python3 cloud/upload.py video1.mp4 video2.mkv            # upload nhiều file
python3 cloud/upload.py "Phim/"                          # đệ quy cả thư mục (chỉ mp4/webm/mkv)
python3 cloud/upload.py Phim --prefix "phimle/"          # upload vào thư mục con trên R2
python3 cloud/upload.py file.mp4 --part-size 64          # chỉnh part size (MB)
```

Yêu cầu chức năng:
- **Env credentials** (không lưu file nào trong repo): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — README hướng dẫn tạo S4 token trong dashboard (R2 → Manage API Tokens). Thiếu → exit 1 với thông báo rõ.
- **Multipart khi file > part-size** (mặc định 64MB): CreateMultipartUpload → PUT từng part (tuần tự, retry 3 lần mỗi part với backoff) → CompleteMultipartUpload; abort (AbortMultipartUpload) khi Ctrl-C/lỗi để không rác part tính tiền.
- **Skip file đã có**: HEAD object trước; nếu tồn tại + cùng size → bỏ qua (in `skip`). `--force` để ghi đè.
- **Content-type** map như cũ (mp4/m4v → video/mp4, webm → video/webm, mkv → video/x-matroska, else application/octet-stream) — set ở CreateMultipartUpload/PUT header.
- **Progress**: in mỗi part `part 3/12 ✓ (192MB/768MB)`.
- Chỉ stdlib (`urllib.request`, `hashlib`, `hmac`, `datetime`, `xml.etree`) — tự ký SigV4 (canonical request → string-to-sign → HMAC chain). KHÔNG bắt buộc boto3; nếu boto3 có sẵn và `--boto3` flag thì dùng boto3 (ngắn hơn, giữ làm opt-in vì cài thêm dependency).

Kiểm chứng: tạo file giả 130MB (`dd if=/dev/zero of=/tmp/t.mp4 bs=1M count=130`), chạy upload.py với credentials test (miniflare R2 không hỗ trợ S4 API — dùng R2 thật khi user setup, hoặc localstack nếu có; tối thiểu: SigV4 signing test với vector có sẵn + dry-run mode `--dry-run` in các request sẽ gửi). Acceptance: `--dry-run` in đúng sequence (HEAD → CREATE → PART×3 → COMPLETE) cho file 130MB part-size 64; SigV4 signature khớp vector test AWS (string-to-sign well-known).

- [ ] **Step 3: `cloud/README.md`** — từng bước dashboard (user tự làm, có wizard-style checklist):
  1. `wrangler login` (browser) → tạo bucket `wrangler r2 bucket create omni-videos`, KV `wrangler kv namespace create DATA` → dán id vào wrangler.jsonc.
  2. Custom domain: Cloudflare dashboard → Workers & Pages → omni-player → Settings → Domains & Routes → Add Custom Domain (vd `player.<domain>`).
  3. Zero Trust → Access → Applications → Add → Self-hosted, domain `player.<domain>`; policy Allow / Include / Emails: email bạn; Login methods: One-time PIN + Google. Copy **Application Audience (AUD) tag** → `wrangler secret`... không — AUD là var: `wrangler vars put ACCESS_AUD`? (var nhạy cảm nhẹ — dùng secret `put ACCESS_AUD` cũng được nhưng đọc qua env như var; chốt: `npx wrangler secret put ACCESS_AUD` + `ACCESS_TEAM`).
  4. Secrets: `npx wrangler secret put NIM_KEY` … từng provider dùng thật.
  5. Rate limiting: dashboard → Security → Rate limiting rules → hostname `player.<domain>` 60 req/10s/IP block 60s.
  6. WAF custom rule: `(http.request.uri.path contains ".php") or (http.request.uri.path eq "/wp-admin") or (http.request.uri.path contains ".env")` → Managed Challenge. Bot Fight Mode ON. SSL/TLS Full + Always Use HTTPS ON.
  7. `./deploy.sh` → mở `https://player.<domain>` → login OTP → dùng.
  8. Upload: tạo R2 API token (R2 → Manage API Tokens → Object Read & Write) → `export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...` rồi `python3 cloud/upload.py phim.mp4` (multipart tự động cho file lớn; `--dry-run` để xem trước).
  9. Rollback: `npx wrangler rollback`.

- [ ] **Step 4: Regression local** — mở `index.html` trực tiếp (file://) + qua `python3 -m http.server`: phát, phụ đề, resume, AI chain local (mock), phím tắt — checklist 10 mục spec §7. `npm test` toàn bộ cloud tests PASS.

- [ ] **Step 5: Commit** — `git commit -m "cloud: upload/deploy scripts + setup README"`

---

## Verification tổng (sau Task 8)

1. `cd cloud && npm test` — toàn bộ unit PASS.
2. `wrangler dev` + browser: chuỗi full — detect cloud → ☁ list → phát + tua → AI proxy stream (mock) → cache KV hit → resume across reload. Screenshots từng bước.
3. Local `file://` regression — mọi tính năng cũ nguyên vẹn.
4. Dashboard steps (Access/WAF/domain/secrets) — in checklist cho user; phần đó là bước người thật, agent không tự làm.
