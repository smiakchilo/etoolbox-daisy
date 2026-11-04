@echo off
rem EToolbox Daisy - build it yourself from source; nothing pre-built to trust.
rem
rem What this does, in order (read it, it is short):
rem   1. Node.js. When this machine already has 22.12 or newer on PATH, with npm
rem      beside node.exe, that one is used. Only when there is none does it
rem      download portable Node.js from nodejs.org, check its SHA-256 against the
rem      value pinned below, and check node.exe carries a valid Authenticode
rem      signature from the OpenJS Foundation.
rem   2. Downloads this repository's source as a zip from GitHub.
rem   3. With that Node, installs the locked npm dependencies, builds the application
rem      and writes it and its files - straight into the folder this file is in.
rem   4. Deletes the temporary work folder and starts the application.
rem
rem Afterwards "EToolbox Daisy.exe" runs on its own; this file is no longer needed.
rem The exe is built on this machine. Your settings and chats live elsewhere
rem and are not touched; run this again in the same folder to update the application.
rem
rem Usage:  install.cmd            build the latest source of the default branch
rem         install.cmd <ref>      build a branch, tag or commit instead
rem         install.cmd --update <ref-or-zip-url> <app-folder> <app-pid> <status-file>
rem                                the application's own updater: builds into
rem                                "<app-folder>.new" while the application runs, checks
rem                                that build starts, waits for <app-pid> to exit, swaps
rem                                the folders, starts the new build and reverts to
rem                                "<app-folder>.previous" if that does not come up.
rem                                Progress goes to <status-file> as "stage|text"; there
rem                                is never a prompt in this mode.
rem Behind a proxy, set HTTPS_PROXY first. Uses only tools that ship with Windows 10+.
rem Set EDAISY_NODE=pinned to ignore an installed Node.js and always use the
rem verified download - that is the toolchain the build is tested with.
setlocal EnableExtensions

rem ---- Pinned inputs ----
set "NODE_VERSION=24.20.0"
set "NODE_SHA256=6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba"
set "NODE_SIGNER=OpenJS Foundation"
rem The oldest installed Node.js the build tools declare support for: Electron 44,
rem electron-vite 5 and vite 7 all answer 22.12. An older one is refused here
rem rather than failing halfway through the build.
set "NODE_BASELINE_MAJOR=22"
set "NODE_BASELINE_MINOR=12"
set "REPO=smiakchilo/etoolbox-daisy"
set "REF=master"
set "UPDATE_MODE="
set "STATUS_FILE="
if /i "%~1"=="--update" (set "UPDATE_MODE=1") else if not "%~1"=="" set "REF=%~1"

rem The folder this file is in (the trailing "." keeps the path safe to quote).
set "OUT_DIR=%~dp0."
set "WORK=%TEMP%\etoolbox-daisy-build"
set "NODE_DIR="
rem A pinned Node.js this script had to download is kept here (the app's technical
rem folder, beside its add-ons) instead of being deleted with the work folder: the
rem app needs npm to prepare an add-on on its first call, and the next update
rem reuses it instead of downloading it again. A Node.js already installed on the
rem machine is used as it is and nothing is kept.
set "KEPT_NODE=%LOCALAPPDATA%\etoolbox-daisy\node"
set "SRC_DIR=%WORK%\src"
set "STEP=starting"
rem Absolute paths: a trimmed PATH must not decide whether the build works, and
rem certutil lives in System32 too - calling it by name is what once turned a
rem downloadable Node into "certutil is not recognized".
set "CURL=%SystemRoot%\System32\curl.exe"
set "TAR=%SystemRoot%\System32\tar.exe"
set "CERTUTIL=%SystemRoot%\System32\certutil.exe"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
rem Cleared before any PowerShell call, so a PowerShell 7 parent (whose
rem PSModulePath wins otherwise) does not hide Get-FileHash or break the
rem signature check.
set "PSModulePath="
set "TASKLIST=%SystemRoot%\System32\tasklist.exe"
set "TASKKILL=%SystemRoot%\System32\taskkill.exe"
set "FINDSTR=%SystemRoot%\System32\findstr.exe"
set "PING=%SystemRoot%\System32\ping.exe"
set "SOURCE_URL=%EDAISY_SOURCE_URL%"
if defined UPDATE_MODE call :setup_update %*
if defined UPDATE_MODE if not defined APP_DIR exit /b 2
if not defined SOURCE_URL set "SOURCE_URL=https://github.com/%REPO%/archive/%REF%.zip"

