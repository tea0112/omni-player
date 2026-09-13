// JsonWebKey của lib không khai báo kid; JWK trên wire có
type JwkJ = JsonWebKey & { kid: string };

export async function makeAccessJwt(o: { aud: string | string[]; email: string; exp?: number; iss?: string; alg?: "RS256" | "ES256" }) {
  const useRsa = (o.alg ?? "RS256") === "RS256";
  const kid = `kid-${crypto.randomUUID()}`; // kid duy nhất mỗi lần mint: tránh key cũ trong jwksCache (dùng chung giữa các test) trùng kid
  const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let jwk: JwkJ;
  let priv: CryptoKey;
  if (useRsa) {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    jwk = { kty: "RSA", kid, alg: "RS256", use: "sig", ...(await crypto.subtle.exportKey("jwk", kp.publicKey)) };
    priv = kp.privateKey;
  } else {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    jwk = { kty: "EC", crv: "P-256", kid, alg: "ES256", use: "sig", ...(await crypto.subtle.exportKey("jwk", kp.publicKey)) };
    priv = kp.privateKey;
  }
  const payload = { aud: o.aud, email: o.email, exp: o.exp ?? Math.floor(Date.now() / 1000) + 600, iss: o.iss ?? "https://team.cloudflareaccess.com" };
  const head = b64u(new TextEncoder().encode(JSON.stringify({ alg: useRsa ? "RS256" : "ES256", typ: "JWT", kid })).buffer as ArrayBuffer);
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const sig = await crypto.subtle.sign(useRsa ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(`${head}.${body}`));
  return { token: `${head}.${body}.${b64u(sig)}`, jwks: { keys: [jwk] } };
}
