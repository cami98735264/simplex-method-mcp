// Tiny wrapper around the R2 bucket binding for xlsx persistence.

export interface XlsxStoreEnv {
  XLSX_BUCKET: R2Bucket;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function newXlsxKey(): string {
  // 16 random bytes → 32-char hex. Plenty of entropy and URL-safe.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function putXlsx(env: XlsxStoreEnv, key: string, bytes: Uint8Array): Promise<void> {
  await env.XLSX_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: XLSX_MIME },
  });
}
