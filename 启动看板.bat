@echo off
rem Options PCR Dashboard - start local server and open browser
setlocal
cd /d "%~dp0"
title Options PCR Dashboard
where pythonw.exe >nul 2>nul
if errorlevel 1 (
  start "" py -3 serve.py
  if errorlevel 1 start "" python serve.py
) else (
  start "" pythonw.exe serve.py
)
echo.
echo Dashboard: http://127.0.0.1:8788/
echo First run may take several minutes to fetch data.
echo Use ?mock=1 in the URL for a demo without network.
timeout /t 4 >nul
