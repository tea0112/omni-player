export async function makeAccessJwt(o: { aud: string; email: string; exp?: number }) {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwk = { kty: "EC", crv: "P-256", x: "", y: "", kid: "testkid", alg: "ES256", use: "sig" };
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x: string; y: string };
  jwk.x = pub.x;
  jwk.y = pub.y;
  const payload = { aud: o.aud, email: o.email, exp: o.exp ?? Math.floor(Date.now() / 1000) + 600, iss: "https://team.cloudflareaccess.com" };
  const head = b64u(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "testkid" })).buffer as ArrayBuffer);
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return { token: `${head}.${body}.${b64u(sig)}`, jwks: { keys: [jwk] } };
}
