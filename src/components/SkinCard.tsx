import React from 'react';
import { Tooltip } from 'antd';
import { BgColorsOutlined, CheckOutlined } from '@ant-design/icons';
import { THEMES, getTheme } from '../../shared/themes';

type Props = {
  saveSettings: (patch: any) => void;
  settings: any;
};

/**
 * 外观设置卡片。
 *
 * 只剩一项：主题色 5 选 1。
 *
 * 背景图 / 面板透明度 / 背景蒙版 / 文字深浅三档都已下线：
 * 那四件东西合起来只是为了「让一张背景图能用」——半透明面板、毛玻璃、
 * 白色文字阴影、按透明度自动加深文字，全站 CSS 要为这套东西让路，
 * 结果是对比度预算全花在补救上，正文反而看不清。
 * 现在背景固定为纯色底，文字对比度回到 4.5:1 以上，皮肤只负责主色。
 */
export default function SkinCard({ saveSettings, settings }: Props) {
  /**
   * 用 getTheme 反查「当前生效的主题键」，而不是直接比 settings.themeColor。
   * 老配置里可能存着已下线的 cyan / orange，此时实际生效的是 blue / red，
   * 直接比原值会出现「配色是蓝的，但一个勾都没亮」。
   */
  const activeKey = getTheme(settings.themeColor).key;

  return (
    <div className="tool-card" style={{ marginBottom: 14 }}>
      <div className="tool-card-title">
        <BgColorsOutlined /> 外观
      </div>

      <div className="skin-row">
        <div className="skin-row-label">主题色</div>
        <div className="skin-themes">
          {THEMES.map((t) => (
            <Tooltip key={t.key} title={t.name}>
              <button
                className={`skin-swatch ${activeKey === t.key ? 'active' : ''}`}
                style={{ background: t.primary }}
                onClick={() => saveSettings({ themeColor: t.key })}
              >
                {activeKey === t.key ? <CheckOutlined /> : null}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      <div className="skin-hint muted">
        主题色只改主色（按钮、选中态、链接），不改文字和背景色，换色不会影响可读性。
      </div>
    </div>
  );
}