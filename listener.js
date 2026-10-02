#!/usr/bin/env node
'use strict';

/*
 * QuickCopyNote — 常驻全局热键监听 (仅 Windows)
 *
 * 由 server.js 拉起。它 spawn 一个隐藏的 powershell 子进程,内部用 Add-Type 编译一小段 C#:
 *   - RegisterHotKey 注册全局热键
 *   - GetMessage 消息循环接收 WM_HOTKEY
 *   - 命中时按标题令牌找到 Edge 应用窗口:当前可见且在前台→SW_HIDE 收起(任务栏按钮同步消失);否则→显示+置顶+前台抢焦点
 *   - 唤起不靠 SetForegroundWindow(会被前台锁拒绝,窗口又属于 Edge 跨进程),
 *     而是 SwitchToThisWindow + AttachThreadInput + SWP_SHOWWINDOW + 最小化/还原兜底多重奏,
 *     因此即使先前是 SW_HIDE 隐藏,也能重新拿到前台与键盘焦点。
 *   - 窗口不存在→回调本机 /open-window 让 server.js 打开 Edge
 *
 * 热键这条高频路径全程在这个常驻进程内完成,不 spawn 新进程,故响应最快。
 * 环境变量:QCN_PORT / QCN_HOTKEY / QCN_TOKEN / QCN_TOPMOST
 */

const { spawn } = require('node:child_process');

const PORT = process.env.QCN_PORT || '7788';
const HOTKEY = process.env.QCN_HOTKEY || 'Ctrl+Alt+P';
const TOKEN = process.env.QCN_TOKEN || '0000';
const TOPMOST = process.env.QCN_TOPMOST === '1';

if (process.platform !== 'win32') {
  // 非 Windows:什么都不做,让 server.js 继续跑数据层(便于跨平台自测)
  setInterval(() => {}, 1 << 30);
  return;
}

const MOD = { ctrl: 0x0002, alt: 0x0001, shift: 0x0004, win: 0x0008 };

function parseHotkey(str) {
  const parts = String(str)
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  let mods = 0;
  let key = null;
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'ctrl' || p === 'control') mods |= MOD.ctrl;
    else if (p === 'alt') mods |= MOD.alt;
    else if (p === 'shift') mods |= MOD.shift;
    else if (p === 'win' || p === 'windows') mods |= MOD.win;
    else key = raw;
  }
  if (!key) throw new Error('热键缺少主键: ' + str);
  let vk;
  if (/^[a-z]$/i.test(key)) vk = key.toUpperCase().charCodeAt(0); // A-Z => 0x41-0x5A
  else if (/^[0-9]$/.test(key)) vk = key.charCodeAt(0); // 0-9 => 0x30-0x39
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) vk = 0x70 + (parseInt(key.slice(1), 10) - 1);
  else throw new Error('暂不支持的主键: ' + key);
  if (mods === 0) mods = MOD.ctrl; // 无修饰键容易误触,兜底加 Ctrl
  return { mods, vk };
}

let mods, vk;
try {
  ({ mods, vk } = parseHotkey(HOTKEY));
} catch (e) {
  console.error('[listener] 热键解析失败:', e.message);
  process.exit(1);
}

const title = `QuickCopyNote\u00b7${TOKEN}`;
const baseUrl = `http://127.0.0.1:${PORT}`;

