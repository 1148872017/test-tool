'use strict';
/**
 * clean-release.cjs —— 发版后清理旧产物，**只保留最新一版**（2026-11-26 用户定的规矩）
 *
 * 规则原文：
 *   每次推送完成后，删除旧版产物，只保留最新一版。
 *
 * 保留什么（白名单，宁多留不误删）：
 *   · 最新版本的 `test-tool-Setup-<ver>-x64.exe` 与 `.blockmap`
 *   · 最新版本的 `test-tool-docs-<ver>.zip`
 *   · `latest.yml`（应用内更新用，**永远不能删**）
 *   · `builder-debug.yml` / `builder-effective-config.yaml`（electron-builder 自己的诊断文件，很小）
 *
 * 删什么：
 *   · 其它版本的 `test-tool-Setup-*` / `test-tool-docs-*` / 其 blockmap
 *
 * 版本号来源优先级：
 *   1. `--keep <ver>` 显式指定
 *   2. package.json 的 version（最可信：打的就是这一版）
 *   3. `latest.yml` 里的 version
 *
 * 用法：
 *   node scripts/clean-release.cjs            # 真删
 *   node scripts/clean-release.cjs --dry-run  # 只报告，不删
 *
 * 安全：只动 `release/` 目录里**名字符合产物模式**的文件；
 * 目录、非产物文件、以及白名单里的四类一律不碰。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REL_DIR = path.join(ROOT, 'release');

/** 永远保留的文件名（不分版本） */
const ALWAYS_KEEP = new Set(['latest.yml', 'builder-debug.yml', 'builder-effective-config.yaml']);

/** 产物文件名模式（只有这两种会被当作「可清理」） */
const ARTIFACT_RE = /^test-tool-(Setup-[\w.\-]+-x64\.exe(?:\.blockmap)?|docs-[\d.]+\.zip)$/i;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]).replace(/^v/, '') : '';
}

function keepVersion() {
  const explicit = argValue('--keep');
  if (explicit) return explicit;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.version) return String(pkg.version);
  } catch (e) {
    /* 落到 latest.yml */
  }
  try {
    const yml = fs.readFileSync(path.join(REL_DIR, 'latest.yml'), 'utf8');
    const m = /^version:\s*(\S+)/m.exec(yml);
    if (m) return m[1];
  } catch (e) {
    /* 什么都没有 */
  }
  return '';
}

/** 这个文件名属于哪个版本（认不出返回空串） */
function versionOf(name) {
  let m = /^test-tool-Setup-([\d.]+)-x64\.exe(?:\.blockmap)?$/i.exec(name);
  if (m) return m[1];
  m = /^test-tool-docs-([\d.]+)\.zip$/i.exec(name);
  if (m) return m[1];
  return '';
}

function main() {
  const dryRun = process.argv.indexOf('--dry-run') >= 0;
  const keep = keepVersion();

  if (!fs.existsSync(REL_DIR)) {
    console.log('没有 release/ 目录，跳过。');
    return 0;
  }
  if (!keep) {
    console.error('认不出版本号（package.json / latest.yml 都没有），为避免误删，本次不清理。');
    return 1;
  }

  const files = fs.readdirSync(REL_DIR).filter((n) => {
    try {
      return fs.statSync(path.join(REL_DIR, n)).isFile();
    } catch (e) {
      return false;
    }
  });

  const keepList = [];
  const dropList = [];
  const ignored = [];

  for (const name of files) {
    if (ALWAYS_KEEP.has(name)) {
      keepList.push(name);
      continue;
    }
    if (!ARTIFACT_RE.test(name)) {
      ignored.push(name);
      continue;
    }
    const ver = versionOf(name);
    if (!ver) {
      ignored.push(name);
      continue;
    }
    if (ver === keep) keepList.push(name);
    else dropList.push({ name, ver });
  }

  console.log('保留版本：' + keep);
  console.log('');
  console.log('保留：');
  for (const n of keepList) console.log('  · ' + n);
  if (ignored.length) {
    console.log('');
    console.log('不认识、不动：');
    for (const n of ignored) console.log('  ? ' + n);
  }
  if (!dropList.length) {
    console.log('');
    console.log('没有旧产物需要清理。');
    return 0;
  }

  console.log('');
  console.log((dryRun ? '[dry-run] 将删除 ' : '删除 ') + dropList.length + ' 个旧产物：');
  let bytes = 0;
  for (const { name, ver } of dropList) {
    const full = path.join(REL_DIR, name);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch (e) {
      size = 0;
    }
    bytes += size;
    if (!dryRun) {
      try {
        fs.unlinkSync(full);
      } catch (e) {
        console.error('  删除失败 ' + name + '：' + String((e && e.message) || e));
        continue;
      }
    }
    console.log('  - v' + ver + '  ' + name + '  ' + (size / 1024 / 1024).toFixed(1) + ' MB');
  }
  console.log('');
  console.log((dryRun ? '将释放 ' : '已释放 ') + (bytes / 1024 / 1024).toFixed(1) + ' MB');
  return 0;
}

process.exit(main());
