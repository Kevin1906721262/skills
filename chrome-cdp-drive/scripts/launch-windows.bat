@echo off
REM ===========================================================
REM  Browser CDP launcher (Windows) -- Chrome if installed, else Edge.
REM
REM  THE POINT: your everyday browser and the CDP-driven browser
REM  are ONE AND THE SAME, on ONE AND THE SAME profile. Login
REM  state is therefore shared; nothing needs logging in twice.
REM
REM  Usage:
REM    launch-windows.bat                    :: start with port 9222
REM    launch-windows.bat https://x.com      :: also open a URL
REM    set CDP_PORT=9223 & set CDP_PROFILE=C:\Users\me\.browser-isolated & launch-windows.bat
REM
REM  Behaviour:
REM    1. debug port already up        -> just open a window
REM    2. browser running WITHOUT it   -> restart it (see [warn] below)
REM    3. otherwise                    -> start with the port
REM
REM  NOTE: keep every comment in this file ASCII. cmd.exe parses .bat in the
REM  OEM codepage (GBK on Chinese Windows) while the file is UTF-8, so CJK
REM  comments turn into mojibake and break parsing with
REM  "'xxx' is not recognized as an internal or external command".
REM ===========================================================
setlocal

set "PORT=%CDP_PORT%"
if "%PORT%"=="" set "PORT=9222"
set "PROFILE_OVERRIDE=%CDP_PROFILE%"

set "CHROME_A=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME_B=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
set "CHROME_C=%LocalAppData%\Google\Chrome\Application\chrome.exe"
set "EDGE_A=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "EDGE_B=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

set "BROWSER="
if exist "%CHROME_A%" set "BROWSER=%CHROME_A%" & set "PROFILE=%LocalAppData%\Google\Chrome\User Data" & set "PROC=chrome.exe" & goto :have_browser
if exist "%CHROME_B%" set "BROWSER=%CHROME_B%" & set "PROFILE=%LocalAppData%\Google\Chrome\User Data" & set "PROC=chrome.exe" & goto :have_browser
if exist "%CHROME_C%" set "BROWSER=%CHROME_C%" & set "PROFILE=%LocalAppData%\Google\Chrome\User Data" & set "PROC=chrome.exe" & goto :have_browser
if exist "%EDGE_A%"  set "BROWSER=%EDGE_A%"  & set "PROFILE=%LocalAppData%\Microsoft\Edge\User Data" & set "PROC=msedge.exe" & goto :have_browser
if exist "%EDGE_B%"  set "BROWSER=%EDGE_B%"  & set "PROFILE=%LocalAppData%\Microsoft\Edge\User Data" & set "PROC=msedge.exe" & goto :have_browser

echo [ERROR] Neither Chrome nor Edge was found. Install one, then rerun.
exit /b 1

:have_browser
if not "%PROFILE_OVERRIDE%"=="" set "PROFILE=%PROFILE_OVERRIDE%"

echo [..] Browser : %BROWSER%
echo [..] Profile : %PROFILE%

REM --- 1. is the debug port already up? ---
REM     (the port flag is passed again anyway: harmless when handing off to a
REM      live instance, and correct if that instance died in the meantime)
REM     curl is called by full path: Git's curl often shadows the system one.
"%SystemRoot%\System32\curl.exe" -s --max-time 2 http://127.0.0.1:%PORT%/json/version >nul 2>&1
if not errorlevel 1 (
  echo [ok] Debug port %PORT% is already up. Opening a window.
  start "" "%BROWSER%" --user-data-dir="%PROFILE%" --remote-debugging-port=%PORT% %*
  goto :done
)

REM --- 2. browser running without the port? it must be restarted ---
REM     (taskkill matches by image name, so it kills EVERY instance of this
REM      browser -- including an isolated one on another profile. In that
REM      case use CDP's Browser.close instead.)
tasklist /FI "IMAGENAME eq %PROC%" 2>nul | "%SystemRoot%\System32\find.exe" /I "%PROC%" >nul
if not errorlevel 1 (
  echo [warn] %PROC% is running WITHOUT a debug port. Restarting it.
  echo        Its windows will close; the browser restores tabs on reopen.
  taskkill /F /IM %PROC% >nul 2>&1
  REM no `timeout` here: it errors without a console. ping is the portable sleep.
  "%SystemRoot%\System32\ping.exe" -n 4 127.0.0.1 >nul
)

REM --- 3. start with the port ---
echo [..] Starting with CDP debug port %PORT% ...
start "" "%BROWSER%" --user-data-dir="%PROFILE%" --remote-debugging-port=%PORT% --no-first-run --no-default-browser-check %*

:done
endlocal
