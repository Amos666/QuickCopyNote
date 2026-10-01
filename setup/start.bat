@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
set "ROOT=%CD%"

echo ============================================
echo   QuickCopyNote  安装 / 启动
echo ============================================
echo.

REM ---- 1. 检查 node ----
where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
echo [OK] Node.js !NODEVER!
goto :node_ok

:no_node
echo [X] 未找到 node。请确认已安装 Node.js 且已加入 PATH。
echo     退路:直接双击 quickcopynote.html,以“降级模式”(localStorage)使用。
echo.
pause
exit /b 1

:node_ok
REM ---- 2. 启动服务(最小化窗口,含 --open 自动打开 Edge 应用窗口)----
echo [*] 启动本地服务 ...
start "QuickCopyNote-server" /min cmd /c "node "%ROOT%\server.js" --open"

REM ---- 3. 等待就绪并自检 ----
echo [*] 等待服务就绪 ...
set "PORT="
for /l %%i in (1,1,20) do (
  if not defined PORT (
    timeout /t 1 /nobreak >nul
    if exist "%ROOT%\.qcn\daemon.json" (
      for /f "usebackq tokens=2 delims=:," %%a in (`findstr /c:"\"port\"" "%ROOT%\.qcn\daemon.json"`) do (
        set "P=%%a"
        set "P=!P: =!"
        if not "!P!"=="" set "PORT=!P!"
      )
    )
  )
)
if not defined PORT set "PORT=7788"

powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/ping' -TimeoutSec 3; Write-Host ('[OK] 服务在线, 端口 ' + $r.port) } catch { Write-Host '[X] 无法连接服务(http://127.0.0.1:%PORT%)。若公司策略禁止本地监听,请改用降级模式:双击 quickcopynote.html' }"

REM ---- 4. 注册开机自启(「启动」目录 .lnk,不写注册表)----
echo [*] 设置开机自启 ...
node "%ROOT%\server.js" --autostart-on
if errorlevel 1 goto :autostart_fail
echo [OK] 已加入开机自启(可在面板底部“开机自启”开关里取消)
goto :autostart_done

:autostart_fail
echo [!] 开机自启设置失败(可能策略限制)。不影响本次使用,下次开机后手动再跑一次本脚本即可。

:autostart_done
echo.
echo ============================================
echo   完成!
echo   - Edge 应用窗口应已打开;若没有,浏览器访问:
echo       http://127.0.0.1:%PORT%/
echo   - 全局热键: Ctrl+Alt+P  (呼出 / 隐藏面板)
echo       首次开机后第一按约需 1~2 秒拉起服务,之后瞬发。
echo   - 若热键无反应,见 setup\fallback-task-scheduler.md
echo ============================================
echo.
pause
endlocal
