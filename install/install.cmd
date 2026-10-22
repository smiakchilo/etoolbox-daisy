@echo off
rem EToolbox Daisy - build it yourself from source; nothing pre-built to trust.
rem
rem What this does, in order (read it, it is short):
rem   1. Downloads portable Node.js from nodejs.org, checks its SHA-256 against the
rem      value pinned below, and checks node.exe carries a valid Authenticode
rem      signature from the OpenJS Foundation.
rem   2. Downloads this repository's source as a zip from GitHub.
rem   3. With that Node, installs the locked npm dependencies (install scripts
rem      disabled), builds the application and writes it - "EToolbox Daisy.exe"
rem      and its files - straight into the folder this file is in.
rem   4. Deletes the temporary work folder and starts the application.
rem
rem Afterwards "EToolbox Daisy.exe" runs on its own; this file is no longer needed.
rem The exe is built on this machine. Your settings and chats live elsewhere
rem and are not touched; run this again in the same folder to update the application.
rem
rem Usage:  install.cmd            build the latest source of the default branch
rem         install.cmd <ref>      build a branch, tag or commit instead
rem Behind a proxy, set HTTPS_PROXY first. Uses only tools that ship with Windows 10+.
setlocal EnableExtensions

rem ---- Pinned inputs ----
set "NODE_VERSION=24.20.0"
set "NODE_SHA256=6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba"
set "NODE_SIGNER=OpenJS Foundation"
set "REPO=smiakchilo/etoolbox-daisy"
set "REF=master"
if not "%~1"=="" set "REF=%~1"

rem The folder this file is in (the trailing "." keeps the path safe to quote).
set "OUT_DIR=%~dp0."
set "WORK=%TEMP%\etoolbox-daisy-build"
set "NODE_DIR=%WORK%\node"
set "SRC_DIR=%WORK%\src"
set "CURL=%SystemRoot%\System32\curl.exe"
set "TAR=%SystemRoot%\System32\tar.exe"
set "SOURCE_URL=%EDAISY_SOURCE_URL%"
if not defined SOURCE_URL set "SOURCE_URL=https://github.com/%REPO%/archive/%REF%.zip"

if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%" || goto fail

rem ---- 1. Portable Node.js ----
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
echo Downloading Node.js %NODE_VERSION% from nodejs.org ...
"%CURL%" -fL --retry 3 -o "%WORK%\%NODE_ZIP%" "https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%" || goto fail
set "GOT="
for /f "skip=1 tokens=*" %%H in ('certutil -hashfile "%WORK%\%NODE_ZIP%" SHA256') do if not defined GOT set "GOT=%%H"
set "GOT=%GOT: =%"
if /i not "%GOT%"=="%NODE_SHA256%" (
  echo The Node.js download does not match the pinned SHA-256.
  echo   expected %NODE_SHA256%
  echo   got      %GOT%
  goto fail
)
"%TAR%" -xf "%WORK%\%NODE_ZIP%" -C "%WORK%" || goto fail
move "%WORK%\node-v%NODE_VERSION%-win-x64" "%NODE_DIR%" >nul || goto fail
del "%WORK%\%NODE_ZIP%"
rem Cleared so a PowerShell 7 parent does not break Windows PowerShell's signature check.
set "PSModulePath="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$s = Get-AuthenticodeSignature '%NODE_DIR%\node.exe'; Write-Host ('node.exe signature: ' + $s.Status + ', ' + $s.SignerCertificate.Subject); if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notlike '*%NODE_SIGNER%*') { exit 1 }" || goto fail

rem ---- 2. Source ----
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
cd /d "%SRC_DIR%"
"%NODE_DIR%\node.exe" scripts\app-build.mjs --out "%OUT_DIR%"
if errorlevel 1 goto fail

rem ---- 4. Clean up and start ----
cd /d "%OUT_DIR%"
rmdir /s /q "%WORK%"
echo.
echo EToolbox Daisy is ready: "%~dp0EToolbox Daisy.exe"
start "" "%~dp0EToolbox Daisy.exe"
exit /b 0

:fail
echo.
echo Failed. The temporary files in "%WORK%" are kept for inspection; delete that folder when done.
echo Nothing else was changed, except possibly files written to "%OUT_DIR%".
pause
exit /b 1
