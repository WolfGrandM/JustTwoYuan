@echo off
setlocal
title Scan tunnel DIAGNOSTIC
set "KEY=%~dp0_deepseekharness.pem"
echo key in this folder:
if exist "%KEY%" (echo   YES) else (echo   NO - _deepseekharness.pem missing)
echo.
echo === port 8099 before ===
netstat -ano | findstr /C:"127.0.0.1:8099"
echo.
echo === ssh once (verbose off) ===
ssh -i "%KEY%" -o StrictHostKeyChecking=no -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L 8099:127.0.0.1:8099 -L 6099:127.0.0.1:6099 root@120.55.184.195
echo === ssh exit code: %ERRORLEVEL% ===
echo Read the lines above. This window will wait.
pause
