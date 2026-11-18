; MaskTab 的 Windows 安装程序（NSIS 3）。
;
; 构建（见 .github/workflows/ci.yml）：
;   makensis /INPUTCHARSET UTF8 /DVERSION=0.1.23 /DVERSION4=0.1.23.0 /DSRC=<含 masktab.exe 的目录> /DOUT=<输出>\MaskTab-Setup.exe installer\masktab.nsi
;   完整包再加：/DFULL /DKVER=<内核版本> /DMVER=<mihomo 版本> /DKERNEL=<解压好的内核目录> /DMIHOMO=<mihomo.exe>
;   路径一律用绝对路径（makensis 的相对路径是相对脚本所在目录的）。两个组件用 go run ./cmd/pack 准备。
;
; 两种安装包用同一个脚本：
;   普通包：只有 masktab.exe（几 MB）。升级 MaskTab 用它。缺的组件由 MaskTab 首次运行时下载。
;   完整包（-DFULL）：另带浏览器内核与代理内核，装完不需要再下载任何东西。
;
; 覆盖安装的规则（"只更新变了的部分"）：
;   - masktab.exe：总是替换。
;   - 代理内核 mihomo.exe：已装的版本与包里的版本相同就跳过。
;   - 浏览器内核：这个版本已经在（无论是以前装的还是 MaskTab 自己下载的）就跳过；版本变了才装新的，并删掉旧版本。
;   - data 目录（实例、登录状态、订阅、扩展、设置）：安装与升级都不碰；卸载时默认保留。
;
; 装到当前用户目录，不需要管理员权限。静默安装：MaskTab-Setup.exe /S /D=C:\某目录（/D 必须在最后，不加引号）。
; 在线更新（MaskTab 自己下载安装包后运行）：MaskTab-Setup.exe /S /RELAUNCH /D=<现在的安装目录>，装完把 MaskTab 重新打开。

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSION4
  !define VERSION4 "0.0.0.0"
!endif
!ifndef SRC
  !define SRC "dist"
!endif
!ifndef OUT
  !define OUT "MaskTab-Setup.exe"
!endif
; makensis 在 Windows 上只认反斜杠路径，在 Linux 上只认正斜杠
!ifdef NSIS_WIN32_MAKENSIS
  !define SEP "\"
!else
  !define SEP "/"
!endif
; 安装程序、卸载程序自己的图标：和 masktab.exe 同一个（CI 用 go run ./cmd/winres -ico 写到 SRC 目录里）。没有这个文件就用 NSIS 自带的。
!if /FileExists "${SRC}${SEP}masktab.ico"
  !define MUI_ICON "${SRC}${SEP}masktab.ico"
  !define MUI_UNICON "${SRC}${SEP}masktab.ico"
!endif
!define APP "MaskTab"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MaskTab"

Name "${APP} ${VERSION}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\MaskTab"
InstallDirRegKey HKCU "Software\MaskTab" "InstallDir"
BrandingText "${APP} ${VERSION}"
VIProductVersion "${VERSION4}"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} 安装程序"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" ""

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\masktab.exe"
!define MUI_FINISHPAGE_RUN_TEXT "运行 MaskTab"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; 让装在 $INSTDIR 里的 MaskTab 退出，再等 masktab.exe 解除占用。HELPER 是一份（新版的）masktab.exe，放在临时目录里：
;   masktab.exe -stop-installed <目录> = 先请它自己退（关窗口、保存状态）；叫不到的（锁文件丢了、卡住了）按完整路径结束进程。
; 为什么不用 taskkill（decisions D-5）：安装程序是 32 位的，叫到的是 32 位的 taskkill，它在有的 Windows 11（26200）上根本不工作
; （“The remote system must be running Windows 2000 or above”）；而且按映像名杀会连累装在别处的 MaskTab。
; 只有 HELPER 不管用时才退回去用 taskkill，并且指名用 64 位的那个。
!macro StopRunning HELPER
  ${If} ${FileExists} "$INSTDIR\masktab.exe"
    DetailPrint "正在关闭运行中的 MaskTab…"
    ${If} ${FileExists} "${HELPER}"
      nsExec::Exec '"${HELPER}" -stop-installed "$INSTDIR"'
      Pop $0
    ${Else}
      nsExec::Exec '"$INSTDIR\masktab.exe" -quit'
      Pop $0
    ${EndIf}
    StrCpy $1 0
    ${Do}
      ClearErrors
      FileOpen $0 "$INSTDIR\masktab.exe" a
      ${IfNot} ${Errors}
        FileClose $0
        ${ExitDo}
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 == 6
        DetailPrint "还没退出，强行结束…"
        ${If} ${FileExists} "$WINDIR\Sysnative\taskkill.exe"
          nsExec::Exec '"$WINDIR\Sysnative\taskkill.exe" /F /IM masktab.exe'
        ${Else}
          nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM masktab.exe'
        ${EndIf}
        Pop $0
      ${EndIf}
      ${If} $1 > 16
        ${ExitDo}
      ${EndIf}
      Sleep 500
    ${Loop}
  ${EndIf}
!macroend

; 旧的关不掉：说清楚、什么都不改、退出。以前是 NSIS 自带的“无法打开要写入的文件 … 中止 / 重试 / 忽略”，
; 点了“忽略”会装成半截（程序还是旧的，注册表里却写着新版本号）。
!macro FailStillRunning
  MessageBox MB_OK|MB_ICONSTOP "旧版本的 MaskTab 还在运行，安装程序关不掉它，所以什么都没有改。$\n$\n请打开任务管理器（Ctrl+Shift+Esc）→「详细信息」，把 masktab.exe 都结束掉，再重新运行这个安装程序。$\n$\n如果 MaskTab 当初是「以管理员身份运行」打开的，安装程序也要右键「以管理员身份运行」。" /SD IDOK
  SetErrorLevel 3
  Abort "旧版本的 MaskTab 还在运行，没有安装。"
