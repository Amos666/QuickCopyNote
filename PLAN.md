# QuickCopyNote — 实现方案(定稿)

> 一个类 CopyQ 的「常用命令 / 提示词模板」快速取用面板。
> 目标环境:Windows 11,公司机器不能装软件,只能从 GitHub 下源码直接跑。
> 已确认:办公机装了 Node、无 AutoHotkey/PowerToys 类热键工具、接受登录即常驻。

---

## 0. 一句话架构

登录时由「启动」目录的 `.lnk` 自动拉起一个常驻监听进程(注册全局热键 `Ctrl+Alt+P`);
按键即唤起一个 Edge 应用窗口(置顶、位置可设),窗口里是零框架的深色 HTML 面板;
数据存磁盘单一 JSON 文件,由零依赖 Node 服务读写。

- 常驻进程:**1 个**(node,内含热键监听 + HTTP 服务)
- Windows 侧额外常驻:**0**(热键只由这一个进程接,无双触发)
- 关机进程消失,下次登录自动恢复
- 需要装的软件:**0**(Edge / Node / PowerShell / wscript 全部已有)
- 写注册表:**否**(自启用「启动」目录 `.lnk`,删掉即还原)

---

## 1. 文件结构

```
QuickCopyNote/
  quickcopynote.html     面板本体(单文件,CSS+JS 内联,零框架零依赖)
  server.js              Node 零依赖服务:数据 /api/state + 静态页 + 窗口 IPC + /ping
  listener.js            常驻热键监听(内联 C# RegisterHotKey)+ 单实例锁
                         (实现时可把 server 与 listener 合并为同一 node 进程)
  config.json            端口 / 快捷键 / 窗口位置 / 几何 —— 单一来源,禁止硬编码
  setup/
    开始使用.bat          唯一入口:建启动 .lnk + 起监听 + 注册热键 + 开面板 + 自检(末尾 pause)
    uninstall.bat        删 .lnk、停监听、保留数据
    fallback-task-scheduler.md   .lnk 自启失效时的 schtasks 备用路径
  .qcn/                  运行时自动生成,不进 git:daemon.lock、窗口 session token、快照
  .qcn-data/
    snippets.json        用户数据,独立目录,升级永不覆盖
  README.md
```

---

## 2. 唤起链路(方案一:登录即常驻,无竞态)

```
[开机登录]
  └─ 「启动」目录 QuickCopyNote.lnk  →  隐藏启动 listener(server)
        └─ 单实例锁 daemon.lock:抢不到就退出(防重复拉起)
        └─ 注册全局热键 Ctrl+Alt+P(内联 C# Win32 RegisterHotKey)
        └─ 写 daemon.json(pid/port/启动时间)

[按 Ctrl+Alt+P]
  └─ listener 收到 WM_HOTKEY
        ├─ 窗口已存在 → SetForegroundWindow + 置顶 + 按需复位位置/尺寸  (瞬发)
        └─ 窗口不存在 → msedge --app=http://127.0.0.1:PORT (带独立 --user-data-dir)
```

热键只由常驻 listener 一人接管;`.lnk` 只负责登录自启,不参与按键 → 无心跳仲裁、无双触发。

---

## 3. Node 服务 `server.js`(零依赖,只用 node:http / node:fs)

**数据**
- `GET  /api/state` → 返回 `snippets.json` 全量
- `POST /api/state` → 原子写:临时文件 + `fsync` + `rename`;写前滚动保留最近 5 份快照到 `.qcn/`;解析失败自动退回上一版
- `GET  /api/config` / `POST /api/config` → 读写 `config.json`(端口、快捷键、窗口位置/几何)

**窗口 IPC**(收到请求后,由已运行的 node 进程内 spawn 一次性 `powershell -Command "<内联C#>"` 执行 Win32;`-Command` 绕过脚本文件的 ExecutionPolicy)
- `GET /summon` → 显示 + 置顶(`HWND_TOPMOST`)+ 复位到 config 记录的位置/尺寸
- `GET /hide`   → 真最小化(`SW_MINIMIZE`)
- `GET /move?pos=center|left|right` → `SetWindowPos` 移动到对应落位
- `GET /pin?on=1|0` → 切换是否常驻置顶
- `GET /ping`   → 健康检查(供 .bat 自检、供页面判断在线)

**静态**
- `/` → 伺服 `quickcopynote.html`;面板永远以 `http://127.0.0.1:PORT` 打开,
  规避 `file://` 的混合内容限制与企业策略,`fetch`/剪贴板 API 全部合法

**网络**
- 仅绑 `127.0.0.1`;默认端口 `7788`;被占用则自动顺延并回写 `config.json`

