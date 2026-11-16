@echo off
chcp 65001 >nul
title 扫码通道（8099 二维码 / 6099 NapCat）
rem 只转发扫码相关端口，不动 3080（面板隧道由计划任务 dsh-tunnel 负责），不会抢端口
:loop
echo [%date% %time%] 连接中 ...
ssh -i "%~dp0_deepseekharness.pem" -o StrictHostKeyChecking=no -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -L 8099:127.0.0.1:8099 -L 6099:127.0.0.1:6099 root@120.55.184.195
echo [%date% %time%] 断开了，5 秒后自动重连（关窗口可停）
ping -n 6 127.0.0.1 >nul
goto loop
