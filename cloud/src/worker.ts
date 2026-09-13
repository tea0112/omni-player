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
