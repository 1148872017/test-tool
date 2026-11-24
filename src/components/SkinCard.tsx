import React, { useEffect, useState } from 'react';
import { Button, Slider, Tag, Tooltip, Alert } from 'antd';
import { BgColorsOutlined, PictureOutlined, DeleteOutlined, CheckOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { THEMES } from '../../shared/themes';

type Props = {
  saveSettings: (patch: any) => void;
  settings: any;
};

/**
 * 皮肤设置卡片。
 *
 * 三项：
 *   1. 主题色（7 种预设）
 *   2. 背景图（选本地图片，复制到 skin 目录）
 *   3. 面板透明度（0-100，控制卡片/面板的不透明度）
 */
export default function SkinCard({ saveSettings, settings }: Props) {
  const [bgUrl, setBgUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const themeColor = settings.themeColor || 'purple';
  const bgOpacity = settings.bgOpacity === undefined ? 85 : settings.bgOpacity;

  /* ---------- 加载背景图 ---------- */
  const loadBg = async () => {
    try {
      const res = await api.skinGetImage();
      setBgUrl(res.url || '');
    } catch (e) {
      /* ignore */
    }
  };

  useEffect(() => {
    loadBg();
  }, [settings.bgImage]);

  /* ---------- 选背景图 ---------- */
  const doPick = async () => {
    setBusy(true);
    try {
      const res = await api.skinPickImage();
      if (res.canceled) return;
      if (!res.ok) {
        toast(res.message || '选择失败', 'error');
        return;
      }
      toast('背景图已设置');
      await loadBg();
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 清除背景图 ---------- */
  const doClear = async () => {
    setBusy(true);
    try {
      const res = await api.skinClearImage();
      if (!res.ok) {
        toast(res.message || '清除失败', 'error');
        return;
      }
      setBgUrl('');
      toast('背景图已清除');
    } catch (e: any) {
      toast('清除失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tool-card" style={{ marginBottom: 14 }}>
      <div className="tool-card-title">
        <BgColorsOutlined /> 皮肤设置
      </div>

      {/* 主题色 */}
      <div className="skin-row">
        <div className="skin-row-label">主题色</div>
        <div className="skin-themes">
          {THEMES.map((t) => (
            <Tooltip key={t.key} title={t.name}>
              <button
                className={`skin-swatch ${themeColor === t.key ? 'active' : ''}`}
                style={{ background: t.primary }}
                onClick={() => saveSettings({ themeColor: t.key })}
              >
                {themeColor === t.key ? <CheckOutlined /> : null}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* 背景图 */}
      <div className="skin-row">
        <div className="skin-row-label">背景图</div>
        <div className="skin-bg">
          {bgUrl ? (
            <div className="skin-bg-preview" style={{ backgroundImage: `url(${bgUrl})` }} />
          ) : (
            <div className="skin-bg-empty">
              <PictureOutlined /> 未设置
            </div>
          )}
          <div className="skin-bg-actions">
            <Button size="small" icon={<PictureOutlined />} onClick={doPick} loading={busy}>
              {bgUrl ? '更换' : '选择图片'}
            </Button>
            {bgUrl ? (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={doClear} loading={busy}>
                清除
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* 透明度 */}
      <div className="skin-row">
        <div className="skin-row-label">面板透明度</div>
        <div className="skin-opacity">
          <Slider
            min={0}
            max={100}
            value={bgOpacity}
            onChange={(v) => saveSettings({ bgOpacity: v })}
            style={{ flex: 1, maxWidth: 320 }}
            tooltip={{ formatter: (v) => `${v}%` }}
          />
          <span className="muted" style={{ fontSize: 12, minWidth: 40 }}>
            {bgOpacity}%
          </span>
        </div>
      </div>

      <div className="skin-hint muted">
        透明度越低，面板越透（背景图越明显）。设为 100% 时面板完全不透明。
      </div>

      {!bgUrl ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 8 }}
          message="没有背景图时，透明度不影响显示"
        />
      ) : null}
    </div>
  );
}
