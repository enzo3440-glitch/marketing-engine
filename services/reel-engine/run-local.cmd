@echo off
rem Local Reel Engine on Windows: uses bin\ffmpeg.exe + bin\ffprobe.cmd (shim) when ffmpeg isn't installed.
rem Finished jobs in reel-data\output\ reload on start, so the Ops Desk gallery shows them.
rem REEL_TOKEN and AUTOPILOT_ROOTS (folders Autopilot may read) come from the repo .env.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%bin;%PATH%"
set "PYTHONPATH=%HERE%"
set "PYTHONIOENCODING=utf-8"
for /f "usebackq tokens=1,* delims==" %%a in ("%HERE%..\..\.env") do (
  if "%%a"=="REEL_TOKEN" if "%REEL_TOKEN%"=="" set "REEL_TOKEN=%%b"
  if "%%a"=="AUTOPILOT_ROOTS" set "AUTOPILOT_ROOTS=%%b"
)
cd /d "%HERE%"
python -m engine.server --root reel-data --host 127.0.0.1 --port 8787
