/**
 * AES-256-GCM envelope for the app <-> Starlight Intel link, keyed by the
 * Qrypt BLAST-derived 32-byte key both ends hold. Fresh 96-bit nonce per
 * message; the tag authenticates the ciphertext and the link label. Anyone
 * without the key can neither read nor forge a message.
 *
 * Envelope: { qrypt: "AES-256-GCM", n: base64 nonce, c: base64 ciphertext, t: base64 tag }
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CIPHER = 'AES-256-GCM';
const AAD = Buffer.from('starlight-intel-link/1');

const keyBytes = (keyB64) => {
  const key = Buffer.from(String(keyB64 || ''), 'base64');
  if (key.length !== 32) throw new Error('link key must be 32 bytes');
  return key;
};

export function seal(payload, keyB64) {
  const key = keyBytes(keyB64);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return { qrypt: CIPHER, n: nonce.toString('base64'), c: ct.toString('base64'), t: cipher.getAuthTag().toString('base64') };
}

export function isEnvelope(body) {
  return Boolean(body && typeof body === 'object' && body.qrypt === CIPHER && body.n && body.c && body.t);
}

/** Returns the decrypted payload, or null when the key or tag is wrong. */
export function open(envelope, keyB64) {
  try {
    const key = keyBytes(keyB64);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.n, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.t, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(envelope.c, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    return null;
  }
}
