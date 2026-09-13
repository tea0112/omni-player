import type { Env } from "./auth";

// Content-type + cache-control HLS theo đuôi file; router chỉ cho phép 2 đuôi này qua /hls/*.
const HLS_META: Record<string, { contentType: string; cacheControl: string }> = {
  ".m3u8": { contentType: "application/vnd.apple.mpegurl", cacheControl: "public,max-age=60" },
  ".ts": { contentType: "video/mp2t", cacheControl: "public,max-age=31536000,immutable" },
};

// bytes=<start>-[<end>], suffix bytes=-N; "invalid" = cú pháp sai/không khả thi (416),
// null = không có header (trả full 200).
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (m[1] === "") {
    // suffix: bytes=-N = N byte cuối; n=0 hoặc size=0 → range không khả thi
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end && start < size ? { start, end } : "invalid";
}

// /v/<file>: range-request file raw từ R2 (fallback cho file không HLS).
export async function handleVideo(request: Request, env: Env, name: string): Promise<Response> {
  return serveR2(request, env, name, false);
}

// /hls/<dir>/index.m3u8 + /hls/<dir>/segN.ts: chung core R2-get, khác cache-control/content-type.
export async function handleHls(request: Request, env: Env, name: string): Promise<Response> {
  return serveR2(request, env, name, true);
}

function hlsMeta(name: string): { contentType: string; cacheControl: string } {
  for (const [ext, meta] of Object.entries(HLS_META)) {
    if (name.endsWith(ext)) return meta;
  }
  // router đã chặn đuôi khác; fallback cho gọi trực tiếp
  return { contentType: "application/octet-stream", cacheControl: "public,max-age=60" };
}

async function serveR2(request: Request, env: Env, name: string, hls: boolean): Promise<Response> {
  const hm = hls ? hlsMeta(name) : null;
  const cacheControl = hm ? hm.cacheControl : "private, max-age=0";
  // head() trước để biết size (làm chuẩn cho cả 416 lẫn content-range); miniflare workerd
  // 1.20250906.0 chưa mô phỏng R2Bucket.getWithMetadata → chỉ dùng head/get/getWithMetadata-free API.
  const obj = await env.VIDEOS.head(name);
  if (!obj) return new Response(null, { status: 404 });
  const size = obj.size;
  const pr = parseRange(request.headers.get("range"), size);
  if (pr === "invalid") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  if (pr) {
    const slice = await env.VIDEOS.get(name, { range: { offset: pr.start, length: pr.end - pr.start + 1 } });
    if (!slice) return new Response(null, { status: 404 });
    const ct = hm ? hm.contentType : slice.httpMetadata?.contentType;
    const h = videoHeaders(pr.end - pr.start + 1, ct, cacheControl);
    h["content-range"] = `bytes ${pr.start}-${pr.end}/${size}`;
    return new Response(slice.body, { status: 206, headers: h });
  }
  const full = await env.VIDEOS.get(name);
  if (!full) return new Response(null, { status: 404 });
  const ct = hm ? hm.contentType : full.httpMetadata?.contentType;
  return new Response(full.body, { status: 200, headers: videoHeaders(size, ct, cacheControl) });
}
