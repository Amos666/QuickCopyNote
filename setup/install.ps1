# QuickCopyNote 安装 / 启动(UI 脚本)
# 由 start.bat 调用。批处理文件保持纯 ASCII,中文输出全部放在本 ps1 里,
# 规避 cmd.exe 在 chcp 65001 下 goto 后重定位读行的 UTF-8 解析 bug。
$ErrorActionPreference = 'Continue'
$setupDir = $PSScriptRoot
$root = Split-Path -Parent $setupDir

function Say([string]$m) { Write-Host $m }

Say '============================================'
Say '  QuickCopyNote  安装 / 启动'
Say '============================================'
Say ''

# ---- 1. 检查 node ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say '[X] 未找到 node。请确认已安装 Node.js 且已加入 PATH。'
  Say '    退路:直接双击 quickcopynote.html,以“降级模式”(localStorage)使用。'
  Say ''
  Read-Host '按回车退出'
  exit 1
}
$nodeVer = & node --version
Say "[OK] Node.js $nodeVer"

# ---- 2. 清理上一版残留进程(后台隐藏进程,用户无法自行结束)----
Say '[*] 检查并清理正在运行的旧版本 ...'
& node (Join-Path $setupDir 'kill-old.js')

# ---- 3. 启动服务(全后台:经 wscript+vbs 隐藏启动 node,含 --open 打开 Edge 面板;
#      与开机自启同一方案,不留 cmd 控制台窗口)----
Say '[*] 启动本地服务(后台运行,无窗口) ...'
$serverJs = Join-Path $root 'server.js'
$nodeExe = (Get-Command node).Source
$qcnDir = Join-Path $root '.qcn'
if (-not (Test-Path $qcnDir)) { New-Item -ItemType Directory -Path $qcnDir -Force | Out-Null }
$vbs = Join-Path $qcnDir 'install-hidden.vbs'
$vbsContent = @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$root"
sh.Run """$nodeExe"" ""$serverJs"" --open", 0, False
"@
# wscript 不认 UTF-8 BOM,必须按 ANSI 写出(路径均为 ASCII)
[System.IO.File]::WriteAllText($vbs, $vbsContent, [System.Text.Encoding]::Default)
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`""

# ---- 4. 等待就绪并自检 ----
Say '[*] 等待服务就绪 ...'
$port = $null
$daemon = Join-Path $root '.qcn\daemon.json'
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $daemon) {
    try {
      $j = Get-Content $daemon -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.pid -and (Get-Process -Id $j.pid -ErrorAction SilentlyContinue)) { $port = $j.port; break }
    } catch { }
  }
}
if (-not $port) { $port = 7788 }
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/ping" -TimeoutSec 3
  Write-Host "[OK] 服务在线, 端口 $($r.port)"
} catch {
  Write-Host "[X] 无法连接服务(http://127.0.0.1:$port)。若公司策略禁止本地监听,请改用降级模式:双击 quickcopynote.html"
}

# ---- 5. 注册开机自启(「启动」目录 .lnk,不写注册表)----
Say '[*] 设置开机自启 ...'
& node $serverJs --autostart-on | Out-Null
if ($LASTEXITCODE -eq 0) {
  Say '[OK] 已加入开机自启(可在面板底部“开机自启”开关里取消)'
} else {
  Say '[!] 开机自启设置失败(可能策略限制)。不影响本次使用,下次开机后手动再跑一次本脚本即可。'
}

Say ''
Say '============================================'
Say '  完成!'
Say '  - Edge 应用窗口应已打开;若没有,浏览器访问:'
Say "      http://127.0.0.1:$port/"
Say '  - 全局热键: Ctrl+Alt+P  (呼出 / 隐藏面板)'
Say '      隐藏时任务栏按钮同步消失;唤醒后直接 j/k 上下选择。'
Say '  - 若热键无反应,见 setup\fallback-task-scheduler.md'
Say '============================================'
Say ''
Read-Host '按回车退出'
