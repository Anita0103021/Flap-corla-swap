@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 is required. Install it and reopen this launcher.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<24 || typeof process.getBuiltinModule?.('node:sqlite')?.DatabaseSync!=='function')process.exit(1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer with node:sqlite is required.
  pause
  exit /b 1
)
if not exist "node_modules\ethers\package.json" (
  call npm.cmd ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node src/ui-server.mjs --open
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
