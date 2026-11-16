@echo off
setlocal
title Scan tunnel 8099/6099
rem forward only 8099 (QR page) and 6099 (NapCat WebUI); does not touch 3080
set "KEY=%~dp0_deepseekharness.pem"
if not exist "%KEY%" ( echo [FATAL] key not found: %KEY% & pause & exit /b 1 )
:loop
echo [%date% %time%] connecting ...
ssh -i "%KEY%" -o StrictHostKeyChecking=no -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -L 8099:127.0.0.1:8099 -L 6099:127.0.0.1:6099 root@120.55.184.195
set RC=%ERRORLEVEL%
echo [%date% %time%] ssh exited rc=%RC%, retry in 5s (close window to stop)
ping -n 6 127.0.0.1 >nul
goto loop
