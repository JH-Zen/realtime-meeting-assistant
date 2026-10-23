@echo off
chcp 65001 >nul
setlocal
set "QODER_TASK_DIR=%~1"
if not defined QODER_TASK_DIR set "QODER_TASK_DIR=D:\AI Workspace\Qoder Tasks\实时会议助手\index-recovery-preview6"
set "QODER_CLI_PATH=%USERPROFILE%\.qoder\bin\qodercli\qodercli.exe"
if not exist "%QODER_CLI_PATH%" (
  echo Qoder CLI is missing.
  exit /b 1
)
if not exist "%QODER_TASK_DIR%\TASK.md" (
  echo Prepared task directory is missing.
  exit /b 1
)
if not exist "%QODER_TASK_DIR%\task-manifest.json" (
  echo Task manifest is missing.
  exit /b 1
)
if exist "%QODER_TASK_DIR%\.env" (
  echo Use an independent task copy without .env.
  exit /b 1
)
if exist "%QODER_TASK_DIR%\.git" (
  echo Use an independent task copy without .git.
  exit /b 1
)
rem Color settings affect this CMD session and its Qoder child only.
set "NO_COLOR="
set "NODE_DISABLE_COLORS="
set "FORCE_COLOR=1"
set "CLICOLOR=1"
set "CLICOLOR_FORCE=1"
set "TERM=xterm-256color"
set "COLORTERM=truecolor"
set "CI="
title Qoder - DeepSeek-Flash - CMD
cd /d "%QODER_TASK_DIR%"
if errorlevel 1 exit /b 1
echo Model: DeepSeek-Flash - built-in platform model
echo Context: 1M tokens - reasoning effort: max
echo Task: %QODER_TASK_DIR%
echo Interactive CMD session - color enabled
if not exist "%QODER_TASK_DIR%\qoder-empty-mcp.json" >"%QODER_TASK_DIR%\qoder-empty-mcp.json" echo {"mcpServers":{}}
if /i "%~2"=="--run-task" (
  "%QODER_CLI_PATH%" --cwd "%QODER_TASK_DIR%" --model DeepSeek-Flash --context-window 1000000 --reasoning-effort max --permission-mode accept_edits --tools Read Edit Write Glob Grep --allowed-tools Read,Edit,Write,Glob,Grep --strict-mcp-config --mcp-config "%QODER_TASK_DIR%\qoder-empty-mcp.json" --prompt-interactive "Read TASK.md and execute only its allowed task files. First create your agent-record.md, then write the requested tests and update your record. Do not run commands or modify production code."
  exit /b
)
"%QODER_CLI_PATH%" --cwd "%QODER_TASK_DIR%" --model DeepSeek-Flash --context-window 1000000 --reasoning-effort max --permission-mode accept_edits --tools Read Edit Write Glob Grep --allowed-tools Read,Edit,Write,Glob,Grep --strict-mcp-config --mcp-config "%QODER_TASK_DIR%\qoder-empty-mcp.json"
exit /b %errorlevel%
