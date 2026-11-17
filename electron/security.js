'use strict';

const { safeStorage } = require('electron');
const crypto = require('crypto');

const PREFIX_ENC = 'enc:';
const PREFIX_RAW = 'raw:';

function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (e) {
    return false;
  }
}

/** 用 Windows DPAPI（Electron safeStorage）加密；不可用时退化为 base64 并打标，便于识别 */
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const s = String(plain);
  if (!available()) return PREFIX_RAW + Buffer.from(s, 'utf8').toString('base64');
  return PREFIX_ENC + safeStorage.encryptString(s).toString('base64');
}

function decrypt(value) {
  if (!value) return '';
  const s = String(value);
  try {
    if (s.startsWith(PREFIX_RAW)) return Buffer.from(s.slice(PREFIX_RAW.length), 'base64').toString('utf8');
    if (s.startsWith(PREFIX_ENC)) return safeStorage.decryptString(Buffer.from(s.slice(PREFIX_ENC.length), 'base64'));
    return s;
  } catch (e) {
    return '';
  }
}

function hashPin(pin, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), useSalt, 32).toString('hex');
  return { salt: useSalt, hash };
}

function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

module.exports = { available, encrypt, decrypt, hashPin, verifyPin };