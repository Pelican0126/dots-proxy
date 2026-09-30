@echo off
setlocal
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0..\server.mjs" %*
) else (
  "%CODEX_MCP_NODE_PATH%" "%~dp0..\server.mjs" %*
)
