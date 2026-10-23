@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "KEY=%~dp0_deepseekharness.pem"
set "HOST=root@120.55.184.195"

echo [1/3] 检查隧道 ...
netstat -ano | findstr /C:"127.0.0.1:3080" | findstr /C:"LISTENING" >nul
if errorlevel 1 (
  echo     隧道没在跑，启动计划任务 dsh-tunnel ...
  schtasks /Run /TN "dsh-tunnel" >nul 2>&1
)

set /a tries=0
:wait
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr /C:"127.0.0.1:3080" | findstr /C:"LISTENING" >nul
if errorlevel 1 (
  set /a tries+=1
  if !tries! lss 10 goto wait
  echo.
  echo [失败] 3080 没起来。手动跑一次：schtasks /Run /TN "dsh-tunnel"
  pause
  exit /b 1
)

echo [2/3] 取带 token 的地址 ...
set "URL="
for /f "usebackq delims=" %%u in (`ssh -i "%KEY%" -o StrictHostKeyChecking=no -o BatchMode=yes %HOST% dsh-url`) do set "URL=%%u"
if "%URL%"=="" (
  echo [失败] 取不到地址，检查密钥或网络。
  pause
  exit /b 1
)

echo [3/3] 打开面板 ...
start "" "%URL%"
echo.
echo   面板：%URL%
echo   左下角 设置 -^> 养鱼
echo   QQ 掉线要重扫：http://127.0.0.1:8099/
echo.
echo 隧道是计划任务 dsh-tunnel 在跑，开机自动起、断了自动重连，不用管。
ping -n 8 127.0.0.1 >nul
