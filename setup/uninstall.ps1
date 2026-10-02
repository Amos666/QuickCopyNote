# QuickCopyNote 卸载(UI 脚本,保留数据)
# 由 uninstall.bat 调用。批处理文件保持纯 ASCII,中文输出全部放在本 ps1 里,
# 规避 cmd.exe 在 chcp 65001 下 goto 后重定位读行的 UTF-8 解析 bug。
$ErrorActionPreference = 'Continue'
$setupDir = $PSScriptRoot
$root = Split-Path -Parent $setupDir

function Say([string]$m) { Write-Host $m }

Say '============================================'
Say '  QuickCopyNote  卸载(保留数据)'
Say '============================================'
Say ''

$hasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
$serverJs = Join-Path $root 'server.js'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\QuickCopyNote.lnk'

# ---- 1. 取消开机自启 ----
Say '[*] 移除开机自启 ...'
if ($hasNode) {
  & node $serverJs --autostart-off | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Say '[OK] 已从「启动」目录移除 QuickCopyNote.lnk'
  } else {
    if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue; Say '[OK] 已删除启动项' } else { Say '[i] 未发现启动项。' }
  }
} else {
  if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue; Say '[OK] 已删除启动项' } else { Say '[i] 未发现启动项(且无 node 可用)。' }
}

# ---- 2. 停止正在运行的服务(隐藏进程 + 面板窗口;用户无法自行结束的都在这里清)----
Say '[*] 停止后台服务 ...'
if ($hasNode) {
  & node (Join-Path $setupDir 'kill-old.js')
} else {
  # 没有 node 的兜底:按 daemon.json 记录的 pid 结束
  $daemon = Join-Path $root '.qcn\daemon.json'
  $killed = $false
  if (Test-Path $daemon) {
    try {
      $j = Get-Content $daemon -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.pid -and (Get-Process -Id $j.pid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $j.pid -Force -ErrorAction SilentlyContinue
        Say "[OK] 已结束进程 pid $($j.pid)"
        $killed = $true
      }
    } catch { }
  }
  if (-not $killed) { Say '[i] 未发现运行中的服务记录。' }
}

# ---- 3. 清理运行时(不动数据)----
Remove-Item (Join-Path $root '.qcn') -Recurse -Force -ErrorAction SilentlyContinue

Say ''
Say '完成。你的数据仍保留在 .qcn-data\snippets.json。'
Say '如需彻底删除,手动删除整个 QuickCopyNote 目录即可。'
Say ''
Read-Host '按回车退出'
