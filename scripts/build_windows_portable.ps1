# 用法：在 Windows PowerShell 的项目目录执行 .\scripts\build_windows_portable.ps1
# 首次准备依赖：.\scripts\build_windows_portable.ps1 -InstallDependencies
# 同时验证真实窗口启动：.\scripts\build_windows_portable.ps1 -VerifyLaunch
# 将 Python 后端、Electron 和网页资源打成一个免安装 EXE；依赖只用于构建。
[CmdletBinding()]
param(
    [switch]$InstallDependencies,
    [switch]$VerifyLaunch
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONUTF8 = '1'

function Step([int]$Number, [string]$Message) {
    Write-Progress -Activity '构建 EasyRead Windows 便携版' -Status $Message -PercentComplete (($Number - 1) * 100 / 6)
    Write-Host "[$Number/6] $Message"
}

function Check-Exit([string]$Message) {
    if ($LASTEXITCODE -ne 0) { throw "$Message（退出码：$LASTEXITCODE）" }
}

Step 1 '检查 Windows 构建环境'
if ($env:OS -ne 'Windows_NT') { throw '请在 Windows PowerShell 中运行；Python 后端不能从 Linux 交叉编译为 Windows EXE。' }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw '构建机需要安装 Node.js 22+。' }
$nodeMajor = [int]((& node.exe -p "process.versions.node.split('.')[0]") | Select-Object -Last 1)
Check-Exit '检查 Node.js 失败'
if ($nodeMajor -lt 22) { throw '构建机需要 Node.js 22+。' }
$activate = Join-Path $root '.venv\Scripts\Activate.ps1'
if (-not (Test-Path $activate)) {
    throw '请先用 Windows Python 创建虚拟环境：py -3.12 -m venv .venv，然后重新运行本脚本。'
}
. $activate
& python -c "import sys, struct; print(sys.executable); assert sys.prefix != sys.base_prefix, '必须使用项目虚拟环境'; assert sys.platform == 'win32', '必须使用 Windows Python'; assert struct.calcsize('P') == 8, '需要 64 位 Python'"
Check-Exit '检查 Python 虚拟环境失败'
# 固定后端构建使用刚激活的解释器，避免继承其他终端的 PYTHON 配置。
$env:PYTHON = (Get-Command python).Source

Step 2 '准备构建依赖'
# Node 下载器不会自动继承 Windows 系统代理；仅为本次构建复用已配置的代理。
# 显式设置的环境变量优先，不修改系统设置，也不输出代理凭据。
if (-not $env:HTTPS_PROXY) {
    $downloadUri = [Uri]'https://github.com'
    $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
    if (-not $systemProxy.IsBypassed($downloadUri)) {
        $proxyUri = $systemProxy.GetProxy($downloadUri)
        if ($proxyUri -and $proxyUri.AbsoluteUri -ne $downloadUri.AbsoluteUri) {
            $env:HTTPS_PROXY = $proxyUri.AbsoluteUri
            if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $proxyUri.AbsoluteUri }
            Write-Host '本次构建下载使用 Windows 系统代理。'
        }
    }
}
if ($env:HTTPS_PROXY) {
    $env:ELECTRON_GET_USE_PROXY = '1'
    # 本机冒烟测试始终直连，避免测试请求经过下载代理。
    $env:NO_PROXY = (@('localhost', '127.0.0.1', '::1', $env:NO_PROXY) | Where-Object { $_ }) -join ','
}
if ($InstallDependencies) {
    & python -m pip install --disable-pip-version-check pyinstaller .
    Check-Exit '安装 Python 构建依赖失败'
    # Windows 和 WSL 共用源码时保留现有 Electron 目录，由构建器按目标平台选取。
    & npm.cmd install --ignore-scripts --no-audit --no-fund
    Check-Exit '安装 Node.js 构建依赖失败'
}
& python -c 'import PyInstaller, easyread, pypdfium2, pdfplumber, PIL, pypdf, truststore, certifi'
Check-Exit '缺少 Python 构建依赖，请加 -InstallDependencies 重试'
$builder = Join-Path $root 'node_modules\electron-builder\cli.js'
if (-not (Test-Path $builder)) { throw '缺少 electron-builder，请加 -InstallDependencies 重试。' }

Step 3 '打包 Python 后端及 PDF、字体、网页资源'
& python scripts/build_backend.py
Check-Exit '构建后端失败'

Step 4 '验证打包后端的 PDF 导入、文字提取和图片渲染'
& python scripts/smoke_backend.py
Check-Exit '后端冒烟测试失败'

Step 5 '生成 Windows x64 单文件 EXE'
$builderArgs = @($builder, '--win', 'portable', '--x64', '--publish', 'never')
# 优先复用已经下载且版本匹配的 Windows Electron；否则由构建器下载。
$electronDir = Join-Path $root 'node_modules\electron\dist-win32-x64'
$electronVersion = (Get-Content (Join-Path $root 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
if ((Test-Path (Join-Path $electronDir 'electron.exe')) -and (Test-Path (Join-Path $electronDir 'version'))) {
    $localVersion = (Get-Content (Join-Path $electronDir 'version') -Raw).Trim().TrimStart('v')
    if ($localVersion -eq $electronVersion) { $builderArgs += "--config.electronDist=$electronDir" }
}
& node.exe @builderArgs
Check-Exit '构建便携 EXE 失败'

Step 6 '核对交付文件'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$artifact = Join-Path $root "dist\electron\EasyRead-Portable-$version-x64.exe"
if (-not (Test-Path $artifact)) { throw "未找到构建结果：$artifact" }
if ($VerifyLaunch) {
    & node.exe scripts/smoke_portable.cjs $artifact
    Check-Exit '便携版启动验证失败'
}
Get-Item $artifact | Select-Object FullName, Length
Get-FileHash $artifact -Algorithm SHA256 | Format-List
Write-Progress -Activity '构建 EasyRead Windows 便携版' -Completed
Write-Host "完成。双击即可运行：$artifact"