// 整段逻辑放进一个 C# 类,PowerShell 只负责编译并调用 Run()。
const cs = `
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;

public static class QcnHotkey {
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd; public uint message; public IntPtr wParam;
    public IntPtr lParam; public uint time; public POINT pt;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x; public int y; }

  [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  const uint WM_HOTKEY = 0x0312;
  const int SW_HIDE = 0, SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;

  // 把隐藏/最小化的窗口显示出来并真正抢到前台+键盘焦点。
  // 关键:面板窗口属于 Edge(另一个进程),SetForegroundWindow 会被系统前台锁拒绝。
  // 可靠做法:SwitchToThisWindow(系统资源管理器用的 API,允许后台进程前置窗口)
  //          + 把"目标窗口所在线程"附加到当前前台线程(不是把本进程线程附加)
  //          + 最小化→还原兜底 + 校验后重试。
  static void ShowAndFocus(IntPtr h) {
    // 统一 SW_RESTORE:对被 SW_HIDE 的 Edge 应用窗口,SW_SHOW(5) 会被忽略,
    // SW_RESTORE(9) 对隐藏/最小化两种状态都有效(实测)。
    ShowWindow(h, SW_RESTORE);
    uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;
    if (_topmost) SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, flags);
    else SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, flags);

    // 关键:被 SW_HIDE 的窗口通常仍是 GetForegroundWindow(假前台,visible=False, fore=True)。
    // 此时 SetForegroundWindow(h) 是 no-op,WM_ACTIVATE 不会派发,渲染进程永远拿不到键盘焦点。
    // 必须先 SW_MINIMIZE 让系统把前台真正交给别的窗口,再在 AttachThreadInput 作用域内
    // SW_RESTORE + 抢前台,强制走一次完整的"失活→激活"周期,焦点才会落到页面。
    ShowWindow(h, SW_MINIMIZE);
    Thread.Sleep(50);

    uint tMe = GetCurrentThreadId();
    for (int i = 0; i < 8; i++) {
      IntPtr fg = GetForegroundWindow();
      uint tFg = GetWindowThreadProcessId(fg, IntPtr.Zero);
      uint tTg = GetWindowThreadProcessId(h, IntPtr.Zero);
      bool a1 = tFg != 0 && tFg != tMe && AttachThreadInput(tMe, tFg, true);
      bool a2 = tFg != 0 && tFg != tTg && AttachThreadInput(tTg, tFg, true);
      try {
        ShowWindow(h, SW_RESTORE);
        if (_topmost) SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, flags);
        else SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, flags);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        SetActiveWindow(h);
        SetFocus(h);
        SwitchToThisWindow(h, true);
      } finally {
        if (a2) AttachThreadInput(tTg, tFg, false);
        if (a1) AttachThreadInput(tMe, tFg, false);
      }

      Thread.Sleep(40);
      if (GetForegroundWindow() == h) break;
    }
  }

  static string _title; static string _baseUrl; static bool _topmost;

  public static int Run(int mods, int vk, string title, string baseUrl, bool topmost) {
    _title = title; _baseUrl = baseUrl; _topmost = topmost;
    bool ok = RegisterHotKey(IntPtr.Zero, 0xB001, (uint)mods, (uint)vk);
    if (!ok) { Console.WriteLine("REGISTER_FAILED:" + Marshal.GetLastWin32Error()); return 2; }
    Console.WriteLine("REGISTERED");
    MSG msg;
    int ret;
    while ((ret = GetMessageWrapper(out msg)) > 0) {
      if (msg.message == WM_HOTKEY) Toggle();
    }
    UnregisterHotKey(IntPtr.Zero, 0xB001);
    return 0;
  }

  // 用 out 参数包一层,避免 PowerShell 直接处理 out
  static int GetMessageWrapper(out MSG m) { MSG local; int r = GetMessage(out local, IntPtr.Zero, 0, 0) ? 1 : 0; m = local; return r; }

  static void Toggle() {
    IntPtr h = FindWindowW("Chrome_WidgetWin_1", _title);
    if (h == IntPtr.Zero) { Open(); return; }
    // 收起用 SW_HIDE:任务栏按钮同步消失(用户要求"状态栏同步隐藏")。
    // 焦点风险在唤起侧解决:ShowAndFocus 用 SwitchToThisWindow(资源管理器同款,
    // 允许后台进程前置窗口)+ 附加输入线程 + SWP_SHOWWINDOW + 最小化/还原兜底,
    // 从 SW_HIDE 恢复同样能拿到前台与键盘焦点。
    bool iconic = IsIconic(h);
    bool visible = IsWindowVisible(h) && !iconic;
    bool isFore = GetForegroundWindow() == h;
    if (visible && isFore) {
      ShowWindow(h, SW_HIDE);
    } else {
      ShowAndFocus(h);
    }
  }

  static void Open() {
    try {
      using (var wc = new WebClient()) { wc.DownloadString(_baseUrl + "/open-window"); }
    } catch {}
    // Edge 冷启动需要时间,最多等 ~5 秒,窗口一出现就前置抢焦点
    for (int i = 0; i < 50; i++) {
      Thread.Sleep(100);
      IntPtr h = FindWindowW("Chrome_WidgetWin_1", _title);
      if (h != IntPtr.Zero) {
        ShowAndFocus(h);
        return;
      }
    }
  }
}
`;

const ps = `
$ErrorActionPreference='Stop'
try {
  Add-Type -TypeDefinition @'
${cs}
'@ -Language CSharp
  [QcnHotkey]::Run(${mods}, ${vk}, '${title}', '${baseUrl}', ${TOPMOST ? '$true' : '$false'})
} catch {
  Write-Error $_.Exception.Message
}
`;

const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
);

child.stdout.on('data', (d) => {
  const s = d.toString().trim();
  if (s) console.log('[listener]', s);
  if (s.startsWith('REGISTER_FAILED')) {
    console.error('[listener] 全局热键注册失败,可能被占用。参见 README 的备用方案。');
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) console.error('[listener:err]', s);
});
child.on('exit', (code) => {
  console.error(`[listener] 热键进程退出 (code ${code})`);
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
process.on('SIGTERM', () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
