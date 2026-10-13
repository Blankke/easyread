# 用法：在 PowerShell 的项目目录运行 .\scripts\install_electron_windows.ps1。
# 从 Electron 官方发布页下载与 package.json 一致的 Windows 程序，校验 SHA-256 后放入独立目录。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electronRoot = Join-Path $root 'node_modules\electron'
$packageFile = Join-Path $electronRoot 'package.json'
if (-not (Test-Path $packageFile)) { throw '请先运行 npm install 安装 Node 依赖。' }
$version = (Get-Content $packageFile -Raw | ConvertFrom-Json).version
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "electron-v$version-win32-$arch.zip"
$cache = Join-Path $root 'node_modules\.cache\easyread-electron'
$zip = Join-Path $cache $name
$sums = Join-Path $cache 'SHASUMS256.txt'
$destination = Join-Path $electronRoot "dist-win32-$arch"
$binary = Join-Path $destination 'electron.exe'
if (Test-Path $binary) { Write-Host "Electron $version 已安装：$binary"; exit 0 }

New-Item -ItemType Directory -Force -Path $cache | Out-Null
$release = "https://github.com/electron/electron/releases/download/v$version"
Invoke-WebRequest -Uri "$release/$name" -OutFile $zip
Invoke-WebRequest -Uri "$release/SHASUMS256.txt" -OutFile $sums
$line = Get-Content $sums | Where-Object { $_ -match "\s\*?$([regex]::Escape($name))$" } | Select-Object -First 1
if (-not $line) { throw "官方校验文件中找不到 $name" }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Electron 下载校验失败：$name" }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Expand-Archive -Path $zip -DestinationPath $destination -Force
if (-not (Test-Path $binary)) { throw 'Electron 压缩包中没有 electron.exe。' }
Write-Host "Electron $version 已安装：$binary"