for %%T in ("%CURL%" "%TAR%" "%POWERSHELL%") do if not exist "%%~T" (
  echo This script needs %%~T, which ships with Windows 10.
  echo It was not found, so nothing was changed.
  goto fail
)

if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%" || goto fail
if defined UPDATE_MODE (
  if exist "%OUT_DIR%" rmdir /s /q "%OUT_DIR%"
  mkdir "%OUT_DIR%" || goto fail
)

rem ---- 1. Node.js: the one installed here when it is new enough, else the pinned build ----
set "NODE_SEARCHED="
if /i not "%EDAISY_NODE%"=="pinned" set "NODE_SEARCHED=1"
if defined NODE_SEARCHED call :find_installed_node
if defined NODE_DIR goto node_ready
call :find_kept_node
if defined NODE_DIR goto node_ready
if defined NODE_SEARCHED echo No Node.js %NODE_BASELINE_MAJOR%.%NODE_BASELINE_MINOR% or newer with npm was found; downloading the pinned %NODE_VERSION% ...
set "STEP=Node.js setup"
call :status installing-node "Downloading Node.js"
call :install_pinned_node
if not defined NODE_DIR goto fail

:node_ready
rem ---- 2. Source ----
set "STEP=Source download"
call :status downloading "Downloading the source"
echo Downloading source from %SOURCE_URL% ...
mkdir "%WORK%\unpack"
"%CURL%" -fL --retry 3 -o "%WORK%\source.zip" "%SOURCE_URL%" || goto fail
"%TAR%" -xf "%WORK%\source.zip" -C "%WORK%\unpack" || goto fail
for /d %%D in ("%WORK%\unpack\*") do move "%%D" "%SRC_DIR%" >nul
if not exist "%SRC_DIR%\scripts\app-build.mjs" goto fail

rem ---- 3. Install, build, write the app next to this file (caches stay in the work folder) ----
set "PATH=%NODE_DIR%;%PATH%"
set "npm_config_cache=%WORK%\npm-cache"
set "npm_config_update_notifier=false"
set "electron_config_cache=%WORK%\electron-cache"
set "ELECTRON_CACHE=%WORK%\electron-cache"
set "ELECTRON_BUILDER_CACHE=%WORK%\builder-cache"
set "STEP=Build"
call :status building "Building the update"
cd /d "%SRC_DIR%"
"%NODE_DIR%\node.exe" scripts\app-build.mjs --out "%OUT_DIR%"
if errorlevel 1 (
  if defined NODE_INSTALLED echo Retry with EDAISY_NODE=pinned to build with the Node.js this script is tested with.
  goto fail
)

if defined UPDATE_MODE goto update_finish

rem ---- 4. Clean up and start ----
cd /d "%OUT_DIR%"
rmdir /s /q "%WORK%"
echo.
echo EToolbox Daisy is ready: "%~dp0EToolbox Daisy.exe"
start "" "%~dp0EToolbox Daisy.exe"
exit /b 0

rem ---- 4. (--update) Check the build starts, wait for the application to exit, swap, start, verify ----
rem The application keeps running until here. Nothing in the installed folder has
rem been touched yet, so every failure up to the swap just discards the staging folder.

:update_finish
set "STEP=Start-up check"
call :status testing "Checking the new build starts"
rem The status file is how the application recognises a freshly swapped build; the
rem check must not look like one.
set "EDAISY_UPDATE_STATUS_FILE="
rem The exit code is checked explicitly. A check whose console window is closed on
rem it dies with a negative code (0xC000013A), and "if errorlevel 1" does not see a
rem negative number - that form once passed a crashed check off as healthy, so an
rem unverified build was swapped in.
"%POWERSHELL%" -NoProfile -NonInteractive -Command "$p = Start-Process -FilePath '%OUT_DIR%\EToolbox Daisy.exe' -ArgumentList '--smoke-test' -PassThru; if (-not $p.WaitForExit(180000)) { $p.Kill(); exit 124 }; if ($p.ExitCode -ne 0) { exit 1 }; exit 0"
if errorlevel 1 goto fail

rem Keep the user's own copy of this script beside the new build.
if exist "%APP_DIR%\install.cmd" copy /y "%SRC_DIR%\install\install.cmd" "%OUT_DIR%\install.cmd" >nul

