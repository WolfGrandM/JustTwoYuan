@echo off
chcp 65001 >nul
title dsh 隧道（关掉窗口 = 断开，异常会自动重连）
:loop
echo [%date% %time%] 连接中 ...
ssh -i "%~dp0_deepseekharness.pem" -o StrictHostKeyChecking=no -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -L 3080:127.0.0.1:3080 -L 6099:127.0.0.1:6099 -L 8099:127.0.0.1:8099 root@120.55.184.195
echo [%date% %time%] 断开了，5 秒后自动重连（关窗口可停止）
ping -n 6 127.0.0.1 >nul
goto loop
