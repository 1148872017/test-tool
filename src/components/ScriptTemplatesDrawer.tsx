import React, { useMemo, useState } from 'react';
import { Drawer, Input, Tag, Button, Alert, Empty, Space } from 'antd';
import {
  CopyOutlined,
  SearchOutlined,
  BulbOutlined,
  WarningOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  ImportOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import {
  NO_CODE_NEEDED,
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  CATEGORY_MAP,
  fillTemplateDefaults
} from '../../shared/scriptTemplates';
import { extractVars } from '../utils';
import VarFillModal from './VarFillModal';

/** 「填入附加代码」的目标位置：和 shared/jmxgen.js 的 extraElements.type 对齐 */
export type TemplateInsertKind = 'assertion' | 'pre' | 'post';

/** 模板分类 → 生成进 jmx 时用哪个 JSR223 元件 */
const INSERT_KIND: Record<string, TemplateInsertKind> = {
  assert: 'assertion',
  extract: 'post',
  generate: 'pre',
  crypto: 'pre',
  flow: 'pre'
};

/** 底部说明的默认文案（代码调试页会换成「插入到光标处」的说法） */
const DEFAULT_FOOTER_HINT =
  '复制后粘到 JMeter GUI 的对应元件里（断言 / 前置处理器 / 后置处理器）。' +
  'JMeter 模板还可以点「填入附加代码」，直接写进「脚本生成」出来的新 jmx。';

/** onPickTemplate 交出去的模板对象（只给用得上的字段，避免调用方依赖内部结构） */
export type TemplatePickPayload = {
  id: string;
  category: string;
  name: string;
  code: string;
  vars?: any[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  /**
   * 可选：提供后，JMeter 相关模板上会多一个「填入附加代码」按钮，
   * 点一下就把代码（占位符已填默认值）塞进脚本生成页的附加代码区，
   * 生成 jmx 时会写成 JSR223 断言 / 前置 / 后置处理器。
   * api-assert / ui-assert 是 RestAssured/pytest/Playwright 代码，不能进 jmx，不显示该按钮。
   */
  onPick?: (item: { type: TemplateInsertKind; code: string; name: string }) => void;
  /**
   * 可选：和 onPick 二选一（都传时优先这个）。
   *
   * 区别只在「交出去的东西」：onPick 给的是填好默认值的代码 + 元件类型，
   * 给脚本生成页用；这里给整个模板对象，代码调试页要靠 category 补上
   * 「这段断言在 JMeter 里挂哪」的说明——调试页跑通不等于断言生效。
   */
  onPickTemplate?: (tpl: TemplatePickPayload) => void;
  /** 插入按钮文案（脚本生成页是「填入附加代码」，代码调试页是「插入到光标处」） */
  pickLabel?: string;
  /** 底部说明第一句；两个场景的说法不一样，所以可覆盖 */
  footerHint?: string;
};

/**
 * 脚本模板库。
 * 定位是「带注释的起点」，不是生成器——用户能看懂示例、在示例上改。
 */
export default function ScriptTemplatesDrawer({
  open,
  onClose,
  onPick,
  onPickTemplate,
  pickLabel = '填入附加代码',
  footerHint = DEFAULT_FOOTER_HINT
}: Props) {
  const [keyword, setKeyword] = useState('');
  const [activeId, setActiveId] = useState(TEMPLATES[0].id);
  const [showNoCode, setShowNoCode] = useState(true);
  // 速填弹窗（有 {{变量}} 占位符时用）
  const [fillOpen, setFillOpen] = useState(false);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return TEMPLATES;
    return TEMPLATES.filter((t) =>
      [t.name, t.when, t.code, t.gotcha].join(' ').toLowerCase().includes(kw)
    );
  }, [keyword]);

  /** 按分类分组，组内保持原顺序；分类按 order 排 */
  const grouped = useMemo(() => {
    const byCat = new Map<string, any[]>();
    for (const t of filtered) {
      const cat = t.category || 'other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(t);
    }
    return TEMPLATE_CATEGORIES.filter((c) => byCat.has(c.key)).map((c) => ({
      ...c,
      items: byCat.get(c.key)!
    }));
  }, [filtered]);

  const active = TEMPLATES.find((t) => t.id === activeId) || filtered[0] || TEMPLATES[0];

  const copy = async (text: string) => {
    await api.copy(text);
    toast('已复制，粘到 JMeter 的脚本框里');
  };

  /** 当前模板能不能「直接带进生成的 jmx」 */
  const insertKind = active && active.category ? INSERT_KIND[active.category] : undefined;
  const canInsert = !!insertKind && (!!onPick || !!onPickTemplate);

  /** 把当前模板塞进脚本生成页的附加代码区（占位符换成默认值，粘进去就能跑） */
  const insert = () => {
    if (!active || !insertKind) return;
    if (onPickTemplate) {
      // 代码调试页：交整个模板对象，它自己决定要不要补「JMeter 里怎么挂载」
      onPickTemplate({ id: active.id, category: active.category, name: active.name, code: active.code, vars: active.vars });
      return;
    }
    if (!onPick) return;
    onPick({
      type: insertKind,
      code: fillTemplateDefaults(active.code, active.vars),
      name: active.name
    });
    // 回执交给调用方（脚本生成页会提示「已填入附加代码」），这里不重复弹 toast，
    // 否则同一次点击会冒出两条一模一样的提示。
  };

  /** 快捷入口：打开 jmx 目录（生成的脚本都在这里） */
  const openJmxDir = async () => {
    try {
      const s = await api.settings();
      const dir = (s && s.jmxDir) || '';
      if (!dir) {
        toast('还没配 jmx 目录 —— 去「设置 → 压测」选一个', 'warning');
        return;
      }
      const res = await api.jmxReveal(dir);
      if (res && res.ok === false) toast(res.message || '打开目录失败', 'warning');
    } catch (e: any) {
      toast('打开目录失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /** 快捷入口：直接启动 JMeter GUI，粘完代码就能存 */
  const launchJmeter = async () => {
    try {
      const res = await api.jmxLaunch();
      if (res && res.ok) toast('JMeter 已启动，把代码粘到对应元件里');
      else toast((res && res.message) || '启动失败：去「设置 → 压测」指定 bin\\jmeter.bat', 'warning');
    } catch (e: any) {
      toast('启动失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={980}
      title={
        <div className="tpl-title">
          <span>脚本模板</span>
          <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            Groovy · 带注释的起点，改两处就能用
          </span>
        </div>
      }
      footer={
        /*
         * 底部说明 + 快捷入口。
         * 用户真实卡点是「知道怎么写断言，但不知道粘到 JMeter 哪里」，
         * 所以这里直接把「复制后粘到 JMeter GUI 的对应元件里」写出来，
         * 再给两个能立刻过去的按钮（打开 jmx 目录 / 启动 JMeter）。
         */
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {footerHint}
          </div>
          <Space size={8} style={{ flex: 'none' }}>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={openJmxDir}>
              打开 jmx 目录
            </Button>
            <Button size="small" icon={<PlayCircleOutlined />} onClick={launchJmeter}>
              启动 JMeter
            </Button>
          </Space>
        </div>
      }
    >
      <div className="tpl-layout">
        <aside className="tpl-list">
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
            placeholder="搜模板"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div
            className={'tpl-item' + (showNoCode ? ' active' : '')}
            onClick={() => setShowNoCode(true)}
          >
            <BulbOutlined style={{ color: '#f5a623' }} />
            <span>先看：这些不用写代码</span>
          </div>
          <div className="tpl-divider" />
          {grouped.map((group) => (
            <div key={group.key} className="tpl-group">
              <div className="tpl-group-head">
                <Tag color={group.color} className="tpl-cat-tag">
                  {group.name}
                </Tag>
                <span className="tpl-group-count">{group.items.length}</span>
              </div>
              {group.items.map((t) => (
                <div
                  key={t.id}
                  className={'tpl-item' + (!showNoCode && activeId === t.id ? ' active' : '')}
                  onClick={() => {
                    setActiveId(t.id);
                    setShowNoCode(false);
                  }}
                >
                  <span className="tpl-item-name">{t.name}</span>
                </div>
              ))}
            </div>
          ))}
          {!filtered.length ? <div className="tpl-empty">没有匹配的模板</div> : null}
        </aside>

        <main className="tpl-main">
          {showNoCode ? (
            <div>
              <Alert
                type="info"
                showIcon
                icon={<BulbOutlined />}
                message="先确认这件事要不要写代码"
                description="JMeter 的内置组件能覆盖大部分需求。写脚本只在「内置组件做不到」时才必要——脚本会拖慢压测机，而且更难维护。"
                style={{ marginBottom: 14 }}
              />
              <table className="tpl-table">
                <thead>
                  <tr>
                    <th style={{ width: '30%' }}>你想做的事</th>
                    <th style={{ width: '24%' }}>用内置组件</th>
                    <th>怎么加</th>
                  </tr>
                </thead>
                <tbody>
                  {NO_CODE_NEEDED.map((row, i) => (
                    <tr key={i}>
                      <td>{row.need}</td>
                      <td>
                        <Tag color="green">{row.use}</Tag>
                      </td>
                      <td>
                        <div>{row.how}</div>
                        {row.note ? <div className="tpl-note">{row.note}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : active ? (
            <div>
              <div className="tpl-head">
                <h3>
                  {active.category && CATEGORY_MAP[active.category] ? (
                    <Tag color={CATEGORY_MAP[active.category].color} style={{ marginRight: 8 }}>
                      {CATEGORY_MAP[active.category].name}
                    </Tag>
                  ) : null}
                  {active.name}
                </h3>
                <Space size={8}>
                  {canInsert ? (
                    <Button size="small" icon={<ImportOutlined />} onClick={insert}>
                      {pickLabel}
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    type="primary"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      // 有占位符 → 打开速填弹窗；没有 → 直接复制
                      if (extractVars(active.code).length) setFillOpen(true);
                      else copy(active.code);
                    }}
                  >
                    {extractVars(active.code).length ? '填写并复制' : '复制代码'}
                  </Button>
                </Space>
              </div>

              <div className="tpl-when">
                <span className="muted">什么时候用</span>
                <div>{active.when}</div>
              </div>

              <div className="tpl-where">
                <span className="muted">JMeter 里怎么加</span>
                <div className="mono">{active.where}</div>
              </div>

              <div className="tpl-code-head">
                <span>Groovy 代码</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  注释里标了「↓ 改成你的…」的地方就是要改的
                </span>
              </div>
              <pre className="tpl-code mono">{active.code}</pre>

              {active.gotcha ? (
                <Alert
                  type="warning"
                  showIcon
                  icon={<WarningOutlined />}
                  style={{ marginTop: 12 }}
                  message="注意"
                  description={active.gotcha}
                />
              ) : null}
            </div>
          ) : (
            <Empty description="选一个模板" />
          )}
        </main>
      </div>

      {/* 速填弹窗：和 SQL 片段同款（变量表格 + 拼接预览标色） */}
      {active ? (
        <VarFillModal
          open={fillOpen}
          text={active.code}
          title={`填写变量并复制 · ${active.name}`}
          varsRaw={active.vars ? JSON.stringify(active.vars) : ''}
          onClose={() => setFillOpen(false)}
        />
      ) : null}
    </Drawer>
  );
}
