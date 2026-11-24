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

const { OPTION_SETS, SECRET_KEYS } = require('../shared/collections');

/**
 * 当前数据结构版本。
 *
 * v7：修复 v5 遗留的明文密码（见下面 migrateV7）。
 */
const SCHEMA_VERSION = 7;

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
 * 回收站相关 DDL（唯一事实源，DDL 只写这一份）
 *
 * deleted_at 这一列由迁移 v6 补（ALTER TABLE 幂等），索引这里单独建。
 * 为什么不把索引塞进 store.js 的 SCHEMA：
 *   老库的 records 表还没有 deleted_at 列时，
 *   `CREATE INDEX ... ON records(deleted_at)` 会在建表那一步就炸，
 *   根本轮不到迁移补列。所以索引必须在「迁移之后」再建 —— store.ensureTrashSchema()。
 */
const TRASH_DDL = `
CREATE INDEX IF NOT EXISTS idx_records_deleted ON records(deleted_at);
`;

/**
 * run(api) 里可用的工具：
 *   api.records(collection)   读某个集合的记录（data 已解密，可改）
 *   api.allRecords()          读全部记录
 *   api.write(rec)            写回一条（按当前 SECRET_KEYS 重新加密，title 自动重算）
 *   api.serialize(coll, data) 按 SECRET_KEYS 加密（**新建记录手写 INSERT 时必须用**）
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
  },
  {
    to: 5,
    note: '账号合并进站点：accounts 集合 → sites.accounts 数组，删掉 accounts 集合',
    run(api) {
      // 幂等：如果 accounts 集合已经空了，说明迁移跑过（或本来就没数据），
      // 只做「清空旧字段」的收尾，不重复搬数据。
      const legacyAccounts = api.records('accounts');

      // 1. 按站点分组收集账号
      const bySite = new Map(); // siteId -> AccountRow[]
      const orphans = []; // 没有归属站点的账号

      for (const acc of legacyAccounts) {
        const d = acc.data || {};
        const row = {
          label: String(d.name || '').trim(),
          account: String(d.account || '').trim(),
          password: String(d.password || ''),
          role: Array.isArray(d.role) ? d.role : d.role ? [d.role] : [],
          isDefault: false,
          note: String(d.note || '').trim()
        };
        const siteId = String(d.site || '').trim();
        if (siteId) {
          if (!bySite.has(siteId)) bySite.set(siteId, []);
          bySite.get(siteId).push(row);
        } else {
          orphans.push(row);
        }
      }

      // 2. 写回每个站点
      for (const site of api.records('sites')) {
        const d = site.data || {};
        const existing = Array.isArray(d.accounts) ? d.accounts.slice() : [];

        // 站点自己原来填的 account/password 也搬进来（作为第一个账号）
        const legacyAccount = String(d.account || '').trim();
        const legacyPassword = String(d.password || '');
        if (legacyAccount || legacyPassword) {
          existing.unshift({
            label: '默认账号',
            account: legacyAccount,
            password: legacyPassword,
            role: [],
            isDefault: true,
            note: '从「网站管理」的账号/密码字段迁移'
          });
        }

        // 追加关联到本站点的账号
        const linked = bySite.get(site.id) || [];
        for (const row of linked) existing.push(row);

        // 去重：同一个 account + role 只留一条（老数据里常有重复录入）
        const seen = new Set();
        const deduped = [];
        for (const a of existing) {
          const key = `${a.account || ''}|${(a.role || []).join(',')}`;
          // 空账号不参与去重（可能是占位行）
          if (!a.account) {
            deduped.push(a);
            continue;
          }
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(a);
        }
        existing.length = 0;
        existing.push(...deduped);

        // 保证有且只有一个默认账号
        if (existing.length) {
          const hasDefault = existing.some((a) => a.isDefault);
          if (!hasDefault) existing[0].isDefault = true;
          // 多个默认只留第一个
          let seenDefault = false;
          for (const a of existing) {
            if (a.isDefault) {
              if (seenDefault) a.isDefault = false;
              else seenDefault = true;
            }
          }
        }

        d.accounts = existing;
        // 清空旧字段（不删数据，留空）
        d.account = '';
        d.password = '';
        api.write(site);
      }

      // 3. 没有归属站点的账号：建一个「未归类」站点装它们
      //    注意：api.write 只做 UPDATE（需要 id），新建记录必须用 api.sql 直接 INSERT
      if (orphans.length) {
        orphans[0].isDefault = true;
        const now = Date.now();
        const newId = 'r_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
        const data = {
          name: '未归类账号',
          url: '',
          env: ['other'],
          accounts: orphans,
          note: '从「测试账号」迁移过来，原来没有关联站点'
        };
        /**
         * 加密（v0.43.0 修补）：
         *   这里原先是 `JSON.stringify(data)` —— 直接写明文，
         *   于是「未归类账号」这个站点的 accounts[].password 在 data.db 里是明文，
         *   而其它站点都是 enc:/raw:。同一份数据两套存法，安全和搜索都失效。
         *
         *   现在统一走 api.serialize（= store.serialize，按 SECRET_KEYS 加密）。
         *   幂等性不受影响：下面的 DELETE 会把 accounts 集合清空，重跑时没有
         *   orphans，不会再插一条。
         */
        api.sql(
          'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [newId, 'sites', '未归类账号', JSON.stringify(api.serialize('sites', data)), '', 0, now, now]
        );
      }

      // 4. 删掉 accounts 集合的所有记录
      api.sql("DELETE FROM records WHERE collection = 'accounts'");
    }
  },
  {
    to: 6,
    note: '回收站：records 加 deleted_at（0 = 未删除，老数据按未删除处理）',
    run(api) {
      /**
       * 幂等：字段已经存在就跳过。
       * 用 PRAGMA 查而不是 try/catch 吞异常 —— 吞异常会把「磁盘坏了」
       * 这类真错误一起掩盖掉。
       */
      const cols = api.query('PRAGMA table_info(records)').map((c) => String(c.name));
      if (cols.indexOf('deleted_at') < 0) {
        api.sql('ALTER TABLE records ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0');
      }
      // 老数据没有这一列时补出来是 NULL 的话，统一按「未删除」处理
      api.sql('UPDATE records SET deleted_at = 0 WHERE deleted_at IS NULL');
      api.sql(TRASH_DDL);
    }
  },
  {
    to: 7,
    /**
     * 回扫明文密码（v0.43.0 修补，High）。
     *
     * 起因：v5 建「未归类账号」站点时绕过 serialize 直接 INSERT，
     * 那批 accounts[].password 在 data.db 里是**明文**（没有 enc:/raw: 前缀）。
     * 已经升到 v6 的用户不会重跑 v5，所以必须有一条独立迁移把它们补加密。
     *
     * 做法：
     *   - 看**磁盘上的原文**（rec.raw.data），不是解密后的 data ——
     *     security.decrypt 对没有前缀的值是原样返回，光看 data 分不出明文还是密文；
     *   - 有任何一个 secret 字段缺前缀就整条走 api.write()，
     *     它内部会按 SECRET_KEYS 重新加密所有密码字段；
     *   - 幂等：写过之后磁盘上都有前缀了，第二次跑一条都不会动。
     *
     * 注意：空字符串不算明文（security.encrypt('') === ''，本来就不落密文）。
     */
    note: '回扫没有 enc:/raw: 前缀的密码字段并重新加密（v5 迁移遗留的明文）',
    run(api) {
      let fixed = 0;
      for (const rec of api.allRecords()) {
        const secrets = SECRET_KEYS[rec.collection] || [];
        if (!secrets.length) continue;

        let raw = {};
        try {
          raw = JSON.parse((rec.raw && rec.raw.data) || '{}');
        } catch (e) {
          continue; // 坏数据不碰，交给上层处理
        }
        const plain = plainSecretPaths(raw, secrets);
        if (!plain.length) continue;

        // hydrate 出来的 data 里这些字段是明文，serialize 会把它们重新加密
        api.write(rec);
        fixed += 1;
      }
      if (fixed) console.log('[迁移 v7] 重新加密了 ' + fixed + ' 条记录里的明文密码');
    }
  }
];

