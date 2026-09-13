import { verifyAccess, type Env } from "./auth";
import { handleVideo, handleHls } from "./video";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const me = await verifyAccess(request, env);
    if (!me) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/api/me") return json({ email: me.email });
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
    return env.ASSETS.fetch(request); // các route sau bổ sung trong task kế
  },
};

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
