@echo off
rem Claude Sidekick 卸载（双击运行）：删除注册表项和生成的文件
cd /d "%~dp0"
node uninstall.js
echo.
pause
