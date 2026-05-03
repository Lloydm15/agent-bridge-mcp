@echo off
REM Mevoric runner launcher — runs node directly so the scheduled task tracks it.
REM No "start /B" — that would orphan the process and confuse the task scheduler.
cd /d "c:\dev\mcp-tools\mevoric"
"E:\Node.js\node.exe" runner.mjs >> "%LOCALAPPDATA%\agent-bridge\runner.log" 2>&1
