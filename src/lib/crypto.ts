/**
 * Optional end-to-end encryption for synced payloads.
 * AES-GCM with a key derived from the user's passphrase via PBKDF2.
 * The passphrase never leaves the device; the server only ever sees ciphertext.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Copy a view into a fresh, non-shared ArrayBuffer so it satisfies BufferSource under strict TS libs. */
function buf(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(enc.encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations: 150_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export interface Encrypted {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

export async function encryptJson(value: unknown, passphrase: string): Promise<Encrypted> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(enc.encode(JSON.stringify(value))));
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) };
}

export async function decryptJson<T>(payload: Encrypted, passphrase: string): Promise<T> {
  const key = await deriveKey(passphrase, unb64(payload.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(unb64(payload.iv)) }, key, buf(unb64(payload.data)));
  return JSON.parse(dec.decode(pt)) as T;
}

export function isEncrypted(x: unknown): x is Encrypted {
  return !!x && typeof x === 'object' && (x as any).v === 1 && 'data' in (x as any);
}
