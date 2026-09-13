export interface Env {
  VIDEOS: R2Bucket;
  DATA: KVNamespace;
  AI_RL: { limit(n: { key: string }): Promise<{ success: boolean }> };
  ASSETS: { fetch(req: Request): Promise<Response> };
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  SKIP_AUTH?: string;
}

let jwksCache: { keys: JsonWebKey[]; at: number } | null = null;

function b64u(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (s.length % 4)) % 4;
  const bin = atob(s + "=".repeat(pad));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifyAccess(request: Request, env: Env): Promise<{ email: string } | null> {
  if (env.SKIP_AUTH === "1") return { email: "dev@local" };
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_AUD) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const head = parseJson(new TextDecoder().decode(b64u(h)));
  if (!head || head.alg !== "ES256") return null;
  const claims = parseJson(new TextDecoder().decode(b64u(p)));
  if (!claims || typeof claims.aud !== "string" || claims.aud !== env.ACCESS_AUD) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  if (!jwksCache || Date.now() - jwksCache.at > 300_000) {
    const r = await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    const body = parseJson(await r.text());
    if (!body || !Array.isArray(body.keys)) return null;
    jwksCache = { keys: body.keys, at: Date.now() };
  }
  const jwk = jwksCache.keys.find((k) => "kid" in k && k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
  return ok ? { email: typeof claims.email === "string" ? claims.email : "" } : null;
}

// JSON.parse trả any; với input không tin cậy (JWT từ header, body JWKS) chỉ dùng khi là object.
function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
