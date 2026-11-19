; ============================================================
; 自定义 NSIS 脚本（electron-builder 会在 installer.nsi 里 include）
;
; 目的：
;   1. 安装过程显示阶段提示（详情区不再空白）
;   2. 覆盖安装时提示「已检测到已安装的版本」
;   3. 卸载时提供「是否删除用户数据」选项
;
; ============================================================
; 关键约束（踩过的坑）
; ============================================================
;
; 1. **本文件被 include 在模板之前**
;    electron-builder 的 computeFinalScript 返回
;    `scriptGenerator.build() + originalScript`，
;    我们的 !include 在 scriptGenerator 里，所以排在模板前面。
;    → 必须自己 !include MUI2.nsh / LogicLib.nsh，否则宏不可用。
;
; 2. **编译期指令（ShowInstDetails）要放 customHeader**
;    customHeader 在 installer.nsi 第 45 行插入，早于第 94 行的 Section。
;
; 3. **installSection.nsh 第 6 行有 `SetDetailsPrint none`**
;    它关闭了 DetailPrint 的输出，所以详情区是空的。
;    要在 Section 内部重新 SetDetailsPrint both。
;
; 4. **解压是 7z 一次性**，没有逐文件进度。
;    只能显示阶段提示（正在解压/正在创建快捷方式/正在刷新图标）。
;
; 5. **${isUpdated} 不能随便用**，它依赖 installUtil.nsh。
;    用「目标目录有没有主程序 exe」判断更可靠。
; ============================================================

!include "MUI2.nsh"
!include "LogicLib.nsh"

; ---- 编译期：显示安装详情 ----
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

; ---- 安装开始前：覆盖安装提示 ----
; 用 customInit（.onInit 里执行），不依赖页面，不会被 skipPageIfUpdated 跳过。
; 注意：.onInit 时 $INSTDIR 可能还是默认值（用户还没选目录），
; 所以这里只做「注册表里有旧版」的判断，不判断目录。
!macro customInit
  ; 读注册表看有没有旧版安装记录
  ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R0 != ""
    ${If} ${FileExists} "$R0\${APP_EXECUTABLE_FILENAME}"
      MessageBox MB_OKCANCEL|MB_ICONQUESTION \
        "检测到「${PRODUCT_NAME}」已安装在：$\r$\n$R0$\r$\n$\r$\n继续安装将覆盖现有程序（旧版会被卸载）。$\r$\n你的数据（密码库、用例索引、笔记等）会保留。$\r$\n$\r$\n继续安装吗？" \
        IDOK +2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; ---- 安装 Section 内：重新打开详情输出 + 阶段提示 ----
; installSection.nsh 第 6 行 SetDetailsPrint none 关掉了输出，这里重新打开。
; 注意：customInstall 在安装末尾执行，所以只能显示「收尾阶段」的提示。
; 解压阶段的提示做不到（7z 一次性解压，没有回调）。
!macro customInstall
  SetDetailsPrint both

  DetailPrint "正在创建快捷方式..."
  DetailPrint "正在刷新图标缓存..."
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  nsExec::ExecToLog 'ie4uinit.exe -show'
  Pop $0
  DetailPrint "安装完成"
!macroend

; ---- 卸载页：是否删除用户数据 ----
!ifdef BUILD_UNINSTALLER

  Var DeleteUserData
  Var DataDirAppData
  Var DataDirDocuments
  Var hCheckbox
  Var hWarnLabel

  !macro customUninstallPage
    UninstPage custom un.DataPageCreate un.DataPageLeave
  !macroend

  Function un.DataPageCreate
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

    StrCpy $DeleteUserData "0"

    nsDialogs::Show
  FunctionEnd

  Function un.DataCheckboxClick
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
