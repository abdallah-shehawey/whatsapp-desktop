/*
 * PBKDF2 cryptography and constant-time passcode verification for App Lock.
 */
'use strict';

const crypto = require('crypto');

const ITERATIONS = 100000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function deriveHash(pin, salt) {
  const clean = String(pin || '').trim();
  const derived = crypto.pbkdf2Sync(clean, salt, ITERATIONS, KEYLEN, DIGEST);
  return derived.toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function verifyHash(pin, salt, targetHash) {
  if (!salt || !targetHash) return false;
  const derived = deriveHash(pin, salt);
  const attemptBuf = Buffer.from(derived, 'utf8');
  const targetBuf = Buffer.from(targetHash, 'utf8');

  if (attemptBuf.length === targetBuf.length && crypto.timingSafeEqual(attemptBuf, targetBuf)) {
    return true;
  }
  return false;
}

module.exports = {
  ITERATIONS,
  KEYLEN,
  DIGEST,
  deriveHash,
  generateSalt,
  verifyHash,
};
