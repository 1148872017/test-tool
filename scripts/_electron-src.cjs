'use strict';
/**
 * 后端源码合并读取（给「静态扫源码」的测试用）。
 *
 * IPC handler 已按域拆到 electron/ipc/*.js，main.js 只剩启动流程，
 * 所以「后端有没有这个通道 / 这段逻辑」这类检查不能再只读 main.js，
 * 必须扫整个 electron/ 目录（递归、含子目录）。
 *
 * 注意：这是**静态**读取，用于断言某段逻辑存在；
 * 真实的注册/行为验证见 test-startup.cjs（真 require main.js）和 test-main.cjs。
 */
const fs = require('fs');
const path = require('path');

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');

/** 递归列出目录下所有 .js（按路径排序，保证拼接结果稳定） */
function listJsFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJsFiles(full));
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/** 整个 electron/ 目录的源码（各文件用换行拼接） */
function readElectronSource() {
  return listJsFiles(ELECTRON_DIR)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

module.exports = { ELECTRON_DIR, listJsFiles, readElectronSource };