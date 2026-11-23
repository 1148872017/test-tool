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
; 注意：不要 include nsProcess.nsh —— 它依赖 nsProcess.dll，
; 而 !addplugindir 在 electron-builder 的脚本里、本文件之后才执行。
; 进程检测改用 nsExec + tasklist（不依赖插件）。
;
; 也不要 include StrContains.nsh —— assistedInstaller.nsh 第 23 行已经 include 过，
; 重复 include 会报 `variable "STR_HAYSTACK" already declared`。
; 我们的 customInit 在模板之后展开，那时 StrContains 宏已可用。

; ---- 编译期：隐藏安装详情区 ----
; 为什么隐藏：
;   electron-builder 的 installSection.nsh 第 6 行有 `SetDetailsPrint none`，
;   它在解压**之前**执行，关闭了 DetailPrint 输出。
;   我们的 customInstall 钩子在解压**之后**，即使 SetDetailsPrint both 也来不及——
;   解压过程本来就没有逐文件输出（7z 一次性解压）。
;   所以详情区永远是空白的大白框，不如隐藏，只留进度条，界面更干净。
!macro customHeader
  ShowInstDetails nevershow
  ShowUninstDetails nevershow
!macroend

; ---- 安装开始前：覆盖提示 + 进程检查 ----
; 用 customInit（.onInit 里执行），不依赖页面，不会被 skipPageIfUpdated 跳过。
;
; 为什么进程检查放这里：
;   electron-builder 的 CHECK_APP_RUNNING 在 installSection.nsh 里，
;   位置在 SetOutPath 之后、解压之前——所以进度条已经动了一点才提示。
;   放到 .onInit 就是「点安装的瞬间」提示。
!macro customInit
  ; 1. 检查程序是否在运行
  ;
  ; 为什么不用 StrCmp 比较 tasklist 输出：
  ;   tasklist 没找到进程时输出「信息: 没有运行的任务匹配指定标准。」（中文系统）
  ;   或「INFO: No tasks are running which match the specified criteria.」（英文系统）。
  ;   硬编码任何一种，在另一种语言的系统上都会误判 → 100% 误报「正在运行」。
  ;
  ; 正确做法：用 find 的**退出码**判断，与语言无关。
  ;   find 找到 → 退出码 0
  ;   find 没找到 → 退出码 1
  ;
  ; 注意：nsExec::ExecToStack 先 Pop 出来的是退出码，再 Pop 是输出。
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | find /I "${APP_EXECUTABLE_FILENAME}" >nul'
  Pop $R2 ; 退出码（0=在跑，1=没跑）
  Pop $R3 ; 输出（find 重定向到 nul 了，这里是空）

  StrCmp $R2 "0" appRunning notRunning

  appRunning:
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "「${PRODUCT_NAME}」正在运行。$\r$\n$\r$\n安装前需要先关闭它，否则文件会被占用。$\r$\n点「确定」自动关闭并继续安装，点「取消」退出。" \
      IDOK +2
    Quit
    ; 用户点确定 → 结束进程，并**循环确认真的退出了**
    ; （只 Sleep 一次不够，Electron 有多个子进程，退出需要时间）
    nsExec::ExecToLog 'taskkill /f /im ${APP_EXECUTABLE_FILENAME} /t'
    Pop $R2
    StrCpy $R6 "0"
    checkLoop:
      IntOp $R6 $R6 + 1
      Sleep 500
      nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | find /I "${APP_EXECUTABLE_FILENAME}" >nul'
      Pop $R2
      Pop $R3
      StrCmp $R2 "0" +2 checkDone
      ; 还在跑，最多等 10 次（5 秒）
      IntCmp $R6 10 checkDone checkLoop checkDone
    checkDone:

  notRunning:

  ; 2. 检查是否已安装（覆盖提示）
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