/**
 * 找出这条记录里「磁盘上是明文」的密码字段路径。
 *
 * 支持两种路径写法（和 store.applySecretPath 一致）：
 *   'password'            顶层字段
 *   'accounts[].password' 数组元素里的字段
 *
 * @param {object} raw 磁盘上 data 列的 JSON 解析结果
 * @param {string[]} secretPaths SECRET_KEYS[collection]
 * @returns {string[]} 明文路径（空数组 = 这条没问题）
 */
function plainSecretPaths(raw, secretPaths) {
  const out = [];
  if (!raw || typeof raw !== 'object') return out;
  for (const p of secretPaths) {
    const arrMatch = /^(\w+)\[\]\.(\w+)$/.exec(p);
    if (arrMatch) {
      const arr = raw[arrMatch[1]];
      if (!Array.isArray(arr)) continue;
      arr.forEach((item, i) => {
        if (item && typeof item === 'object' && isPlainSecretValue(item[arrMatch[2]])) {
          out.push(p + '#' + i);
        }
      });
      continue;
    }
    if (isPlainSecretValue(raw[p])) out.push(p);
  }
  return out;
}

/** 值存在、非空、且没有 enc:/raw: 前缀 → 认为是明文 */
function isPlainSecretValue(v) {
  if (v === undefined || v === null) return false;
  const s = String(v);
  if (!s) return false;
  return !(s.startsWith('enc:') || s.startsWith('raw:'));
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, LINK_DDL, TRASH_DDL, plainSecretPaths, isPlainSecretValue };