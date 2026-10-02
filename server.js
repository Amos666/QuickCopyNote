#!/usr/bin/env node
'use strict';

/*
 * QuickCopyNote — 零依赖本地服务
 * 只用 node 内置模块。职责:
 *   - 数据:GET/POST /api/state (原子写 + 滚动快照)
 *   - 配置:GET/POST /api/config
 *   - 静态:伺服 quickcopynote.html (面板以 http://127.0.0.1:PORT 打开)
 *   - 窗口 IPC:/summon /hide /move /pin /ping (Windows 上经一次性 powershell 调 Win32;
 *              非 Windows 优雅降级为 no-op,便于跨平台自测数据层)
 *   - 生命周期:单实例锁 + 在 Windows 上拉起常驻热键监听进程 (listener.js)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, '.qcn');
const DATA_DIR = path.join(ROOT, '.qcn-data');
const SNAP_DIR = path.join(RUNTIME, 'snapshots');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'snippets.json');
const LOCK_FILE = path.join(RUNTIME, 'daemon.lock');
const DAEMON_FILE = path.join(RUNTIME, 'daemon.json');
const HTML_FILE = path.join(ROOT, 'quickcopynote.html');

const IS_WIN = process.platform === 'win32';
const DEFAULT_PORT = 7788;
const MAX_SNAPSHOTS = 5;
const PORT_TRY_LIMIT = 20;

// 面板窗口标题里带的会话令牌,供 Win32 FindWindow 精确识别窗口,避免认错/多开撞车
const SESSION_TOKEN = crypto.randomBytes(2).toString('hex');

// ---------- 基础工具 ----------

function ensureDirs() {
  for (const d of [RUNTIME, DATA_DIR, SNAP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadConfig() {
  const base = {
    port: DEFAULT_PORT,
    hotkey: 'Ctrl+Alt+P',
    topmost: true,
    edgeProfile: '.qcn/edge-profile',
    geometry: {
      center: { width: 760, height: 0 },
      left: { width: 380, height: 0 },
      right: { width: 380, height: 0 },
    },
  };
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed, geometry: { ...base.geometry, ...(parsed.geometry || {}) } };
  } catch {
    return base;
  }
}

function saveConfig(cfg) {
  atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// 原子写:临时文件 + fsync + rename;调用方负责在覆盖前做快照
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function snapshotState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(STATE_FILE, path.join(SNAP_DIR, `snippets-${ts}.json`));
    const files = fs
      .readdirSync(SNAP_DIR)
      .filter((f) => f.startsWith('snippets-') && f.endsWith('.json'))
      .map((f) => ({ f, m: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const extra of files.slice(MAX_SNAPSHOTS)) {
      fs.rmSync(path.join(SNAP_DIR, extra.f), { force: true });
    }
  } catch {
    /* 快照失败不应阻断写入 */
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    // 主文件损坏 → 尝试从最近快照恢复
    const recovered = recoverFromSnapshot();
    if (recovered) return recovered;
    throw err;
  }
}

