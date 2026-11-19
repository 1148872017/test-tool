# 打包文档 zip：README.md + docs\（截图 + 交接文档）
#
# 为什么单独打：安装包只装程序，文档（README、17 张截图、34 条踩坑笔记）
# 塞进安装目录很奇怪。单独一个几 MB 的 zip，需要的人自己下。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-docs.ps1 [-Version 0.24.0]
param([string]$Version = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) {
  $Version = (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'package.json') | ConvertFrom-Json).version
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

$sevenZip = Find-7za
if (-not $sevenZip) {
  throw '找不到 7za.exe。先跑一次 npx electron-builder --win --dir --x64（它会把 7zip 下到缓存），或把 7z 加进 PATH。'
}

# 产物名用 ASCII：GitHub Release 上传中文名会被截断
$zip = Join-Path $root ("release\test-tool-docs-{0}.zip" -f $Version)
if (Test-Path $zip) { Remove-Item $zip -Force }

Write-Host "[docs] 版本 $Version"

$extra = @('README.md')
if (Test-Path (Join-Path $root 'docs')) {
  $extra += 'docs'
} else {
  Write-Host '[docs] 警告：docs\ 目录不存在，只打 README'
}

& $sevenZip a -tzip -mx=5 $zip $extra | Select-Object -Last 1
$code = $LASTEXITCODE
if ($code -ne 0) { throw "7za 退出码 $code" }

$sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "[docs] 完成：$zip ($sizeMb MB)"