**窗口识别**:开窗时给页面标题注入随机 session token(如 `QuickCopyNote·a3f9`),
`FindWindow` 按「标题前缀 + token + 窗口类名」匹配,避免认错窗口 / 多开撞车。

---

## 4. 面板 `quickcopynote.html`(功能首版收敛)

**保留**:分组 Tab(按目标 Agent)、模糊搜索(标题+正文+标签,命中片段高亮)、
居中/居左/居右三位置面板内切换、深色主题、开机自启开关、导入导出。

**已砍(留待 v2)**:靠边常驻窄条形态、浅色/高对比主题、`useCount` 自动置顶与热度条、
`Shift+Enter` 压单行、变量占位符 `{{}}`、File System Access API 分支
(文件读写一律走 `/api/state`;`file://` 降级模式只用 localStorage)。

### 键位

| 键 | 行为 |
|---|---|
| 直接打字 | 搜索 |
| `↑ ↓` / `Ctrl+J/K` | 上下移动 |
| `PgUp` / `PgDn` | 翻页 |
| `1`–`9` | 直跳前九条 |
| `Ctrl+Tab` / `Ctrl+1..9` | 切分组 |
| `Enter` | 复制并关闭面板 |
| `Ctrl+C` | 复制但面板留着(连续取多条) |
| 鼠标点击行 | 复制(浏览器策略下的兜底,用户手势永远合法) |
| `Ctrl+N` | 新增(多行编辑 + 实时预览) |
| `Ctrl+E` | 编辑当前条 |
| `Ctrl+D` | 复制一份当前条 |
| `Delete` | 删除(带一次确认) |
| `Ctrl+Shift+↑ ↓` | 调整顺序 |
| 鼠标拖拽行 | 调整顺序 |
| `Ctrl+I` / `Ctrl+O` | 导入 / 导出 JSON |
| `Esc` | 关闭(隐藏窗口) |

### 面板内位置设置(本次新增)
- 面板右上角一个位置控件(居左 / 居中 / 居右 三态)
- 选择 → `POST /api/config {position}` 写盘 → `GET /move?pos=...` 立即移动窗口,无需重开
- 三种落位:
  - 居中:屏幕正中,默认 760×460
  - 居左:贴左边缘,垂直居中,380×(屏高-120)
  - 居右:贴右边缘,垂直居中,380×(屏高-120)
- 靠左/右时列表列自动收窄,预览区折叠为悬浮
- 位置、尺寸记进 `config.json`,下次唤起沿用;拖拽边缘改尺寸也回写

### 开机自启开关
- 状态条一个小 toggle:开 = 写「启动」目录 `.lnk`,关 = 删除
- 用户可完全在面板内控制,不必碰命令行

### URL 接口(供热键桥 / 外部程序)
- `?copy=<id>` 直接复制某条 · `?new=&text=` 预填新增 · `?group=<name>` 打开指定分组

### 降级模式
- 以 `file://` 打开且探不到服务(`/ping` 失败)时:自动切 `localStorage`,
  状态条显示「本地降级模式 · 点此连接服务」按钮(用户手势内 `window.open` 到 `http://127.0.0.1:PORT`)
- **诚实标注**:降级模式与 Node 模式数据不通,切换需手动导入导出一次(README 明说)

---

## 5. UI 规格 — Quiet Ink(深色)

| 项 | 规格 |
|---|---|
| 底色 | 三层高度:`#0E1114` 面板底 / `#15191D` 列表项 / `#1B2126` 选中与输入区;边框 `#252C33` 1px |
| 强调色 | 低饱和蓝绿 `#4FD1C5`;危险 `#F0736C`(仅确认态出现) |
| 文字 | 正文 `#D6DCE2` / 次要 `#8B97A3` / 禁用 `#5A646E` |
| 字体 | 等宽优先 `Cascadia Code` `Consolas` `JetBrains Mono`,中文回落 `Microsoft YaHei UI`;正文 13px / 行高 1.5 / 字距 0.01em |
| 圆角阴影 | 面板 12px、行 8px、徽标 4px;`0 24px 60px -12px rgba(0,0,0,.65)` |
| 毛玻璃 | 居中态 `backdrop-filter: blur(20px)` + 半透明底 |
| 布局 | 顶部:分组 Tab(下划线式)+ 搜索行(带 kbd 提示);左:列表 32px 紧凑行(左序号徽标);右:预览区看全文;底部 24px 状态条(键位图例 + 服务状态灯 + 自启开关) |
| 动效 | 行 hover `translateX(2px)` 120ms ease-out;选中交叉淡入 100ms;复制成功 toast 底部上滑淡出 1.2s;编辑面板展开 160ms |
| 语法着色 | 弱化:命令首词(git/curl/npm/docker/node)强调色,`#` 注释降次要色;不做完整高亮 |
| 长内容 | 行内首行 + `⋯` 截断,预览区看全文 |
| 空态 | 3 条示例 + 一句「按 Ctrl+N 加你的第一条」,不做引导弹窗 |
| 可访问性 | 焦点环 2px 强调色;对比度 ≥ 4.5:1;序号不只靠颜色区分 |

