// HMAC-SHA256 signed URLs for short-lived xlsx downloads.
// All crypto runs through Web Crypto (crypto.subtle), which is native to
// Cloudflare Workers — no Node.js polyfill needed.

export interface SignEnv {
  SIGNING_SECRET: string;
}

const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    ALGORITHM,
    false,
    ["sign", "verify"],
  );
}

export async function signDownloadUrl(
  origin: string,
  key: string,
  ttlSeconds: number,
  env: SignEnv,
): Promise<{ url: string; expiresAt: string }> {
  if (!env.SIGNING_SECRET) {
    throw new Error("SIGNING_SECRET is not configured (run `wrangler secret put SIGNING_SECRET`)");
  }
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds);
  const data = `${key}.${exp}`;
  const cryptoKey = await importKey(env.SIGNING_SECRET);
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const sig = base64url(mac);
  const url = `${origin}/download/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
  return { url, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyAndStream(req: Request, env: SignEnv & { XLSX_BUCKET: R2Bucket }): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  // /download/<key>
  const prefix = "/download/";
  if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
  const key = decodeURIComponent(path.slice(prefix.length));
  if (!key) return new Response("missing key", { status: 400 });

  const expStr = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!expStr || !sig) return new Response("missing signature", { status: 403 });

  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return new Response("invalid exp", { status: 403 });
  if (Math.floor(Date.now() / 1000) > exp) {
    return new Response("link expired", { status: 403 });
  }

  if (!env.SIGNING_SECRET) {
    return new Response("server signing key not configured", { status: 500 });
  }

  const cryptoKey = await importKey(env.SIGNING_SECRET);
  const data = `${key}.${exp}`;
  const ok = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    fromBase64url(sig),
    new TextEncoder().encode(data),
  );
  if (!ok) return new Response("invalid signature", { status: 403 });

  const obj = await env.XLSX_BUCKET.get(key);
  if (!obj) return new Response("file not found or expired", { status: 404 });

  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="simplex-${key}.xlsx"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
