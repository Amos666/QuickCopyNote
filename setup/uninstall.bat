@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
set "ROOT=%CD%"

echo ============================================
echo   QuickCopyNote  卸载(保留数据)
echo ============================================
echo.

REM ---- 1. 取消开机自启 ----
echo [*] 移除开机自启 ...
where node >nul 2>nul
if errorlevel 1 goto :no_node
node "%ROOT%\server.js" --autostart-off
echo [OK] 已从「启动」目录移除 QuickCopyNote.lnk
goto :autostart_done

:no_node
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QuickCopyNote.lnk"
if exist "!LNK!" del /f /q "!LNK!" && echo [OK] 已删除启动项

:autostart_done
REM ---- 2. 停止正在运行的服务(只停我们记录的那个 pid)----
echo [*] 停止后台服务 ...
if not exist "%ROOT%\.qcn\daemon.json" goto :no_daemon
for /f "usebackq tokens=2 delims=:," %%a in (`findstr /c:"\"pid\"" "%ROOT%\.qcn\daemon.json"`) do call :kill_pid %%a
goto :daemon_done

:no_daemon
echo [i] 未发现运行中的服务记录。

:daemon_done
REM ---- 3. 清理运行时(不动数据)----
if exist "%ROOT%\.qcn" rd /s /q "%ROOT%\.qcn" 2>nul

echo.
echo 完成。你的数据仍保留在 .qcn-data\snippets.json。
echo 如需彻底删除,手动删除整个 QuickCopyNote 目录即可。
echo.
pause
endlocal
exit /b 0

:kill_pid
set "PIDV=%~1"
set "PIDV=!PIDV: =!"
if "!PIDV!"=="" exit /b 0
taskkill /pid !PIDV! /t /f >nul 2>nul
echo [OK] 已结束进程 pid !PIDV!
exit /b 0
