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
;   → 这个阶段**不能**定义 un.* 函数（否则报 warning 6020）
;
; 所以：un.* 函数和 UninstPage 都放在 !ifdef BUILD_UNINSTALLER 里。
; ============================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"

; ---- 安装过程可展开查看 ----
; electron-builder 的 common.nsh 默认 ShowInstDetails nevershow（隐藏详情）。
;
; 关键：这个指令必须在 Section 之前生效，而 installer.nsh 是被 include 到
; 模板**末尾**的（Section 之后），所以直接写 ShowInstDetails 无效。
; 必须放进 customHeader 宏——它在 installer.nsi 第 45 行被插入，
; 早于第 94 行的 Section。
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

; ---- 覆盖安装时提示「已安装，将覆盖」 ----
; electron-builder 的 skipPageIfUpdated 会在升级时跳过欢迎页/目录页，
; 用户看不到「已安装旧版」的提示，直接进入安装。
; 这里在目录页之后插一个自定义页，只在「目标目录已有旧版」时显示。
;
; 判断方式用「目标目录里有没有主程序 exe」，不依赖 ${isUpdated}
; （那个宏需要 installUtil.nsh，而 installer.nsh 被 include 的时机可能早于它）。
!macro customPageAfterChangeDir
  Page custom CoverPageCreate CoverPageLeave
!macroend

!ifndef BUILD_UNINSTALLER
  Function CoverPageCreate
    ; 目标目录里已有主程序 → 说明是覆盖安装
    ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "已检测到已安装的版本" "继续将覆盖现有程序，用户数据会保留"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 60u "检测到「${PRODUCT_NAME}」已经安装在：$\r$\n$INSTDIR$\r$\n$\r$\n继续安装会：$\r$\n· 覆盖程序文件（旧版会被卸载）$\r$\n· 保留你的数据（密码库、用例索引、笔记等）$\r$\n· 重建桌面和开始菜单快捷方式"
    Pop $0

    ${NSD_CreateLabel} 0 70u 100% 30u "如果不想覆盖，点「取消」退出安装。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function CoverPageLeave
    ; 无需校验，直接继续
  FunctionEnd
!endif

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
    StrCpy $DataDirAppData "$APPDATA\${PRODUCT_FILENAME}"
    StrCpy $DataDirDocuments "$DOCUMENTS\${PRODUCT_FILENAME}"

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

; ---- 安装完成后刷新图标缓存 ----
; 问题：覆盖安装后 exe 换了图标，但 Windows 图标缓存还显示旧的
; （任务栏/托盘已更新，桌面没变）。
;
; 两步走：
;   1. SHChangeNotify 通知 shell「关联变了」
;   2. ie4uinit.exe -show 强制刷新图标缓存（比 SHChangeNotify 彻底，且不闪屏）
!macro customInstall
  DetailPrint "刷新图标缓存..."
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ; ie4uinit 在 Win10+ 才有，失败不影响安装
  nsExec::ExecToLog 'ie4uinit.exe -show'
  Pop $0
!macroend