!macroend

Section "MaskTab" SecMain
  SectionIn RO
  ; 新版的 masktab.exe 先解一份到临时目录，用它去让旧的退出（同一个文件在安装包里只存一份，不占地方）
  InitPluginsDir
  File "/oname=$PLUGINSDIR\mt-stop.exe" "${SRC}${SEP}masktab.exe"
  !insertmacro StopRunning "$PLUGINSDIR\mt-stop.exe"
  ${If} ${FileExists} "$INSTDIR\masktab.exe"
    ClearErrors
    FileOpen $0 "$INSTDIR\masktab.exe" a
    ${If} ${Errors}
      !insertmacro FailStillRunning
    ${EndIf}
    FileClose $0
  ${EndIf}
  SetOutPath "$INSTDIR"
  SetOverwrite try
  ClearErrors
  File "${SRC}${SEP}masktab.exe"
  ${If} ${Errors}
    !insertmacro FailStillRunning
  ${EndIf}
  SetOverwrite on

!ifdef FULL
  ; ---- 代理内核：版本相同就跳过 ----
  ${If} ${FileExists} "$INSTDIR\mihomo.exe"
  ${AndIf} ${FileExists} "$INSTDIR\mihomo-${MVER}.ver"
    DetailPrint "代理内核 ${MVER} 已是最新，跳过"
  ${Else}
    DetailPrint "安装代理内核 ${MVER}"
    nsExec::Exec '"$PLUGINSDIR\mt-stop.exe" -stop-installed "$INSTDIR"' ; 上面已经停过一遍，这里只是保险：mihomo.exe 也按完整路径停
    Pop $0
    Delete "$INSTDIR\mihomo-*.ver"
    File "/oname=mihomo.exe" "${MIHOMO}"
    FileOpen $0 "$INSTDIR\mihomo-${MVER}.ver" w
    FileClose $0
  ${EndIf}

  ; ---- 浏览器内核：这个版本已经在就跳过（包括 MaskTab 自己下载到 data\kernel 的）----
  ${If} ${FileExists} "$INSTDIR\kernel\fingerprint-chromium\${KVER}\installed.ok"
  ${OrIf} ${FileExists} "$INSTDIR\data\kernel\fingerprint-chromium\${KVER}\*.*"
    DetailPrint "浏览器内核 ${KVER} 已存在，跳过"
  ${Else}
    DetailPrint "安装浏览器内核 ${KVER}（文件较多，需要一两分钟）"
    ; 删掉旧版本（版本号不同的目录）与上次没装完的残留
    FindFirst $0 $1 "$INSTDIR\kernel\fingerprint-chromium\*.*"
    ${DoWhile} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        RMDir /r "$INSTDIR\kernel\fingerprint-chromium\$1"
      ${EndIf}
      FindNext $0 $1
    ${Loop}
    FindClose $0
    SetOutPath "$INSTDIR\kernel\fingerprint-chromium\${KVER}"
    SetDetailsPrint textonly
    File /r "${KERNEL}${SEP}*.*"
    SetDetailsPrint both
    FileOpen $0 "$INSTDIR\kernel\fingerprint-chromium\${KVER}\installed.ok" w
    FileClose $0
    SetOutPath "$INSTDIR"
  ${EndIf}
!endif

  ; ---- 快捷方式、卸载信息 ----
  CreateShortcut "$SMPROGRAMS\MaskTab.lnk" "$INSTDIR\masktab.exe"
  CreateShortcut "$DESKTOP\MaskTab.lnk" "$INSTDIR\masktab.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\MaskTab" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\MaskTab" "Version" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "MaskTab"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\masktab.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K /G=0" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  ; 让资源管理器重新读图标：masktab.exe 以前没有图标，快捷方式上是个白板，不通知的话换了图标它也照旧显示缓存里的
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; ---- 在线更新：带 /RELAUNCH 时装完把 MaskTab 重新打开（有界面安装时由最后一页的“运行 MaskTab”负责）----
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/RELAUNCH" $R1
  ${IfNot} ${Errors}
    DetailPrint "重新打开 MaskTab"
    Exec '"$INSTDIR\masktab.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  ; 卸载时没有“新版”可用：把装着的 masktab.exe 复制一份到临时目录来跑（它自己停不了自己那个文件对应的进程）
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\masktab.exe" "$PLUGINSDIR\mt-stop.exe"
  !insertmacro StopRunning "$PLUGINSDIR\mt-stop.exe"
  Delete "$INSTDIR\masktab.exe"
  Delete "$INSTDIR\mihomo.exe"
  Delete "$INSTDIR\mihomo-*.ver"
  RMDir /r "$INSTDIR\kernel"
  Delete "$SMPROGRAMS\MaskTab.lnk"
  Delete "$DESKTOP\MaskTab.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\MaskTab"
  ; 浏览器数据默认保留（静默卸载时一定保留）；重新安装到同一目录后原样可用。
  ${If} ${FileExists} "$INSTDIR\data\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "同时删除全部浏览器数据吗？$\n$\n包括各实例的登录状态、书签、扩展、订阅与设置，删除后无法恢复。$\n选择「否」会保留在：$INSTDIR\data" /SD IDNO IDNO keepdata
    RMDir /r "$INSTDIR\data"
    keepdata:
  ${EndIf}
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
