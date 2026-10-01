# 备用方案:全局热键不生效时

正常路径下,`server.js` 启动时会拉起 `listener.js`,由它用 Win32 `RegisterHotKey` 注册全局热键 `Ctrl+Alt+P`。
如果按热键没反应,先判断原因,再选对应退路。

## 一、先自检

1. 打开面板(浏览器访问 `http://127.0.0.1:7788/`)。
   - 能打开 → 服务和数据正常,问题只在“热键/窗口”这一层。
   - 打不开 → 是服务没起来(见第三节)。
2. 看面板底部状态灯:
   - 绿点“本地服务” → 服务在线。
   - 黄点“降级模式” → 页面是以 `file://` 双击打开的,没有服务,自然没有全局热键。

## 二、热键被占用 / 注册失败

`Ctrl+Alt+P` 可能被输入法、截图工具、显卡驱动等占用。改一个键:

1. 关闭正在运行的服务(跑 `setup\uninstall.bat`,或结束对应 node 进程)。
2. 编辑 `config.json`,把 `"hotkey": "Ctrl+Alt+P"` 改成例如 `"Ctrl+Alt+K"` 或 `"Ctrl+Shift+Space"`。
   - 支持的主键:`A-Z`、`0-9`、`F1-F24`;修饰键:`Ctrl` `Alt` `Shift` `Win`。
3. 重新跑 `setup\start.bat`。

> 判断是否注册成功:`listener.js` 注册失败会在其 stdout 打印 `REGISTER_FAILED:<错误码>`。
> 该进程由 server 以隐藏方式拉起,日志默认看不到;需要排查时可临时在命令行前台运行 `node server.js` 观察输出。

## 三、退路 A:任务计划程序常驻(不依赖 .lnk 自启)

如果「启动」目录 `.lnk` 被策略禁止,可改用任务计划程序在登录时拉起服务。
用**当前用户**权限即可,无需管理员:

```bat
schtasks /Create /TN "QuickCopyNote" /SC ONLOGON /RL LIMITED ^
  /TR "wscript.exe \"%~dp0..\.qcn\start-hidden.vbs\"" /F
```

说明:
- `.qcn\start-hidden.vbs` 由 `server.js` 在设置自启时生成;若不存在,先跑一次 `node server.js --autostart-on` 生成它,再执行上面的命令(即使 .lnk 创建失败,vbs 也已写好)。
- `/RL LIMITED` 表示普通权限,不触发 UAC。
- 删除该任务:`schtasks /Delete /TN "QuickCopyNote" /F`。

## 四、退路 B:完全不用全局热键(纯降级模式)

公司策略若同时禁止 node 常驻、本地端口监听、脚本执行:

1. 直接双击 `quickcopynote.html`,以 `file://` 打开。
2. 数据存在浏览器 `localStorage`,增删改查、搜索、复制、排序、导入导出全部可用。
3. 唤起方式改为:把这个页面固定为一个浏览器标签/应用窗口,用系统 `Alt+Tab` 或任务栏切换过去,在页面内用 `Ctrl+/` 之外的所有键位照常操作。
4. 换机器/换浏览器时,用面板里的“导入/导出 JSON”把 `snippets.json` 搬过去。

> 注意:降级模式(localStorage)与服务模式(`.qcn-data\snippets.json`)是两份独立数据,切换时用导入/导出迁移一次。

## 五、退路 C:不用 Edge 应用窗口

若 `msedge --app` 被 IT 策略降级成普通标签页(窗口带地址栏),功能不受影响,只是外观差一点。
也可改用 Chrome:把 `server.js` 里 `openEdgeWindow` 的可执行文件路径改成 Chrome 安装路径即可(同样支持 `--app`)。
