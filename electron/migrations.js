'use strict';

/**
 * 数据结构版本 + 迁移脚本
 *
 * 什么时候要把版本 +1：
 *   - 字段改名 / 拆分 / 合并（老数据里的字段名对不上新 schema）
 *   - 集合（collection）改名或合并
 *   - 加密范围（SECRET_KEYS）变化，需要把老明文重新加密
 *   - records 表本身的结构变化
 *   - 新增一张跟记录有关的表（比如用例↔接口关联表）
 *
 * 什么时候不用动：
 *   - 只加新字段 → 老记录取出来是空值，界面能正常显示，编辑一次就补上了
 *   - 只加新集合 → 新集合没有历史数据
 *   - 改标签文案 / 改默认值 / 调 UI
 *
 * 迁移执行时机：store.init 打开已有数据库时，版本号落后就先做一份
 * data-before-v{旧版本}-{时间}.db 备份，再按 to 从小到大依次执行。
 */

const { OPTION_SETS } = require('../shared/collections');

const SCHEMA_VERSION = 4;

/**
 * 用例 ↔ 接口关联表（唯一事实源，DDL 只写这一份）
 *
 * file_path + case_title 是软键：解析时按这两个字段回找当前用例，
 * 用例被改名/删除时关联不会炸，只会显示「已失效」。
 * case_index 是冗余字段，只在同文件同名用例时用于消歧，不参与唯一键。
 */
const LINK_DDL = `
CREATE TABLE IF NOT EXISTS case_api_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path   TEXT NOT NULL,
  case_title  TEXT NOT NULL,
  case_index  INTEGER,
  api_id      TEXT NOT NULL,
  source      TEXT,
  created_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_link ON case_api_links(file_path, case_title, api_id);
`;

/**
 * run(api) 里可用的工具：
 *   api.records(collection)   读某个集合的记录（data 已解密，可改）
 *   api.allRecords()          读全部记录
 *   api.write(rec)            写回一条（按当前 SECRET_KEYS 重新加密，title 自动重算）
 *   api.renameCollection(a,b) 集合改名
 *   api.sql(stmt, params)     直接执行 SQL（不传 params 时支持多条语句）
 *   api.query(stmt, params)   查 SQL
 *   api.getMeta / api.setMeta
 */
const MIGRATIONS = [
  {
    to: 2,
    note: '测试账号新增「环境」字段，按所属站点回填',
    run(api) {
      const envBySite = new Map();
      for (const site of api.records('sites')) {
        const env = (site.data || {}).env || '';
        if (env) envBySite.set(site.id, env);
      }
      for (const acc of api.records('accounts')) {
        const data = acc.data || {};
        if (data.env) continue; // 已经填过的不动
        // 有归属站点就跟着站点，没有就归到「其他」，至少能筛出来
        data.env = envBySite.get(data.site) || 'other';
        api.write(acc);
      }
    }
  },
  {
    to: 3,
    note: '新增用例 ↔ 接口关联表 case_api_links（只建表，不动记录）',
    run(api) {
      api.sql(LINK_DDL);
    }
  },
  {
    to: 4,
    note: '环境/角色改为多选：老数据里的字符串转数组，并把历史值收进选项配置',
    run(api) {
      // 选项配置：老值都得在选项里，否则下拉框看不见它们（用户还得手敲一遍）
      const envItems = [];
      const envSeen = new Set();
      const roleItems = [];
      const roleSeen = new Set();
      const pushUnique = (list, seen, v) => {
        const s = String(v || '').trim();
        if (!s || seen.has(s)) return;
        seen.add(s);
        list.push(s);
      };

      const asArray = (v) => {
        if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null && String(x).trim() !== '');
        if (v === undefined || v === null || String(v).trim() === '') return [];
        return [v];
      };

      for (const coll of ['sites', 'accounts']) {
        for (const rec of api.records(coll)) {
          const data = rec.data || {};
          const beforeEnv = data.env;
          const beforeRole = data.role;
          let touched = false;

          if (!Array.isArray(beforeEnv)) {
            data.env = asArray(beforeEnv);
            touched = true;
          }
          if (coll === 'accounts' && !Array.isArray(beforeRole)) {
            data.role = asArray(beforeRole);
            touched = true;
          }
          for (const e of asArray(beforeEnv)) pushUnique(envItems, envSeen, e);
          for (const r of asArray(beforeRole)) pushUnique(roleItems, roleSeen, r);

          if (touched) api.write(rec);
        }
      }

      // 标签也顺手收一遍（历史记录里已经用过的标签，下拉框直接可选）
      const tagItems = [];
      const tagSeen = new Set();
      for (const rec of api.allRecords()) {
        const tags = Array.isArray(rec.tags) ? rec.tags : String(rec.tags || '').split(',');
        for (const t of tags) pushUnique(tagItems, tagSeen, t);
      }

      // 环境选项：保留默认项，把自定义值按 {value,label,color} 补进去
      const envDefaults = (OPTION_SETS.env.defaults || []).map((o) => ({ ...o }));
      const envOpt = envDefaults.slice();
      const envOptSeen = new Set(envOpt.map((o) => o.value));
      for (const v of envItems) {
        if (envOptSeen.has(v)) continue;
        envOptSeen.add(v);
        envOpt.push({ value: v, label: v, color: 'default' });
      }

      api.setMeta('opt.env', envOpt);
      api.setMeta('opt.role', roleItems);
      api.setMeta('opt.tags', tagItems.slice(0, 300));
    }
  }
];

module.exports = { SCHEMA_VERSION, MIGRATIONS, LINK_DDL };