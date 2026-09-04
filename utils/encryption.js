// Symmetric encryption for secrets we must store at rest (currently: each
// organisation's Google Drive OAuth refresh token). This is defense-in-depth
// on top of the RLS tenant policy on organization_drive_links — even if the
// database were ever read outside the app, the tokens inside it are useless
// without DRIVE_TOKEN_ENCRYPTION_KEY (kept only in server env vars).
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const secret = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error('DRIVE_TOKEN_ENCRYPTION_KEY is not configured');
  // SHA-256 turns any length/format secret into exactly the 32 bytes aes-256 needs.
  return crypto.createHash('sha256').update(secret).digest();
}

// Returns a single base64 string packing iv + authTag + ciphertext, so the
// database column stays a plain TEXT field.
function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const key = getKey();
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
