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

/**
 * 解密，并且**区分「解出来是空」和「根本解不开」**。
 *
 * P0-1（v0.50.1）：原来的 decrypt 在 DPAPI 解不开时静默返回 ''，
 * 上层（store.hydrate → save）把它当成「用户把密码清空了」再加密写回，
 * 于是跨机器导库 / 换 Windows 账户后，随便编辑一次记录就把密文永久抹掉。
 * 所以失败必须能被看见，不能只是一段空串。
 *
 * @returns {{ok: boolean, value: string, reason?: string}}
 *   ok:false 表示这段密文在本机解不开（**值不能当成空密码**）
 */
function decryptResult(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: '' };
  const s = String(value);
  try {
    if (s.startsWith(PREFIX_RAW)) return { ok: true, value: Buffer.from(s.slice(PREFIX_RAW.length), 'base64').toString('utf8') };
    if (s.startsWith(PREFIX_ENC)) return { ok: true, value: safeStorage.decryptString(Buffer.from(s.slice(PREFIX_ENC.length), 'base64')) };
    // 没有前缀 = 老数据里的明文，原样当成功（v7 迁移会负责重新加密）
    return { ok: true, value: s };
  } catch (e) {
    return { ok: false, value: '', reason: String((e && e.message) || e || 'decrypt-failed') };
  }
}

/**
 * 兼容旧用法：只要值。
 *
 * **不要用它判断「密码是不是空的」** —— 解不开时它和真正的空值一样返回 ''。
 * 需要区分的地方一律用 decryptResult。
 */
function decrypt(value) {
  return decryptResult(value).value;
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

module.exports = { available, encrypt, decrypt, decryptResult, hashPin, verifyPin };