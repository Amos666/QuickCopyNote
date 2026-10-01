# QuickCopyNote

一个类 CopyQ 的「常用命令 / 提示词模板」快速取用面板。
按全局热键呼出一个面板,里面按分组存着一条条可编辑的命令/提示词,选中回车即复制到剪贴板,粘到 OpenCode 或其他 Agent 直接用。

- **零安装**:只用系统自带的 Edge / Node / PowerShell,不装任何软件,不写注册表。
- **零依赖**:`server.js` 只用 Node 内置模块,无需 `npm install`。
- **数据是一个 JSON 文件**,可 git 管理、可换机迁移。

---

## 环境要求

- Windows 10 / 11
- 已安装 Node.js(任意较新版本,开发验证于 v26)
- Microsoft Edge(Windows 自带)

---

## 快速开始(三步)

```
1. 下载 / 解压本目录
2. 双击  setup\start.bat
3. 按    Ctrl+Alt+P
```

`start.bat` 会自动:检查 Node → 启动本地服务 → 打开 Edge 应用窗口 → 设置开机自启 → 自检并打印结果。
之后每次开机登录会自动拉起,**永远只需按 `Ctrl+Alt+P`**。

> 开机后的第一次按键约需 1~2 秒(冷启动服务),之后每次瞬发。

如果不想用 `.bat`,也可以手动:
```bat
node server.js --open
```

---

## 键位表

| 键 | 行为 |
|---|---|
| 直接打字 | 搜索(标题 / 内容 / 标签,命中高亮) |
| `↑` `↓` / `Ctrl+J` `Ctrl+K`(或 `Alt+J/K`) | 上下移动选中 |
| `j` `k`(焦点不在搜索框时) | vi 式上下移动选中(j=下,k=上) |
| `PgUp` `PgDn` | 翻页(±10) |
| `Alt+1`…`Alt+9` | 跳到第 N 条 |
| `Ctrl+Tab` / `Ctrl+1`…`Ctrl+9` | 切换分组 |
| `Enter` | 复制选中项并隐藏面板 |
| `Ctrl+C` | 复制但保持面板打开(连续取多条) |
| 鼠标单击行 | 复制该行 |
| 鼠标双击行 | 编辑该行 |
| `Ctrl+N` | 新增条目 |
| `Ctrl+E` | 编辑选中条目 |
| `Ctrl+D` | 复制一份选中条目 |
| `Delete` | 删除(带确认) |
| `Alt+↑` `Alt+↓` / `Ctrl+Shift+↑` `Ctrl+Shift+↓` | 调整顺序 |
| 鼠标拖拽行 | 调整顺序 |
| `Ctrl+I` / `Ctrl+O` | 导入 / 导出 JSON |
| `Esc` | 隐藏面板(编辑器打开时为取消) |
| 编辑器内 `Ctrl+Enter` | 保存 |

> 说明:纯数字键 `1-9` 归入“打字即搜索”,所以“跳到第 N 条”用 `Alt+数字`,避免冲突。
> 分组管理:顶部 `＋` 新增分组,右键分组标签重命名。

---

## 面板设置

- **位置**:右上角 `◧ ◫ ◨` 三个按钮切换 居左 / 居中 / 居右,立即生效并记住。窗口默认上下填满工作区(不遮任务栏),只在水平方向变化;下次打开自动按记住的位置出现。
- **置顶**:右上角 📌 按钮切换窗口是否常驻最前。
- **开机自启**:底部状态栏开关(等价于增删「启动」目录里的 `QuickCopyNote.lnk`)。
- **状态灯**:绿点=本地服务模式;黄点=降级模式(见下)。

---

## 数据存储

| 模式 | 数据位置 | 何时用 |
|---|---|---|
| 服务模式(默认) | `.qcn-data\snippets.json` | 通过 `http://127.0.0.1:7788` 打开面板时 |
| 降级模式 | 浏览器 `localStorage` | 直接双击 `quickcopynote.html`(以 `file://` 打开)时 |

