@echo off
setlocal DisableDelayedExpansion
if /i "%~1"=="--background" goto background
start "" "%SystemRoot%\System32\wscript.exe" //nologo "%~dp0Start-Corla-UI.wsf"
exit /b %errorlevel%

:background
cd /d "%~dp0" || exit /b 1
if not exist "state\" md "state" 2>nul
if not exist "state\" exit /b 1
where node.exe >nul 2>nul
if errorlevel 1 (
  >>"state\ui-start.log" echo Node.js 24 is required. Install it and reopen the launcher.
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<24 || typeof process.getBuiltinModule?.('node:sqlite')?.DatabaseSync!=='function')process.exit(1)" >nul 2>nul
if errorlevel 1 (
  >>"state\ui-start.log" echo Node.js 24 or newer with node:sqlite is required.
  exit /b 1
)
if not exist "node_modules\ethers\package.json" (
  call npm.cmd ci >>"state\ui-start.log" 2>&1
  if errorlevel 1 exit /b 1
)
node src/ui-server.mjs --open >nul 2>&1
exit /b %errorlevel%