set "STEP=Swap"
call :status ready "The update is ready to install"
cd /d "%TEMP%"
rem The app quits itself once it reads "ready", so this loop normally ends at
rem once. The bound matters when it does not (a hung quit, a recycled pid): the
rem install is still untouched here, so after ten minutes the update reports the
rem failure instead of spinning in a window nobody watches.
set "WAIT_EXIT=0"
:wait_exit
"%TASKLIST%" /FI "PID eq %APP_PID%" /NH 2>nul | "%FINDSTR%" /c:" %APP_PID% " >nul || goto app_gone
set /a WAIT_EXIT+=1
if %WAIT_EXIT% GEQ 300 goto wait_exit_failed
"%PING%" -n 3 127.0.0.1 >nul
goto wait_exit

:wait_exit_failed
if exist "%OUT_DIR%" rmdir /s /q "%OUT_DIR%"
if exist "%STATUS_FILE%.go" del "%STATUS_FILE%.go" >nul 2>&1
call :status failed "The application did not close; nothing was changed"
if exist "%WORK%" rmdir /s /q "%WORK%"
exit /b 1

:app_gone
if exist "%PREV_DIR%" rmdir /s /q "%PREV_DIR%"
set "TRIES=0"
:swap_old
ren "%APP_DIR%" "%APP_NAME%.previous" 2>nul && goto swap_new
set /a TRIES+=1
if %TRIES% GEQ 30 goto swap_failed
"%PING%" -n 2 127.0.0.1 >nul
goto swap_old

:swap_new
ren "%OUT_DIR%" "%APP_NAME%" 2>nul && goto swapped
ren "%PREV_DIR%" "%APP_NAME%" 2>nul

:swap_failed
call :status failed "Swap failed: the installed folder could not be replaced"
if exist "%APP_DIR%\EToolbox Daisy.exe" if exist "%STATUS_FILE%.go" call :launch "%APP_DIR%\EToolbox Daisy.exe"
goto update_cleanup

:swapped
rem Without the restart marker the user only closed the application; the new build
rem is in place and starts the next time they open it.
if not exist "%STATUS_FILE%.go" (
  call :status swapped "Updated; starts next time"
  goto update_cleanup
)
call :status swapped "Updated"
set "EDAISY_UPDATE_STATUS_FILE=%STATUS_FILE%"
call :launch "%APP_DIR%\EToolbox Daisy.exe"
set "WAITED=0"
:wait_started
"%FINDSTR%" /b /c:"started|" "%STATUS_FILE%" >nul 2>&1 && goto started
if not defined NEW_PID goto start_failed
"%TASKLIST%" /FI "PID eq %NEW_PID%" /NH 2>nul | "%FINDSTR%" /c:" %NEW_PID% " >nul || goto start_failed
set /a WAITED+=1
if %WAITED% GEQ 120 goto start_failed
"%PING%" -n 2 127.0.0.1 >nul
goto wait_started

:started
if exist "%PREV_DIR%" rmdir /s /q "%PREV_DIR%"
goto update_cleanup

rem The new build never reported in: stop that process, put the old install back.
:start_failed
if defined NEW_PID "%TASKKILL%" /PID %NEW_PID% /T /F >nul 2>&1
set "TRIES=0"
:revert_remove
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%" 2>nul
if not exist "%APP_DIR%" goto revert_rename
set /a TRIES+=1
if %TRIES% GEQ 15 goto update_cleanup
"%PING%" -n 2 127.0.0.1 >nul
goto revert_remove
:revert_rename
ren "%PREV_DIR%" "%APP_NAME%" 2>nul || goto update_cleanup
call :status reverted "The new version did not start; the previous one was restored"
set "EDAISY_UPDATE_STATUS_FILE=%STATUS_FILE%"
call :launch "%APP_DIR%\EToolbox Daisy.exe"
goto update_cleanup

:update_cleanup
cd /d "%TEMP%"
if exist "%STATUS_FILE%.go" del "%STATUS_FILE%.go" >nul 2>&1
if exist "%WORK%" rmdir /s /q "%WORK%"
exit /b 0

:fail
if defined UPDATE_MODE goto update_fail
echo.
echo Failed. The temporary files in "%WORK%" are kept for inspection; delete that folder when done.
echo Nothing else was changed, except possibly files written to "%OUT_DIR%".
pause
exit /b 1

:update_fail
cd /d "%TEMP%"
if exist "%OUT_DIR%" rmdir /s /q "%OUT_DIR%"
call :status failed "%STEP% failed"
if exist "%WORK%" rmdir /s /q "%WORK%"
exit /b 1

