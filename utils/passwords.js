const bcrypt = require('bcryptjs');

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function hashPassword(password) {
  return bcrypt.hash(String(password || ''), 10);
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  if (isBcryptHash(stored)) return bcrypt.compare(String(password || ''), stored);
  return String(password || '') === String(stored);
}

module.exports = {
  isBcryptHash,
  hashPassword,
  verifyPassword,
};
