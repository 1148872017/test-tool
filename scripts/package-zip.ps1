# 打包便携 zip：release\win-unpacked + README.md + docs\screens
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-zip.ps1 [-Version 0.4.1]
param([string]$Version = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) {
  $Version = (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'package.json') | ConvertFrom-Json).version
}

$unpacked = Join-Path $root 'release\win-unpacked'
if (-not (Test-Path $unpacked)) {
  throw '缺少 release\win-unpacked，先跑：npx electron-builder --win --dir --x64'
}

function Find-7za {
  $patterns = @()
  if ($env:ELECTRON_BUILDER_CACHE) {
    $patterns += (Join-Path $env:ELECTRON_BUILDER_CACHE '7zip@*\7zip-win-x64*\bin\7za.exe')
  }
  if ($env:LOCALAPPDATA) {
    $patterns += (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\7zip@*\7zip-win-x64*\bin\7za.exe')
  }
  foreach ($p in $patterns) {
    $hit = Get-ChildItem $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  foreach ($name in @('7za.exe', '7z.exe')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

# 产物名用 ASCII：GitHub Release 上传中文名会被截断（实测 测试工作台-0.21.0-win64.zip → -0.21.0-win64.zip）
$zip = Join-Path $root ("release\test-tool-{0}-win64.zip" -f $Version)
if (Test-Path $zip) { Remove-Item $zip -Force }

$sevenZip = Find-7za
if (-not $sevenZip) {
  throw '找不到 7za.exe。先跑一次 npx electron-builder --win --dir --x64（它会把 7zip 下到缓存），或把 7z 加进 PATH。'
}

Write-Host "[pack] 版本 $Version"
Write-Host "[pack] 压缩：release\win-unpacked\* + README.md + docs\screens + 交接文档"
# 分两步加：带通配符时 7za 以当前目录为基准，混着传会把 exe 塞进 release\win-unpacked\ 子目录
Push-Location $unpacked
& $sevenZip a -tzip -mx=5 $zip '*' | Select-Object -Last 1
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "7za 退出码 $code" }

# README 里引用了 docs/screens 的图，一起打进去，解压后直接能看
# 交接文档（含完整踩坑笔记）也带上：换机器/交接时最需要它
$extra = @('README.md', 'docs\screens')
$handoff = Get-ChildItem (Join-Path $root 'docs') -Filter '平台规划与进度-*.md' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if ($handoff) {
  $extra += ('docs\' + $handoff.Name)
  Write-Host "[pack] 交接文档：$($handoff.Name)"
}
& $sevenZip a -tzip -mx=5 $zip $extra | Select-Object -Last 1
$code = $LASTEXITCODE
if ($code -ne 0) { throw "7za 退出码 $code" }

$sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "[pack] 完成：$zip ($sizeMb MB)"