rem ---- Subroutines ----

rem --update only: reads <ref-or-url> <app-folder> <app-pid> <status-file> from the
rem arguments and derives the staging and previous folders beside the application's.
rem A value with a colon is a URL (http, https, file); anything else is a branch,
rem tag or commit. Leaves APP_DIR empty when an argument is missing.

:setup_update
set "UPDATE_SOURCE=%~2"
set "APP_DIR=%~3"
set "APP_PID=%~4"
set "STATUS_FILE=%~5"
if not defined UPDATE_SOURCE set "APP_DIR="
if not defined APP_PID set "APP_DIR="
if not defined STATUS_FILE set "APP_DIR="
if not defined APP_DIR goto :eof
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
for %%I in ("%APP_DIR%") do set "APP_NAME=%%~nxI"
set "OUT_DIR=%APP_DIR%.new"
set "PREV_DIR=%APP_DIR%.previous"
if not "%UPDATE_SOURCE::=%"=="%UPDATE_SOURCE%" (set "SOURCE_URL=%UPDATE_SOURCE%") else set "REF=%UPDATE_SOURCE%"
goto :eof

rem Records the stage the update has reached as "stage|text" for the application to
rem read. A no-op when this is not an update.

:status
if not defined STATUS_FILE goto :eof
>"%STATUS_FILE%" echo %~1^|%~2
goto :eof

rem Starts %1 detached and leaves its process id in NEW_PID.
rem PowerShell writes the id to a file rather than to stdout: a "for /f" over a
rem command hands it to "cmd /c", whose quote handling turns a quoted absolute
rem path into "'...powershell.exe" -NoProfile ...' is not recognized". The launch
rem then failed silently, every update reverted, and the app was left closed.

:launch
set "NEW_PID="
set "PID_FILE=%WORK%\launch-pid.txt"
rem PowerShell sees these in single quotes, so each quote is doubled first: an
rem install folder named "Bob's Daisy" must not end the string early.
set "LAUNCH_PID_FILE=%PID_FILE:'=''%"
set "LAUNCH_EXE=%~1"
set "LAUNCH_EXE=%LAUNCH_EXE:'=''%"
set "LAUNCH_DIR=%~dp1"
set "LAUNCH_DIR=%LAUNCH_DIR:'=''%"
if exist "%PID_FILE%" del "%PID_FILE%" >nul 2>&1
"%POWERSHELL%" -NoProfile -NonInteractive -Command "(Start-Process -FilePath '%LAUNCH_EXE%' -WorkingDirectory '%LAUNCH_DIR%' -PassThru).Id | Set-Content -LiteralPath '%LAUNCH_PID_FILE%'"
if exist "%PID_FILE%" for /f "usebackq tokens=*" %%P in ("%PID_FILE%") do if not defined NEW_PID set "NEW_PID=%%P"
if exist "%PID_FILE%" del "%PID_FILE%" >nul 2>&1
goto :eof

rem Sets NODE_DIR to the folder of the Node.js already on PATH, when it is new
rem enough and carries npm beside node.exe - the layout app-build.mjs needs.
rem Leaves NODE_DIR empty otherwise.

