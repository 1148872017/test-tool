; ============================================================
; 自定义 NSIS 脚本（electron-builder 会在 installer.nsi 里 include）
;
; 当前用 oneClick（一键安装）模式：
;   assisted（有向导）在用户机器上反复失败——写卸载器时
;   报「不能打开要写入的文件」，且误报「无法关闭」。
;   环境已排除：目录权限正常、D 盘 NTFS 可写、无杀软、无残留进程。
;
; oneClick 模式下没有卸载页插入点（oneClick.nsh 只有
; MUI_UNPAGE_INSTFILES），所以「卸载时勾选删数据」做不到。
;
; 替代方案：卸载时弹一个提示，告诉用户数据在哪、怎么手动清。
; 应用内已有「设置 → 数据与备份 → 清除数据」功能。
;
; 数据位置（和 electron/main.js 的 resolveDataDir 一致）：
;   %APPDATA%\测试工作台\        ← 数据库、备份、运行时
;   文档\测试工作台\             ← 用例、jmx、压测报告、知识库、笔记
; ============================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"

; ---- 卸载时提示用户手动清数据 ----
; customUnInstall 在 uninstaller.nsh L157 被插入（早于删文件）
!macro customUnInstall
  ; 只在非静默卸载时弹提示（静默卸载 /S 不打扰）
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONINFORMATION \
      "程序文件已删除。$\r$\n$\r$\n你的数据仍然保留在：$\r$\n· $APPDATA\${PRODUCT_FILENAME}$\r$\n· $DOCUMENTS\${PRODUCT_FILENAME}$\r$\n$\r$\n如果不再使用，请手动删除上面两个目录。$\r$\n（密码库、测试账号、用例索引、压测记录、笔记都在里面）" \
      /SD IDOK
  ${EndIf}
!macroend