- 服务模式每次保存:临时文件 + `fsync` + 原子替换,并在 `.qcn\snapshots\` 滚动保留最近 5 份快照;主文件损坏会自动从快照恢复。
- `.qcn-data\` 与程序文件分离,**升级覆盖程序不会动你的数据**。
- 两种模式数据互相独立,切换时用面板的导入 / 导出迁移一次。

数据结构:
```json
{
  "version": 1,
  "ui": { "position": "center", "activeGroup": "OpenCode", "theme": "dark", "autostart": true },
  "groups": [
    { "name": "OpenCode", "items": [
      { "id": "…", "title": "复查未提交改动", "text": "git diff …", "tags": ["review"], "createdAt": 0, "updatedAt": 0 }
    ]}
  ]
}
```

---

## 更新 / 卸载

- **更新**:下载新版覆盖程序文件(保留 `.qcn-data\`)→ 再双击一次 `setup\start.bat`(幂等)。
- **卸载**:`setup\uninstall.bat` —— 取消自启、停止后台服务、清理运行时,**保留数据**。彻底删除就手动删整个目录。

---

## 工作原理

```
登录 →「启动」目录 QuickCopyNote.lnk → wscript 隐藏启动 node server.js
                                          ├─ HTTP 服务(数据/静态/窗口IPC) 127.0.0.1:7788
                                          └─ 拉起 listener.js:Win32 RegisterHotKey 注册 Ctrl+Alt+P
按 Ctrl+Alt+P → listener 收到 WM_HOTKEY → 找到 Edge 应用窗口(按标题令牌)→ 显示+置顶 / 隐藏
```

- 常驻进程只有 1 个 node(内含热键监听子进程),热键高频路径全在该进程内完成,不额外 spawn,故瞬发。
- 面板窗口标题被设为 `QuickCopyNote·<随机令牌>`,供 Win32 `FindWindow` 精确识别,避免认错窗口。
- 单实例锁 `.qcn\daemon.lock`:重复启动会自动退出,不会开两份。

---

## 常见问题 / 兜底

详见 `setup\fallback-task-scheduler.md`,摘要:

| 现象 | 处理 |
|---|---|
| 按热键没反应 | 改 `config.json` 里的 `hotkey` 换一个组合;或看该文档第二节 |
| `.lnk` 自启被策略禁 | 用任务计划程序常驻(退路 A) |
| 禁止本地端口 / 禁 node | 双击 `quickcopynote.html` 走降级模式(退路 B) |
| Edge `--app` 被降级成带地址栏 | 不影响功能;也可改用 Chrome(退路 C) |
| `start.bat` 窗口一闪而过 | 脚本末尾已 `pause`;若仍闪退,改用 `cmd /k` 手动跑看报错 |

---

## 端口与配置

`config.json`:
```json
{
  "port": 7788,
  "hotkey": "Ctrl+Alt+P",
  "topmost": true,
  "edgeProfile": ".qcn/edge-profile",
  "geometry": {
    "center": { "width": 760, "height": 0 },
    "left":   { "width": 380, "height": 0 },
    "right":  { "width": 380, "height": 0 }
  }
}
```
- `port` 被占用时服务会自动顺延并回写此文件。
- `geometry` 里 `height` 为 `0` 表示上下填满工作区(屏幕高度减去任务栏);负数表示“工作区高度 + 该值”(如 `-120` = 留出 120px 边距);正数则为固定像素高度(垂直居中)。

---

## 目录结构

```
QuickCopyNote/
  quickcopynote.html     面板本体(单文件,零框架)
  server.js              零依赖本地服务:数据 + 静态 + 窗口 IPC + 自启 + 单实例锁
  listener.js            常驻全局热键监听(内联 C# RegisterHotKey)
  config.json            端口 / 热键 / 置顶 / 窗口几何
  setup/
    start.bat              一键安装启动(入口)
    uninstall.bat          卸载(保留数据)
    fallback-task-scheduler.md  热键/自启失效时的退路
  .qcn/                  运行时自动生成(锁、快照、隐藏启动 vbs、Edge profile),可删
  .qcn-data/
    snippets.json        你的数据(升级不覆盖)
  PLAN.md                设计方案
  README.md
```