窗口几何默认居中 760×460,可面板内切三位置并拖拽改尺寸。

---

## 6. 数据结构(`.qcn-data/snippets.json`)

```json
{
  "version": 1,
  "ui": {
    "position": "center",
    "width": 760,
    "height": 460,
    "activeGroup": "OpenCode",
    "theme": "dark",
    "autostart": true
  },
  "groups": [
    {
      "name": "OpenCode",
      "items": [
        {
          "id": "唯一短id",
          "title": "复查未提交改动",
          "text": "git diff 看当前改动,指出潜在 bug 和遗漏的测试",
          "tags": ["review", "daily"],
          "createdAt": 0,
          "updatedAt": 0
        }
      ]
    }
  ]
}
```

约定:UI 偏好(position/theme/activeGroup/autostart)存 `snippets.json` 的 `ui`;
端口 / 快捷键 / 窗口绝对几何存 `config.json`。两处不重叠,避免打架。

`config.json` 示例:
```json
{ "port": 7788, "hotkey": "Ctrl+Alt+P", "topmost": true,
  "geometry": { "center": [760,460], "left": [380,null], "right": [380,null] } }
```

---

## 7. 安装 / 使用 / 更新 / 卸载

**首次(用户视角,只需一次双击 + 一次按键)**
```
下载解压  →  双击 setup\开始使用.bat  →  按一次 Ctrl+Alt+P 完成热键绑定
```
`开始使用.bat` 幂等,做:检测 node → 起监听 → 建启动 .lnk → 注册热键 → 开面板 → 自检打印结论。
末尾 `pause`,任何错误停在屏幕不闪退。

**之后**:每次开机登录自动拉起,永远只按 `Ctrl+Alt+P`。

**更新**:解压新版覆盖程序文件(`.qcn-data/` 数据独立,不被覆盖)→ 再双击一次 `开始使用.bat`。

**卸载**:`setup\uninstall.bat` 删 `.lnk`、停监听、**保留数据**。

---

## 8. 已知风险与兜底

| 风险 | 兜底 |
|---|---|
| Win11 `.lnk` 快捷键框灰掉 | 方案一热键由 listener 注册,不靠 .lnk 绑热键;.lnk 仅用于登录自启,失效则走 `fallback-task-scheduler.md`(schtasks 常驻跑 node) |
| AppLocker 拦 node.exe | `file://` 双击开面板 → localStorage 降级(数据需手动导一次) |
| EDR/HIPS 禁本地端口 bind | `.bat` 自检显式测 bind,失败即提示「请用降级模式」,不留白屏 |
| `msedge --app` 被降级/带边框 | 带独立 `--user-data-dir`;边框不影响功能 |
| node 不在 PATH / bat 报错 | `.bat` 检测并 `pause` |
| 端口 7788 被占 | 单一来源 config.json,冲突自动顺延回写 |
| PowerShell ExecutionPolicy 限制 | 窗口操作用 `powershell -Command "<内联>"` 绕过脚本文件策略 |
| Add-Type 编译 C# 首次开销 | 常驻 listener 启动时一次性注册,不在按键路径上 |

---

## 9. 实现顺序(建议)

1. `.qcn-data/snippets.json` — 示例数据(含 OpenCode 分组 3–5 条)
2. `quickcopynote.html` — 面板全功能(此时用浏览器直开即可先用起来)
3. `server.js` — 数据 + 静态 + 窗口 IPC + /ping
4. `listener.js` — 热键监听 + 单实例锁
5. `setup/开始使用.bat` + `uninstall.bat` + `fallback-task-scheduler.md`
6. `README.md`

---

## 10. 跨平台开发说明(重要)

- 本方案的**代码在 Linux 上生成**(纯文本文件,无需 Windows)。
- 只有以下 Windows 专属行为**必须在 Win PC 上验证**:
  - `RegisterHotKey` 全局热键是否生效
  - `msedge --app` 窗口形态 / 置顶 / 三位置移动
  - `.lnk` 登录自启 / `uninstall`
  - Win32 `SetWindowPos`、单实例锁
- 纯前端(HTML/CSS/JS)与数据层(server.js 的 /api/state、snippets.json 读写)可在 Linux 上用本地 node 直接自测。
- `.ps1` / 内联 C# 按 **Windows PowerShell 5.1** 语法写(避开 7-only 特性),行尾 **CRLF**。
