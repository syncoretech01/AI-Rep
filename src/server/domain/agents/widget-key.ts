const WIDGET_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const WIDGET_KEY_LENGTH = 32;

/**
 * Uniformly random string over `alphabet` from the platform CSPRNG. Bytes at or
 * above the largest multiple of the alphabet size are rejected, so no character
 * is more likely than another (no modulo bias).
 */
export function randomString(alphabet: string, length: number): string {
  if (alphabet.length < 2 || alphabet.length > 256) throw new Error('alphabet must have 2-256 characters');
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('length must be a non-negative integer');
  const limit = 256 - (256 % alphabet.length);
  const bytes = new Uint8Array(Math.max(16, length * 2));
  let out = '';
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += alphabet.charAt(byte % alphabet.length);
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Public web chat widget key (`wk_` + 32 alphanumerics, ~190 bits). It only
 * identifies which agent a widget talks to; it is not a secret.
 */
export function generateWidgetKey(): string {
  return `wk_${randomString(WIDGET_KEY_ALPHABET, WIDGET_KEY_LENGTH)}`;
}
