/* 品牌图标：换成用户提供的图片 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const root = path.join(__dirname, '..');
const sidebarSrc = fs.readFileSync(path.join(root, 'src', 'components', 'Sidebar.tsx'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const brandTs = fs.readFileSync(path.join(root, 'src', 'assets', 'brand.ts'), 'utf8');

/* ---------- 1. 组件 ---------- */
check('导入了 BRAND_ICON', /import \{ BRAND_ICON \}/.test(sidebarSrc), 'no import');
check('brand-mark 里有 img', /brand-mark-img/.test(sidebarSrc), 'no img');
check('不再用闪电图标', !/ThunderboltFilled/.test(sidebarSrc), 'still used');
check('img 有 alt（无障碍）', /<img[^>]*alt=/.test(sidebarSrc), 'no alt');

/* ---------- 2. 资源 ---------- */
check('brand.ts 是 data URI', /data:image\/png;base64,/.test(brandTs), 'not data uri');
check('brand.ts 导出常量', /export const BRAND_ICON/.test(brandTs), 'no export');
check('base64 长度合理', brandTs.length > 10000 && brandTs.length < 200000, brandTs.length);

/* 能解码出合法 PNG（读前几个字节） */
{
  const m = /base64,([A-Za-z0-9+/=]+)/.exec(brandTs);
  if (m) {
    const buf = Buffer.from(m[1], 'base64');
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    check('base64 解出来是 PNG', isPng, buf.slice(0, 4).toString('hex'));
    check('图片有点大', buf.length > 5000, buf.length);

    /* PNG 头里的宽高（IHDR 第 16~23 字节） */
    if (isPng && buf.length > 24) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      check('图标是正方形', w === h, { w, h });
      check('图标尺寸 128', w === 128, w);
    }
  } else {
    check('能提取 base64', false);
  }
}

/* ---------- 3. 样式 ---------- */
check('CSS 有 brand-mark-img', /\.brand-mark-img/.test(cssSrc), 'no css');
check('图片 cover 裁切', /object-fit:\s*cover/.test(cssSrc), 'no cover');
check('不再有紫色渐变', !/\.brand-mark \{[^}]*linear-gradient/.test(cssSrc), 'still gradient');
check('圆角保留', /\.brand-mark \{[^}]*border-radius/.test(cssSrc), 'no radius');
check('尺寸仍是 30px', /\.brand-mark \{[^}]*width:\s*30px/.test(cssSrc), 'size changed');

/* ---------- 4. 源文件留着（方便重新生成）---------- */
check('build/brand.png 存在', fs.existsSync(path.join(root, 'build', 'brand.png')), 'no source png');

const failed = results.filter((r) => !r.ok);
console.log('===== 品牌图标测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);