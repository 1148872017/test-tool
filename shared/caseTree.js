/**
 * 用例目录树：一级目录 = 用例文件所在目录（需求名），二级 = 那个目录下的 .md 文件。
 *
 * 为什么要有这层：一个需求目录下常常躺着好几个用例文件（TC_模块C券_xxx.md、
 * TC_模块B卡券_核销_xxx.md…），平铺成「目录 → 全部 300 条」根本看不出哪份文件管什么。
 * 点文件就只看那份文件的用例，点目录还是看整个目录。
 *
 * 纯函数，不碰 dom，node 里直接测。
 */

/** 根目录下的文件统一显示成这个（跟旧的标签栏保持一致） */
const ROOT_LABEL = '（根目录）';

/**
 * @param {Array} files caseScan 返回的 files：[{ relPath, name, dir, cases }]
 * @returns {{ name: string, count: number, files: { relPath: string, name: string, count: number }[] }[]}
 *          按用例条数从多到少；目录内文件按文件名排序
 */
function buildCaseTree(files) {
  const map = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (!f) continue;
    const dirName = f.dir || ROOT_LABEL;
    const count = Array.isArray(f.cases) ? f.cases.length : 0;
    const hit = map.get(dirName) || { count: 0, files: [] };
    hit.count += count;
    hit.files.push({ relPath: f.relPath || '', name: f.name || f.relPath || '', count });
    map.set(dirName, hit);
  }
  const list = [];
  for (const [name, v] of map.entries()) {
    list.push({
      name,
      count: v.count,
      files: v.files.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    });
  }
  // 条数多的目录排前面；条数一样就按名字，避免每次渲染顺序乱跳
  list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return list;
}

/**
 * 一条用例（在心里是 file + item）是否落在当前选中范围内。
 * fileFilter 优先：选了具体文件就只看它，目录筛选形同虚设（不然会出现「目录 A + 文件 B」自相矛盾）。
 */
function inScope(file, dirFilter, fileFilter) {
  if (fileFilter) return file && file.relPath === fileFilter;
  if (!dirFilter) return true;
  return !!file && (file.dir || ROOT_LABEL) === dirFilter;
}

module.exports = { buildCaseTree, inScope, ROOT_LABEL };