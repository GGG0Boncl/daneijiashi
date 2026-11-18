@echo off
REM One-click push of the source and docs to the user's GitHub repository.
REM Usage: push-to-github.cmd [https://github.com/USER/REPO.git]
REM Notes:
REM   * data/ (family records), node_modules/, Android build output and APKs are ignored by .gitignore
REM   * GIT_SSL_NO_VERIFY=1 is needed on this Windows machine (local TLS interception)
REM   * If GitHub asks for a password, use a Personal Access Token instead
setlocal EnableExtensions
chcp 65001 >nul
set "GIT_SSL_NO_VERIFY=1"
cd /d "%~dp0.."

set "DEFAULT_REPO=https://github.com/GGG0Boncl/daneijiashi.git"
if "%~1"=="" (
  set "REPO=%DEFAULT_REPO%"
) else (
  set "REPO=%~1"
)
if "%REPO%"=="" (
  echo Missing repository URL.
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [git] initializing repository
  git init -b main
)

git config --get user.name >nul 2>&1
if errorlevel 1 git config user.name "ChengLong"
git config --get user.email >nul 2>&1
if errorlevel 1 git config user.email "chenglong@localhost"
git config core.quotepath false >nul 2>&1
REM Git for Windows bundles Git Credential Manager; use it so a login window can appear.
git config credential.helper manager >nul 2>&1

git remote remove origin >nul 2>&1
git remote add origin "%REPO%"
echo [git] remote origin = %REPO%

git add -A
git diff --cached --quiet
if errorlevel 1 (
  echo [git] committing changes
  git commit -m "Update danei-jiashi source and docs"
) else (
  echo [git] nothing new to commit
)
git branch -M main

echo [git] pushing to %REPO%
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed. Check:
  echo   - the empty GitHub repository exists and the URL is correct;
  echo   - you are signed in to GitHub on this computer;
  echo   - if password auth is rejected, use a Personal Access Token as the password.
  exit /b 1
)
echo.
echo Done. Repository: %REPO%
exit /b 0
