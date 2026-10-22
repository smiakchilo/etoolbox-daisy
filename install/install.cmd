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
if not "%~1"=="" set "REF=%~1"

rem The folder this file is in (the trailing "." keeps the path safe to quote).
set "OUT_DIR=%~dp0."
set "WORK=%TEMP%\etoolbox-daisy-build"
set "NODE_DIR="
set "SRC_DIR=%WORK%\src"
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
set "SOURCE_URL=%EDAISY_SOURCE_URL%"
if not defined SOURCE_URL set "SOURCE_URL=https://github.com/%REPO%/archive/%REF%.zip"

for %%T in ("%CURL%" "%TAR%" "%POWERSHELL%") do if not exist "%%~T" (
  echo This script needs %%~T, which ships with Windows 10.
  echo It was not found, so nothing was changed.
  goto fail
)

if exist "%WORK%" rmdir /s /q "%WORK%"
mkdir "%WORK%" || goto fail

rem ---- 1. Node.js: the one installed here when it is new enough, else the pinned build ----
set "NODE_SEARCHED="
if /i not "%EDAISY_NODE%"=="pinned" set "NODE_SEARCHED=1"
if defined NODE_SEARCHED call :find_installed_node
if defined NODE_DIR goto node_ready
if defined NODE_SEARCHED echo No Node.js %NODE_BASELINE_MAJOR%.%NODE_BASELINE_MINOR% or newer with npm was found; downloading the pinned %NODE_VERSION% ...
call :install_pinned_node
if not defined NODE_DIR goto fail

:node_ready
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
if errorlevel 1 (
  if defined NODE_INSTALLED echo Retry with EDAISY_NODE=pinned to build with the Node.js this script is tested with.
  goto fail
)

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

rem ---- Subroutines ----

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

rem Downloads the pinned portable Node.js, verifies it and extracts it to
rem %NODE_DIR%.

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
