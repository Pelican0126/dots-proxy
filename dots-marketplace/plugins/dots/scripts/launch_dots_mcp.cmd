@echo off
setlocal
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
call :use_if_supported "%NODE_EXE%"
if not defined NODE_EXE set "NODE_EXE=%CODEX_MCP_NODE_PATH%"
call :use_if_supported "%NODE_EXE%"
if not defined NODE_EXE (
  echo dots: node runtime not found or Node is older than 22 1>&2
  exit /b 1
)
"%NODE_EXE%" "%~dp0..\server.mjs" %*
exit /b %errorlevel%

:use_if_supported
set "CANDIDATE=%~1"
if not defined CANDIDATE exit /b 0
set "MAJOR="
for /f "tokens=1 delims=." %%V in ('"%CANDIDATE%" --version 2^>nul') do set "MAJOR=%%V"
set "MAJOR=%MAJOR:v=%"
if not defined MAJOR exit /b 0
if %MAJOR% LSS 22 set "NODE_EXE="
exit /b 0