; ---- 安装 Section 内：重新打开详情输出 + 阶段提示 + 重建快捷方式 ----
; installSection.nsh 第 6 行 SetDetailsPrint none 关掉了输出，这里重新打开。
;
; 图标刷新：**不做缓存刷新**（SHChangeNotify / ie4uinit 都无效，重启 explorer 会闪屏）。
; 改用「快捷方式指向独立 ico 文件」方案：
;   1. 把 build/icon.ico 复制到安装目录，文件名带版本号（app-0.26.11.ico）
;   2. 快捷方式的 IconLocation 指向这个文件
;   3. 每次发版文件名不同 → Windows 缓存自然失效
;
; 为什么不用「exe 图标」：electron-builder 的 CreateShortCut 用 `$appExe,0`，
; 而 keepShortcuts 机制会 Rename 旧快捷方式（不重建），所以图标永远是旧的。
; ---- 自定义完成页：自己控制「运行程序」----
; 为什么替换 electron-builder 的完成页：
;   它的 StartApp 用 `StdUtils.ExecShellAsUser $launchLink`，
;   而 $launchLink 指向开始菜单快捷方式（我们的 customInstall 会覆盖它，
;   explorer 可能还没索引到 → 启动失败）。
;
; 这里自己实现：用 `ExecShell` 直接启动 **exe**（不走快捷方式）。
; 注意：不能用 StdUtils.ExecShellAsUser —— 它在 customFinishPage 展开时
; 还没加载（StdUtils.nsh 在模板更后面才 include）。
; ExecShell 会以当前用户身份启动（安装器虽是提权的，但 ShellExecute 默认继承 explorer 的令牌）。
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ; 直接启动 exe，不用 $launchLink（快捷方式可能刚被覆盖）
      ExecShell "open" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_FINISHPAGE_RUN_TEXT "运行 ${PRODUCT_NAME}"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend

; ---- 安装完成后：刷新图标 ----
!macro customInstall
  ; 详情区已隐藏（ShowInstDetails nevershow），DetailPrint 不显示，
  ; 但保留 SetDetailsPrint both 以防将来改回显示。
  SetDetailsPrint both

  DetailPrint "正在创建快捷方式..."

  ; 1. 复制图标到安装目录（文件名带版本号，缓存自然失效）
  ;    注意：electron-builder 定义的变量是 VERSION（不是 APP_VERSION）
  !ifdef VERSION
    StrCpy $R5 "app-${VERSION}.ico"
  !else
    StrCpy $R5 "app.ico"
  !endif
  SetOutPath "$INSTDIR"
  File "/oname=$R5" "${BUILD_RESOURCES_DIR}\icon.ico"
  DetailPrint "图标文件：$INSTDIR\$R5"

  ; 2. 重建桌面快捷方式，图标指向独立 ico
  ;    注意：不要 Delete 再 Create —— 那样会破坏 launchLink（安装完成后
  ;    「运行程序」用的就是 $newStartMenuLink，删了会导致启动失败）。
  ;    直接 CreateShortCut 覆盖即可（同名会覆盖）。
  ${If} ${FileExists} "$INSTDIR\$R5"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\$R5" 0 "" "" "${APP_DESCRIPTION}"
    DetailPrint "桌面快捷方式已更新"
  ${EndIf}

  ; 3. 重建开始菜单快捷方式（同上，不删只覆盖）
  ${If} ${FileExists} "$INSTDIR\$R5"
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\$R5" 0 "" "" "${APP_DESCRIPTION}"
    DetailPrint "开始菜单快捷方式已更新"
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
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

    ; 明确告知：不会删除已安装的开发环境
    ${NSD_CreateLabel} 0 70u 100% 30u "不会删除：已安装的 JDK / Python / Maven / JMeter / Playwright 浏览器。$\r$\n这些是你自己装的环境，平台从不修改也不删除。"
    Pop $0

    ${NSD_CreateCheckbox} 0 102u 100% 12u "同时删除上述用户数据（不可恢复）"
    Pop $hCheckbox
    ${NSD_OnClick} $hCheckbox un.DataCheckboxClick

    ${NSD_CreateLabel} 0 122u 100% 70u ""
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
