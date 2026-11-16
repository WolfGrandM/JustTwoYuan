@echo off
chcp 65001 >nul
set "KEY=%~dp0_deepseekharness.pem"
set "HOST=root@120.55.184.195"
set "OUT=%TEMP%\dsh-url.out.txt"
set "ERR=%TEMP%\dsh-url.err.txt"

echo [1/3] 检查隧道 ...
netstat -ano | findstr /C:"127.0.0.1:3080" | findstr /C:"LISTENING" >nul
if errorlevel 1 (
  echo     隧道没在跑，启动计划任务 dsh-tunnel ...
  schtasks /Run /TN "dsh-tunnel" >nul 2>&1
)
call :waitport
if errorlevel 1 (
  echo [失败] 3080 没起来。手动跑一次：schtasks /Run /TN "dsh-tunnel"
  pause
  exit /b 1
)

echo [2/3] 取带 token 的地址 ...
if exist "%OUT%" del "%OUT%" >nul 2>&1
if exist "%ERR%" del "%ERR%" >nul 2>&1
ssh -i "%KEY%" -o StrictHostKeyChecking=no -o BatchMode=yes %HOST% dsh-url > "%OUT%" 2> "%ERR%"
set "SSHRC=%ERRORLEVEL%"

echo [3/3] 打开面板 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$o='%OUT%';$e='%ERR%';$u='';if(Test-Path $o){$u=(Get-Content -Raw $o).Trim()};if($u -match '^https?://'){Start-Process $u;Write-Host ('  面板：'+$u)}else{Write-Host ('[失败] 取不到地址，ssh 退出码=%SSHRC%');if(Test-Path $e){Get-Content $e};Write-Host '排查：密钥是否在 "+$KEY+"，或手动执行 ssh -i ... dsh-url';exit 9}"
if errorlevel 9 (
  pause
  exit /b 1
)
echo.
echo   左下角 设置 -^> 养鱼 / 彩票
echo   QQ 掉线要重扫：http://127.0.0.1:8099/
ping -n 8 127.0.0.1 >nul
exit /b 0

:waitport
set /a n=0
:loop
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr /C:"127.0.0.1:3080" | findstr /C:"LISTENING" >nul
if not errorlevel 1 exit /b 0
set /a n+=1
if %n% lss 10 goto loop
exit /b 1