function recoverFromSnapshot() {
  try {
    if (!fs.existsSync(SNAP_DIR)) return null;
    const files = fs
      .readdirSync(SNAP_DIR)
      .filter((f) => f.startsWith('snippets-') && f.endsWith('.json'))
      .map((f) => ({ f, m: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files) {
      try {
        return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
      } catch {
        /* 试下一个 */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeState(state) {
  snapshotState();
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ---------- 单实例锁 ----------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限,也算活着
  }
}

function acquireLock() {
  ensureDirs();
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (old && old.pid && pidAlive(old.pid) && old.pid !== process.pid) {
        console.error(`[QuickCopyNote] 已有实例在运行 (pid ${old.pid}, port ${old.port})。退出。`);
        process.exit(0);
      }
    }
  } catch {
    /* 锁文件损坏则覆盖 */
  }
  return true;
}

function writeLock(port) {
  atomicWrite(LOCK_FILE, JSON.stringify({ pid: process.pid, port, token: SESSION_TOKEN }, null, 2));
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_FILE, { force: true });
    fs.rmSync(DAEMON_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

// ---------- Windows 窗口控制 (一次性 powershell 调 Win32) ----------

// 生成执行窗口操作的 PowerShell 脚本。ops: summon|hide|move|pin
// 通过标题令牌精确定位 Edge 应用窗口 (class Chrome_WidgetWin_1)。
function buildWinPs(op, opts = {}) {
  const title = `QuickCopyNote\u00b7${SESSION_TOKEN}`;
  const common = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L; public int T; public int R; public int B; }
public class W {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, ref RECT r, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  static readonly IntPtr TOP = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;

  // 绕过 Windows 前台锁:面板窗口属于 Edge(另一个进程),单纯 SetForegroundWindow 会被拒。
  // 用 SwitchToThisWindow(资源管理器同款 API)+ 附加目标线程到前台线程 + 最小化/还原兜底 + 重试。
  public static void Foreground(IntPtr h) {
    // 统一 SW_RESTORE:被 SW_HIDE 的 Edge 应用窗口会忽略 SW_SHOW(5)
    ShowWindow(h, 9);
    SetWindowPos(h, TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    // SW_HIDE 的窗口往往仍是"假前台"(visible=False, fore=True),SetForegroundWindow
    // 对它是 no-op、WM_ACTIVATE 不派发 → 页面收不到键盘焦点。
    // 必须先最小化让前台真正易主,再在 AttachThreadInput 作用域内还原并抢前台,
    // 强制走完整的"失活→激活"周期。
    ShowWindow(h, 6);
    System.Threading.Thread.Sleep(50);
    uint tMe = GetCurrentThreadId();
    for (int i = 0; i < 8; i++) {
      IntPtr fg = GetForegroundWindow();
      uint tFg = GetWindowThreadProcessId(fg, IntPtr.Zero);
      uint tTg = GetWindowThreadProcessId(h, IntPtr.Zero);
      bool a1 = tFg != 0 && tFg != tMe && AttachThreadInput(tMe, tFg, true);
      bool a2 = tFg != 0 && tFg != tTg && AttachThreadInput(tTg, tFg, true);
      try {
        ShowWindow(h, 9);
        SetWindowPos(h, TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        SetActiveWindow(h);
        SetFocus(h);
        SwitchToThisWindow(h, true);
      } finally {
        if (a2) AttachThreadInput(tTg, tFg, false);
        if (a1) AttachThreadInput(tMe, tFg, false);
      }
      System.Threading.Thread.Sleep(40);
      if (GetForegroundWindow() == h) break;
    }
  }
}
"@
$title = '${title}'
$h = [W]::FindWindowW('Chrome_WidgetWin_1', $title)
`;

  if (op === 'summon') {
    return (
      common +
      `
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 0 }
[void][W]::Foreground($h)
Write-Output 'OK'
`
    );
  }

  if (op === 'hide') {
    // SW_HIDE(0):任务栏按钮同步消失,与 listener.js 的热键收起一致
    return (
      common +
      `
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 0 }
[void][W]::ShowWindow($h, 0)
Write-Output 'OK'
`
    );
  }

  if (op === 'pin') {
    const on = opts.on ? 1 : 0;
    const insert = on ? '0x0002 -bor 0x0001' : '0x0004 -bor 0x0001'; // TOPMOST / NOTOPMOST, 不改位置尺寸
    return (
      common +
      `
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 0 }
[void][W]::SetWindowPos($h, [IntPtr]::Zero, 0,0,0,0, ${insert})
Write-Output 'OK'
`
    );
  }

  if (op === 'move') {
    // pos: center|left|right ; w/h 来自 config.geometry
    // height<=0 表示 工作区高度+height (0=上下填满,负数=留出边距);工作区不含任务栏
    const pos = opts.pos || 'center';
    const w = opts.width | 0;
    const hRaw = opts.height | 0;
    return (
      common +
      `
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 0 }
$r = New-Object RECT
[void][W]::SystemParametersInfo(0x0030, 0, [ref]$r, 0)
$waW = $r.R - $r.L
$waH = $r.B - $r.T
$w = ${w}
$hh = ${hRaw}
if ($hh -le 0) { $hh = $waH + $hh }
if ($hh -gt $waH) { $hh = $waH }
if ($w -gt $waW) { $w = $waW }
$pos = '${pos}'
$x = $r.L
if ($pos -eq 'center') { $x = $r.L + [int](($waW - $w)/2) }
elseif ($pos -eq 'right') { $x = $r.R - $w }
$y = $r.T
if ($hh -lt $waH) { $y = $r.T + [int](($waH - $hh)/2) }
if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, 9) }
[void][W]::MoveWindow($h, $x, $y, $w, $hh, $true)
Write-Output 'OK'
`
    );
  }

  return 'Write-Output "UNKNOWN_OP"';
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve('NOOP(not-windows)');
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {
        /* ignore */
      }
      resolve('TIMEOUT');
    }, 4000);
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('close', () => {
      clearTimeout(timer);
      resolve((out || err).trim() || 'OK');
    });
  });
}

// 打开(或聚焦)Edge 应用窗口
// 读取上次保存的位置(left/center/right),按 config.geometry 计算启动尺寸与坐标,
// 让窗口一出现就"上下填满 + 靠左/居中/靠右",减少先开小窗再移动的跳变。
function readUiPosition() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const p = s && s.ui && s.ui.position;
    return ['left', 'center', 'right'].includes(p) ? p : 'center';
  } catch {
    return 'center';
  }
}

// 返回主屏工作区 { waLeft, waTop, waW, waH }(不含任务栏)。失败返回 null。
function getScreenMetrics() {
  if (!IS_WIN) return null;
  try {
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms;' +
      '$s = [System.Windows.Forms.Screen]::PrimaryScreen;' +
      "Write-Output ('{0},{1},{2},{3}' -f $s.WorkingArea.Left, $s.WorkingArea.Top, $s.WorkingArea.Width, $s.WorkingArea.Height)";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
      timeout: 8000,
    })
      .toString()
      .trim();
    const m = out.match(/(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    const [, waLeft, waTop, waW, waH] = m.map(Number);
    return waW > 0 && waH > 0 ? { waLeft, waTop, waW, waH } : null;
  } catch {
    return null;
  }
}

function openEdgeWindow(port, cfg) {
  if (!IS_WIN) {
    console.log(`[QuickCopyNote] 非 Windows:请手动在浏览器打开 http://127.0.0.1:${port}`);
    return;
  }
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edge = edgeCandidates.find((p) => fs.existsSync(p)) || 'msedge';
  const profile = path.resolve(ROOT, cfg.edgeProfile || '.qcn/edge-profile');
  const url = `http://127.0.0.1:${port}/?token=${SESSION_TOKEN}`;
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // 启动几何:与 /move 相同的规则(height<=0 → 工作区高度+height,0=上下填满)
  const pos = readUiPosition();
  const geo = (cfg.geometry && (cfg.geometry[pos] || cfg.geometry.center)) || { width: 760, height: 0 };
  const scr = getScreenMetrics();
  let w = Number(geo.width) || 760;
  let h = geo.height === undefined || geo.height === null ? 0 : Number(geo.height);
  if (scr) {
    if (h <= 0) h = scr.waH + h;
    h = Math.max(200, Math.min(h, scr.waH));
    w = Math.min(w, scr.waW);
    let x = scr.waLeft;
    if (pos === 'center') x = scr.waLeft + Math.round((scr.waW - w) / 2);
    else if (pos === 'right') x = scr.waLeft + scr.waW - w;
    const y = scr.waTop + (h < scr.waH ? Math.round((scr.waH - h) / 2) : 0);
    args.push(`--window-size=${w},${h}`, `--window-position=${x},${y}`);
  } else {
    args.push(`--window-size=${w},${h > 0 ? h : 460}`);
  }

  try {
    const child = spawn(edge, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (e) {
    console.error('[QuickCopyNote] 打开 Edge 窗口失败:', e.message);
  }
}

// ---------- 开机自启(「启动」目录 .lnk,零注册表) ----------

function startupDir() {
  const appdata = process.env.APPDATA;
  if (!appdata) return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function autostartLnkPath() {
  return path.join(startupDir(), 'QuickCopyNote.lnk');
}
// 生成一个隐藏启动 node 的 vbs,供 .lnk 指向(避免登录时弹黑框)
function ensureHiddenVbs() {
  const vbs = path.join(RUNTIME, 'start-hidden.vbs');
  const nodeExe = process.execPath;
  const serverJs = path.join(ROOT, 'server.js');
  const content =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    'sh.CurrentDirectory = "' + ROOT.replace(/\\/g, '\\\\') + '"\r\n' +
    'sh.Run """" & "' + nodeExe.replace(/\\/g, '\\\\') + '" & "" """ & "' + serverJs.replace(/\\/g, '\\\\') + '" & """, 0, False\r\n';
  fs.writeFileSync(vbs, content, 'utf8');
  return vbs;
}
function isAutostartEnabled() {
  return IS_WIN && fs.existsSync(autostartLnkPath());
}
function setAutostart(on) {
  if (!IS_WIN) return false;
  const lnk = autostartLnkPath();
  try {
    if (!on) {
      fs.rmSync(lnk, { force: true });
      return true;
    }
    const vbs = ensureHiddenVbs();
    const ps =
      `$ws = New-Object -ComObject WScript.Shell;` +
      `$s = $ws.CreateShortcut('${lnk}');` +
      `$s.TargetPath = 'wscript.exe';` +
      `$s.Arguments = '"${vbs}"';` +
      `$s.WorkingDirectory = '${ROOT}';` +
      `$s.WindowStyle = 7;` +
      `$s.Description = 'QuickCopyNote';` +
      `$s.Save()`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    return fs.existsSync(lnk);
  } catch (e) {
    console.error('[QuickCopyNote] 设置开机自启失败:', e.message);
    return false;
  }
}

// ---------- 常驻热键监听 (Windows) ----------

let listenerChild = null;
function startListener(port, cfg) {
  if (!IS_WIN) return;
  const listenerJs = path.join(ROOT, 'listener.js');
  if (!fs.existsSync(listenerJs)) {
    console.error('[QuickCopyNote] 缺少 listener.js,跳过全局热键。');
    return;
  }
  try {
    listenerChild = spawn(process.execPath, [listenerJs], {
      env: {
        ...process.env,
        QCN_PORT: String(port),
        QCN_HOTKEY: cfg.hotkey || 'Ctrl+Alt+P',
        QCN_TOKEN: SESSION_TOKEN,
        QCN_TOPMOST: cfg.topmost ? '1' : '0',
      },
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    listenerChild.on('exit', (code) => {
      console.error(`[QuickCopyNote] 热键监听进程退出 (code ${code})。`);
      listenerChild = null;
    });
  } catch (e) {
    console.error('[QuickCopyNote] 启动热键监听失败:', e.message);
  }
}

// ---------- HTTP ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let CONFIG = loadConfig();
let BOUND_PORT = CONFIG.port || DEFAULT_PORT;

async function handle(req, res) {
  const u = new URL(req.url, `http://127.0.0.1:${BOUND_PORT}`);
  const p = u.pathname;
  const method = req.method;

  // 仅接受本机来源;简单防跨站:检查 Host 头
  const host = (req.headers.host || '').split(':')[0];
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    return sendJson(res, 403, { error: 'forbidden host' });
  }

  try {
    if (p === '/ping') {
      return sendJson(res, 200, { ok: true, port: BOUND_PORT, token: SESSION_TOKEN, pid: process.pid });
    }

    if (p === '/' || p === '/index.html' || p === '/quickcopynote.html') {
      if (!fs.existsSync(HTML_FILE)) return sendText(res, 500, 'quickcopynote.html 缺失');
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (p === '/api/state') {
      if (method === 'GET') {
        const state = readState();
        return sendJson(res, 200, state);
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        let next;
        try {
          next = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'invalid json' });
        }
        if (!next || !Array.isArray(next.groups)) {
          return sendJson(res, 400, { error: 'state must have groups[]' });
        }
        writeState(next);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (p === '/api/config') {
      if (method === 'GET') {
        // 不下发敏感项;附带运行时信息
        return sendJson(res, 200, {
          port: BOUND_PORT,
          hotkey: CONFIG.hotkey,
          topmost: CONFIG.topmost,
          geometry: CONFIG.geometry,
          token: SESSION_TOKEN,
          platform: process.platform,
        });
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        let patch;
        try {
          patch = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'invalid json' });
        }
        const allowed = ['hotkey', 'topmost', 'geometry'];
        for (const k of allowed) if (k in patch) CONFIG[k] = patch[k];
        saveConfig(CONFIG);
        return sendJson(res, 200, { ok: true, config: { hotkey: CONFIG.hotkey, topmost: CONFIG.topmost, geometry: CONFIG.geometry } });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ---- 开机自启 ----
    if (p === '/api/autostart') {
      if (method === 'GET') {
        return sendJson(res, 200, { enabled: isAutostartEnabled(), supported: IS_WIN });
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        let on = true;
        try { on = JSON.parse(raw).on !== false; } catch { on = true; }
        const ok = setAutostart(on);
        return sendJson(res, 200, { ok, enabled: isAutostartEnabled() });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ---- 窗口 IPC ----
    if (p === '/summon') {
      const r = await runPowerShell(buildWinPs('summon'));
      if (r === 'NOWINDOW') openEdgeWindow(BOUND_PORT, CONFIG);
      return sendJson(res, 200, { ok: true, result: r });
    }
    if (p === '/hide') {
      const r = await runPowerShell(buildWinPs('hide'));
      return sendJson(res, 200, { ok: true, result: r });
    }
    if (p === '/pin') {
      const on = u.searchParams.get('on') !== '0';
      CONFIG.topmost = on;
      saveConfig(CONFIG);
      const r = await runPowerShell(buildWinPs('pin', { on }));
      return sendJson(res, 200, { ok: true, on, result: r });
    }
    if (p === '/move') {
      const pos = u.searchParams.get('pos') || 'center';
      const g = (CONFIG.geometry && CONFIG.geometry[pos]) || CONFIG.geometry.center;
      const r = await runPowerShell(buildWinPs('move', { pos, width: g.width, height: g.height }));
      return sendJson(res, 200, { ok: true, pos, result: r });
    }
    if (p === '/open-window') {
      openEdgeWindow(BOUND_PORT, CONFIG);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
}

function tryListen(port, attempt) {
  const server = http.createServer((req, res) => handle(req, res));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < PORT_TRY_LIMIT) {
      console.warn(`[QuickCopyNote] 端口 ${port} 被占用,尝试 ${port + 1}`);
      server.close();
      tryListen(port + 1, attempt + 1);
    } else {
      console.error('[QuickCopyNote] 服务启动失败:', err.message);
      releaseLock();
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    BOUND_PORT = port;
    CONFIG.port = port;
    saveConfig(CONFIG);
    writeLock(port);
    fs.writeFileSync(
      DAEMON_FILE,
      JSON.stringify({ pid: process.pid, port, token: SESSION_TOKEN, startedAt: Date.now() }, null, 2)
    );
    console.log(`[QuickCopyNote] 服务已启动: http://127.0.0.1:${port}  (token ${SESSION_TOKEN})`);
    startListener(port, CONFIG);
    if (process.argv.includes('--open')) openEdgeWindow(port, CONFIG);
  });
  return server;
}

function main() {
  ensureDirs();

  // CLI 子命令:供 setup\开始使用.bat 复用同一套自启逻辑
  const argv = process.argv.slice(2);
  if (argv.includes('--autostart-on')) {
    const ok = setAutostart(true);
    console.log(ok ? 'AUTOSTART_ON_OK' : 'AUTOSTART_ON_FAIL');
    process.exit(ok ? 0 : 1);
  }
  if (argv.includes('--autostart-off')) {
    setAutostart(false);
    console.log('AUTOSTART_OFF_OK');
    process.exit(0);
  }
  if (argv.includes('--autostart-status')) {
    console.log(isAutostartEnabled() ? 'ENABLED' : 'DISABLED');
    process.exit(0);
  }

  if (!fs.existsSync(STATE_FILE)) {
    // 首次运行:放一个空但合法的 state,避免面板报错
    writeState({ version: 1, ui: { position: 'center', activeGroup: null, theme: 'dark', autostart: true }, groups: [] });
  }
  acquireLock();
  CONFIG = loadConfig();
  const server = tryListen(CONFIG.port || DEFAULT_PORT, 0);

  const shutdown = () => {
    try {
      if (listenerChild) listenerChild.kill();
    } catch {
      /* ignore */
    }
    releaseLock();
    try {
      server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', releaseLock);
}

main();
