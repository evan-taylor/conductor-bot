const encoder = new TextEncoder();

export async function verifySlackRequest(
  secret: string,
  body: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !signature ||
    !/^v0=[0-9a-f]{64}$/.test(signature)
  )
    return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = new Uint8Array(
    signature
      .slice(3)
      .match(/../g)!
      .map((x) => parseInt(x, 16)),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    encoder.encode(`v0:${timestamp}:${body}`),
  );
}

export async function equalSecret(
  actual: string,
  expected: string,
): Promise<boolean> {
  const a = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(actual)),
  );
  const b = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function stableUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
