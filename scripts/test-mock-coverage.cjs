/* mock 覆盖率：preload 暴露的每个 API，mockApi 里都要有对应实现 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
const mockSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'mockApi.ts'), 'utf8');

/**
 * 提取 preload 里暴露的 API 名。
 *
 * 形如：
 *   xxx: () => invoke('...'),
 *   xxx: (a, b) => invoke('...', { a, b }),
 */
const apis = [...preloadSrc.matchAll(/^\s{2}([a-zA-Z]\w*):\s*\([^)]*\)\s*=>/gm)].map((m) => m[1]);

check('提取到 preload API', apis.length > 50, apis.length);

/**
 * 检查 mock 里有没有同名的键。
 *
 * 为什么这条重要（踩坑 #96）：
 *   浏览器预览走 mockApi。新加 IPC 忘了加 mock →
 *   预览时 `api.xxx is not a function` → 页面白屏，
 *   但真机（Electron）是好的，很容易漏掉。
 */
const missing = apis.filter((a) => !new RegExp('\\b' + a + '\\s*:').test(mockSrc));

check('mock 覆盖所有 preload API', missing.length === 0, missing);

/* 反向验证：故意漏一个能被抓出来 */
{
  const fakePre = "  fakeApiMissingInMock: () => invoke('x'),\n  appInfo: () => invoke('y'),";
  const fakeApis = [...fakePre.matchAll(/^\s{2}([a-zA-Z]\w*):\s*\([^)]*\)\s*=>/gm)].map((m) => m[1]);
  const fakeMissing = fakeApis.filter((a) => !new RegExp('\\b' + a + '\\s*:').test(mockSrc));
  check('能抓住缺失的 mock', fakeMissing.includes('fakeApiMissingInMock'), fakeMissing);
}

/* 关键 API 逐个点名（防止正则漏掉） */
const mustHave = [
  'init', 'lock', 'unlock', 'settings', 'saveSettings', 'info', 'records', 'saveRecord',
  'codescanCoverage', 'codescanHardcoded', 'codescanDeps',
  'codegenTargets', 'codegenPreview', 'codegenSave',
  'openapiPickFile', 'openapiParseFile',
  'jmxgenPreview', 'jmxgenSave',
  'sqlgenSnapshot', 'sqlgenCleanup', 'sqlgenRestore',
  'allureScan', 'allureParse', 'allureFlaky',
  'runnerList', 'skinGetImage', 'skinPickImage'
];
const lost = mustHave.filter((a) => !new RegExp('\\b' + a + '\\s*:').test(mockSrc));
check('关键 mock API 齐全', lost.length === 0, lost);

const failed = results.filter((r) => !r.ok);
console.log('===== mock 覆盖率检查 =====');
console.log('preload API 数:', apis.length);
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);