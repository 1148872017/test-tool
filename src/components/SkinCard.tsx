import React, { useEffect, useState } from 'react';
import { Button, Slider, Tooltip, Alert, Segmented } from 'antd';
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
  /** 拖动中的临时值（松手才保存，避免每帧都 toast「已保存」） */
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);

  const themeColor = settings.themeColor || 'purple';
  const bgOpacity = settings.bgOpacity === undefined ? 85 : settings.bgOpacity;
  const bgTextMode = settings.bgTextMode || 'auto';
  /** 滑块显示的值：拖动中优先用草稿 */
  const shownOpacity = opacityDraft === null ? bgOpacity : opacityDraft;

  /**
   * 拖动中实时预览：直接改 CSS 变量，不走保存。
   * 松手（onChangeComplete）才真正写库。
   */
  const previewOpacity = (v: number) => {
    setOpacityDraft(v);
    const alpha = 0.62 + (Math.max(0, Math.min(100, v)) / 100) * 0.38;
    document.documentElement.style.setProperty('--panel-alpha', String(alpha));
    const shadow = v >= 80 ? 0 : Math.round(((80 - v) / 80) * 6) / 10;
    document.documentElement.style.setProperty(
      '--skin-text-shadow',
      shadow > 0 ? `0 1px 2px rgba(255,255,255,${shadow})` : 'none'
    );
  };

  /** 松手：保存 */
  const commitOpacity = (v: number) => {
    setOpacityDraft(null);
    saveSettings({ bgOpacity: v });
  };

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
            value={shownOpacity}
            onChange={previewOpacity}
            onChangeComplete={commitOpacity}
            style={{ flex: 1, maxWidth: 320 }}
            tooltip={{ formatter: (v) => `${v}%` }}
          />
          <span className="muted" style={{ fontSize: 12, minWidth: 40 }}>
            {shownOpacity}%
          </span>
        </div>
      </div>

      {/* 文字颜色 */}
      <div className="skin-row">
        <div className="skin-row-label">文字颜色</div>
        <Segmented
          size="small"
          value={bgTextMode}
          onChange={(v) => saveSettings({ bgTextMode: String(v) })}
          options={[
            { label: '自动', value: 'auto' },
            { label: '加深', value: 'deep' },
            { label: '默认', value: 'normal' }
          ]}
        />
        <span className="muted" style={{ fontSize: 11.5 }}>
          {bgTextMode === 'auto'
            ? '透明度低于 70% 时自动加深，保证看得清'
            : bgTextMode === 'deep'
              ? '强制加深（背景图很花时用）'
              : '保持默认颜色'}
        </span>
      </div>

      <div className="skin-hint muted">
        透明度越低面板越透。为了让文字始终清晰，平台会自动加深文字并加轻微白色阴影；面板最透时仍保留 62% 白底。
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
