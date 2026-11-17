export const themeConfig = {
  token: {
    colorPrimary: '#6c5ce7',
    colorInfo: '#6c5ce7',
    colorLink: '#6c5ce7',
    colorSuccess: '#1fa97a',
    colorWarning: '#e8a33d',
    colorError: '#e5534b',
    borderRadius: 8,
    fontFamily: "'Segoe UI', 'Microsoft YaHei', -apple-system, system-ui, sans-serif",
    colorText: '#1f2430',
    colorTextSecondary: '#6b7284',
    colorTextTertiary: '#9aa1b4',
    colorBorder: '#e3e6f0',
    colorBorderSecondary: '#eef0f7',
    colorBgLayout: '#f4f5fa',
    controlHeight: 32,
    fontSize: 13.5
  },
  components: {
    Table: {
      headerBg: '#fafbfe',
      headerColor: '#7b8296',
      headerSplitColor: 'transparent',
      rowHoverBg: '#f8f7ff',
      cellPaddingBlock: 9,
      cellPaddingInline: 12,
      borderColor: '#f0f2f8',
      fontSize: 13
    },
    Button: { defaultShadow: 'none', primaryShadow: '0 2px 6px rgba(108,92,231,0.25)' },
    Modal: { borderRadiusLG: 14 },
    Drawer: { paddingLG: 20 },
    Tag: { borderRadiusSM: 4, defaultBg: '#f1f2f9' },
    Input: { activeShadow: '0 0 0 3px rgba(108,92,231,0.1)' },
    Select: { optionSelectedBg: '#f1eeff' },
    Segmented: { itemSelectedBg: '#ffffff' },
    Popconfirm: { zIndexPopup: 1400 }
  }
};