:find_installed_node
set "NODE_EXE="
set "INSTALLED_NODE_VERSION="
set "INSTALLED_NODE_MAJOR="
set "INSTALLED_NODE_MINOR="
for /f "delims=" %%E in ('node -p process.execPath 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%E"
if not defined NODE_EXE goto :eof
for /f "delims=" %%V in ('node -p process.versions.node 2^>nul') do if not defined INSTALLED_NODE_VERSION set "INSTALLED_NODE_VERSION=%%V"
if not defined INSTALLED_NODE_VERSION goto :eof
for /f "tokens=1,2 delims=." %%A in ("%INSTALLED_NODE_VERSION%") do set "INSTALLED_NODE_MAJOR=%%A"
for /f "tokens=1,2 delims=." %%A in ("%INSTALLED_NODE_VERSION%") do set "INSTALLED_NODE_MINOR=%%B"
if not defined INSTALLED_NODE_MINOR goto :eof
set "INSTALLED_NODE_OK="
if %INSTALLED_NODE_MAJOR% GTR %NODE_BASELINE_MAJOR% set "INSTALLED_NODE_OK=1"
if %INSTALLED_NODE_MAJOR% EQU %NODE_BASELINE_MAJOR% if %INSTALLED_NODE_MINOR% GEQ %NODE_BASELINE_MINOR% set "INSTALLED_NODE_OK=1"
if not defined INSTALLED_NODE_OK goto :eof
for %%I in ("%NODE_EXE%") do set "INSTALLED_NODE_DIR=%%~dpI"
if not exist "%INSTALLED_NODE_DIR%node_modules\npm\bin\npm-cli.js" if not exist "%INSTALLED_NODE_DIR%..\lib\node_modules\npm\bin\npm-cli.js" goto :eof
set "NODE_DIR=%INSTALLED_NODE_DIR:~0,-1%"
set "NODE_INSTALLED=1"
echo Using the installed Node.js %INSTALLED_NODE_VERSION% - %NODE_DIR%
echo It is neither downloaded nor signature-checked by this script.
goto :eof

rem Sets NODE_DIR to the pinned Node.js a previous run kept, when it is this
rem script's pin (its marker file is named after the version) and still whole.

:find_kept_node
if not exist "%KEPT_NODE%\.pinned-%NODE_VERSION%" goto :eof
if not exist "%KEPT_NODE%\node.exe" goto :eof
if not exist "%KEPT_NODE%\node_modules\npm\bin\npm-cli.js" goto :eof
set "NODE_DIR=%KEPT_NODE%"
echo Using the Node.js %NODE_VERSION% kept from an earlier run - %NODE_DIR%
goto :eof

rem Downloads the pinned portable Node.js, verifies it and keeps it in
rem %KEPT_NODE%, which becomes %NODE_DIR%.

:install_pinned_node
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
echo Downloading Node.js %NODE_VERSION% from nodejs.org ...
"%CURL%" -fL --retry 3 -o "%WORK%\%NODE_ZIP%" "https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%" || goto :eof
call :sha256 "%WORK%\%NODE_ZIP%"
if not defined HASH (
  echo Could not read the SHA-256 of the download: neither Windows PowerShell
  echo nor certutil would hash the file, so it cannot be verified.
  goto :eof
)
if /i not "%HASH%"=="%NODE_SHA256%" (
  echo The Node.js download does not match the pinned SHA-256.
  echo   expected %NODE_SHA256%
  echo   got      %HASH%
  goto :eof
)
"%TAR%" -xf "%WORK%\%NODE_ZIP%" -C "%WORK%" || goto :eof
set "NODE_DIR=%WORK%\node"
move "%WORK%\node-v%NODE_VERSION%-win-x64" "%NODE_DIR%" >nul || goto :eof
del "%WORK%\%NODE_ZIP%"
"%POWERSHELL%" -NoProfile -Command "$s = Get-AuthenticodeSignature '%NODE_DIR%\node.exe'; Write-Host ('node.exe signature: ' + $s.Status + ', ' + $s.SignerCertificate.Subject); if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notlike '*%NODE_SIGNER%*') { exit 1 }" || goto :eof
if exist "%KEPT_NODE%" rmdir /s /q "%KEPT_NODE%"
if not exist "%LOCALAPPDATA%\etoolbox-daisy" mkdir "%LOCALAPPDATA%\etoolbox-daisy"
move "%NODE_DIR%" "%KEPT_NODE%" >nul || goto :eof
type nul > "%KEPT_NODE%\.pinned-%NODE_VERSION%"
set "NODE_DIR=%KEPT_NODE%"
goto :eof

rem Sets HASH to the lower/upper-case hex SHA-256 of %1, or leaves it undefined.
rem PowerShell first (already required above, and its output is not localized),
rem certutil as the fallback.

:sha256
set "HASH="
set "HASH_FILE=%WORK%\sha256.txt"
if exist "%HASH_FILE%" del "%HASH_FILE%" >nul 2>&1
if exist "%POWERSHELL%" "%POWERSHELL%" -NoProfile -NonInteractive -Command "(Get-FileHash -LiteralPath '%~1' -Algorithm SHA256).Hash" >"%HASH_FILE%" 2>nul
if exist "%HASH_FILE%" for /f "usebackq tokens=*" %%H in ("%HASH_FILE%") do if not defined HASH set "HASH=%%H"
if defined HASH set "HASH=%HASH: =%"
if defined HASH goto :eof
if not exist "%CERTUTIL%" goto :eof
for /f "skip=1 tokens=*" %%H in ('"%CERTUTIL%" -hashfile "%~1" SHA256 2^>nul') do if not defined HASH set "HASH=%%H"
if defined HASH set "HASH=%HASH: =%"
goto :eof
