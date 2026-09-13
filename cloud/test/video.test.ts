import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { parseRange, handleVideo, handleHls } from "../src/video";

// isolatedStorage mặc định bật trong vitest-pool-workers: write trong 1 test bị rollback
// cuối test → seed mỗi test (beforeAll sẽ bị undo trước khi test chạy).
async function seed() {
  await env.VIDEOS.put("a.mp4", new Uint8Array(1024).fill(7), { httpMetadata: { contentType: "video/mp4" } });
  await env.VIDEOS.put("raw.bin", new Uint8Array(16)); // không có contentType → fallback octet-stream
  await env.VIDEOS.put("x/index.m3u8", "#EXTM3U\n#EXTINF:4.0,\nx/seg0.ts\n");
  await env.VIDEOS.put("x/seg0.ts", new Uint8Array(188).fill(0x47));
}

beforeEach(seed);

describe("parseRange", () => {
  it("đầu-giữa", () => expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 }));
  it("open-end", () => expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 }));
  it("suffix bytes=-200", () => expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 }));
  it("end vượt size -> kẹp", () => expect(parseRange("bytes=900-2000", 1000)).toEqual({ start: 900, end: 999 }));
  it("invalid", () => {
    expect(parseRange("bytes=abc", 1000)).toBe("invalid");
    expect(parseRange("bytes=900-100", 1000)).toBe("invalid");
    expect(parseRange("bytes=2000-", 1000)).toBe("invalid");
  });
  it("null khi không header", () => expect(parseRange(null, 1000)).toBeNull());
});

describe("handleVideo", () => {
  it("full 200", async () => {
    const r = await handleVideo(new Request("https://x/v/a.mp4"), env, "a.mp4");
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("cache-control")).toBe("private, max-age=0");
    expect((await r.arrayBuffer()).byteLength).toBe(1024);
  });
  it("206 + content-range", async () => {
    const r = await handleVideo(new Request("https://x/v/a.mp4", { headers: { range: "bytes=100-199" } }), env, "a.mp4");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 100-199/1024");
    expect((await r.arrayBuffer()).byteLength).toBe(100);
  });
  it("404", async () => {
    expect((await handleVideo(new Request("https://x/v/z.mp4"), env, "z.mp4")).status).toBe(404);
  });
  it("416", async () => {
    const r = await handleVideo(new Request("https://x/v/a.mp4", { headers: { range: "bytes=9999-" } }), env, "a.mp4");
    expect(r.status).toBe(416);
  });
  it("HEAD 200 + content-length, không body", async () => {
    const r = await handleVideo(new Request("https://x/v/a.mp4", { method: "HEAD" }), env, "a.mp4");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("1024");
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });
  it("content-type fallback application/octet-stream", async () => {
    const r = await handleVideo(new Request("https://x/v/raw.bin"), env, "raw.bin");
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
  });
});

describe("hls + router", () => {
  it("handleHls 404 khi thiếu object", async () => {
    const r = await handleHls(new Request("https://x/hls/x/nope.m3u8"), env, "x/nope.m3u8");
    expect(r.status).toBe(404);
  });
  it("/hls/x/index.m3u8 → application/vnd.apple.mpegurl + public,max-age=60", async () => {
    const r = await SELF.fetch("https://example.com/hls/x/index.m3u8");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(r.headers.get("cache-control")).toBe("public,max-age=60");
  });
  it("/hls/x/seg0.ts → video/mp2t + immutable", async () => {
    const r = await SELF.fetch("https://example.com/hls/x/seg0.ts");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp2t");
    expect(r.headers.get("cache-control")).toBe("public,max-age=31536000,immutable");
    expect((await r.arrayBuffer()).byteLength).toBe(188);
  });
  it("/hls/x/evil.txt → 400 (chỉ cho .m3u8/.ts)", async () => {
    expect((await SELF.fetch("https://example.com/hls/x/evil.txt")).status).toBe(400);
  });
  it("/v/a.mp4 range qua router", async () => {
    const r = await SELF.fetch("https://example.com/v/a.mp4", { headers: { range: "bytes=0-9" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-9/1024");
  });
  it("/v/%2e%2e → 400 (chặn path traversal)", async () => {
    expect((await SELF.fetch("https://example.com/v/%2e%2e/secret.mp4")).status).toBe(400);
    expect((await SELF.fetch("https://example.com/hls/%2e%2e/x/index.m3u8")).status).toBe(400);
  });
});
