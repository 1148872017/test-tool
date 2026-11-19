; ============================================================
; 自定义 NSIS 脚本（electron-builder 会在 installer.nsi 里 include）
;
; 目的：卸载时提供「是否删除用户数据」选项，勾选时警告后果。
;
; 为什么不用 deleteAppDataOnUninstall：
;   那个选项只对 one-click 安装器有效，我们用的是 assisted（有向导）。
;
; 数据位置（和 electron/main.js 的 resolveDataDir 一致）：
;   %APPDATA%\测试工作台\        ← 数据库、备份、运行时
;   文档\测试工作台\             ← 用例、jmx、压测报告、知识库、笔记
;
; ============================================================
; electron-builder 的两阶段编译（带 -WX，warning 当 error）
; ============================================================
;
; 阶段 1：BUILD_UNINSTALLER 已定义
;   → 只生成卸载器 exe（.onInit 里调 WriteUninstaller）
;   → 这个阶段**必须**定义所有 un.* 函数和卸载页
;
; 阶段 2：BUILD_UNINSTALLER 未定义
;   → 生成安装器，把阶段 1 的卸载器嵌进去
;   → 这个阶段**不能**定义 un.* 函数（否则报 warning 6020：
;     "Uninstaller script code found but WriteUninstaller never used"）
;
; 所以：un.* 函数和 UninstPage 都放在 !ifdef BUILD_UNINSTALLER 里。
; ============================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifdef BUILD_UNINSTALLER

  ; 全局变量（跨函数共享，$0-$9 和 $R0-$R9 是局部的，不能跨函数用）
  Var DeleteUserData
  Var DataDirAppData
  Var DataDirDocuments
  Var hCheckbox
  Var hWarnLabel

  ; 卸载页：在「完成」页之前插入
  !macro customUninstallPage
    UninstPage custom un.DataPageCreate un.DataPageLeave
  !macroend

  Function un.DataPageCreate
    ; 算出两个数据目录
    StrCpy $DataDirAppData "$APPDATA\${APP_FILENAME}"
    StrCpy $DataDirDocuments "$DOCUMENTS\${APP_FILENAME}"

    !insertmacro MUI_HEADER_TEXT "选择是否删除用户数据" "程序文件会被删除，用户数据可以选择保留"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "卸载会删除程序文件。下面这些用户数据可以选择保留或删除："
    Pop $0

    ${NSD_CreateLabel} 0 28u 100% 40u "· 数据库与备份：$DataDirAppData$\r$\n· 用例 / jmx / 报告 / 知识库 / 笔记：$DataDirDocuments"
    Pop $0

    ${NSD_CreateCheckbox} 0 76u 100% 12u "同时删除上述用户数据（不可恢复）"
    Pop $hCheckbox
    ${NSD_OnClick} $hCheckbox un.DataCheckboxClick

    ${NSD_CreateLabel} 0 96u 100% 70u ""
    Pop $hWarnLabel

    ; 默认不勾选（安全）
    StrCpy $DeleteUserData "0"

    nsDialogs::Show
  FunctionEnd

  Function un.DataCheckboxClick
    ; 勾选时显示红色警告
    ${NSD_GetState} $hCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      ${NSD_SetText} $hWarnLabel "⚠ 警告：勾选后，你的密码库、测试账号、用例索引、压测记录、笔记、知识库索引将全部永久删除，无法恢复。$\r$\n如果只是想重装程序，请不要勾选。"
    ${Else}
      ${NSD_SetText} $hWarnLabel ""
    ${EndIf}
  FunctionEnd

  Function un.DataPageLeave
    ${NSD_GetState} $hCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION \
        "确定要删除所有用户数据吗？$\r$\n$\r$\n这会永久删除：$\r$\n· 密码库和测试账号（含加密的密码）$\r$\n· 用例索引和接口关联$\r$\n· 压测记录和报告索引$\r$\n· 笔记和知识库索引$\r$\n$\r$\n删除后无法恢复。确定继续？" \
        IDYES +2
      Abort
      StrCpy $DeleteUserData "1"
    ${Else}
      StrCpy $DeleteUserData "0"
    ${EndIf}
  FunctionEnd

  ; 卸载时执行删除（在默认删除逻辑之后）
  !macro customUnInstall
    ${If} $DeleteUserData == "1"
      DetailPrint "正在删除用户数据..."
      RMDir /r "$DataDirAppData"
      RMDir /r "$DataDirDocuments"
      DetailPrint "用户数据已删除"
    ${Else}
      DetailPrint "保留用户数据：$DataDirAppData"
      DetailPrint "保留用户数据：$DataDirDocuments"
    ${EndIf}
  !macroend

!endif
