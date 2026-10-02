#!/usr/bin/env node
'use strict';

/*
 * QuickCopyNote — 安装/卸载时静默清理"上一个版本"的隐藏进程
 *
 * 背景:服务以最小化 cmd 窗口后台运行(node server.js / listener.js / 常驻热键 PowerShell),
 * 用户看不到也无法手动结束。安装新版或卸载前,必须先把旧进程 Q 掉,否则:
 *   - 单实例锁会让新版直接退出(跑的还是旧代码)
 *   - 全局热键仍被旧 listener 占用,新版注册失败
 * 本脚本只匹配"明确属于 QuickCopyNote"的进程与窗口,绝不碰其他进程:
 *   1) node.exe:命令行含 QuickCopyNote 且含 server.js/listener.js
 *   2) powershell.exe:命令行含 QcnHotkey(常驻热键监听子进程)
 *   3) Edge 面板窗口:主窗口标题以 QuickCopyNote 开头 → 发 WM_CLOSE 优雅关闭
 * 用法:node setup\kill-old.js   (退出码恒为 0,清理失败只告警)
 */

const { spawnSync } = require('node:child_process');

function runPs(script) {
  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 }
    );
    return String(r.stdout || '');
  } catch (e) {
    return '';
  }
}

// ---- 1. 找出属于 QCN 的进程 pid ----
// 来源 A:命令行特征(绝对路径启动:start.bat / 开机自启都带 QuickCopyNote 目录名)
const findScript = `
Get-CimInstance Win32_Process | Where-Object {
  \$_.ProcessId -ne \$PID -and (
    (\$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'QuickCopyNote' -and \$_.CommandLine -match 'server\\.js|listener\\.js') -or
    (\$_.Name -eq 'powershell.exe' -and \$_.CommandLine -match 'QcnHotkey')
  )
} | ForEach-Object { '' + \$_.ProcessId }
`;
const found = runPs(findScript)
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => /^\d+$/.test(s))
  .map(Number);

// 来源 B:运行时登记文件里的 pid(相对路径启动时命令行不含 QuickCopyNote,靠这个兜底;
// 需回查进程名确是 node.exe,防止 pid 已被复用)
const recorded = [];
try {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['daemon.json', 'daemon.lock']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '.qcn', f), 'utf8'));
      if (Number.isInteger(j.pid)) recorded.push(j.pid);
    } catch (e) { /* 文件不存在/JSON 损坏:忽略 */ }
  }
} catch (e) { /* ignore */ }
for (const pid of recorded) {
  const info = runPs(
    "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').Name"
  ).trim();
  if (info === 'node.exe') found.push(pid);
}

const pids = [...new Set(found)].filter((p) => p !== process.pid); // 双保险:不杀自己

let killed = 0;
for (const pid of pids) {
  const r = spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 15000 });
  if (r.status === 0) {
    killed++;
    console.log('[kill-old] 已结束旧进程 pid ' + pid);
  }
}
if (!killed) console.log('[kill-old] 没有正在运行的 QuickCopyNote 后台进程。');

// ---- 2. 关闭 Edge 面板窗口(标题以 QuickCopyNote 开头)----
const closeScript = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -Namespace QcnKillOld -Name W -MemberDefinition '
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
'
$n = 0
Get-Process msedge | Where-Object { $_.MainWindowTitle -like 'QuickCopyNote*' } | ForEach-Object {
  if ($_.MainWindowHandle -ne 0) {
    [QcnKillOld.W]::PostMessage($_.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $n++
  }
}
Write-Output $n
`;
const closed = runPs(closeScript).trim();
if (closed && closed !== '0') console.log('[kill-old] 已关闭面板窗口 ' + closed + ' 个');

// 给系统一点时间释放端口/热键,新版随即启动才不会撞锁
if (killed) {
  // 删除服务登记文件:安装脚本的"等待就绪"循环必须以新鲜的 daemon.json 为准,
  // 否则会误读旧进程留下的文件立刻自检。
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const f of ['daemon.json', 'daemon.lock']) {
      fs.rmSync(path.resolve(__dirname, '..', '.qcn', f), { force: true });
    }
  } catch (e) { /* ignore */ }
  try {
    spawnSync('ping.exe', ['-n', '2', '127.0.0.1'], { windowsHide: true, timeout: 5000 });
  } catch (e) { /* ignore */ }
}

process.exit(0);
