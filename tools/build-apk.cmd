@echo off
REM Build the debug APK with all toolchain paths pinned inside the workspace.
REM Usage: build-apk.cmd [extra gradle args]
chcp 65001 >nul
setlocal
set "JAVA_HOME=C:\Program Files\Java\jdk-17.0.11"
set "ANDROID_HOME=K:\dshworkspace\android-sdk"
set "ANDROID_SDK_ROOT=K:\dshworkspace\android-sdk"
set "ANDROID_USER_HOME=K:\dshworkspace\.android-home"
set "GRADLE_USER_HOME=K:\dshworkspace\.gradle-home"
set "PATH=%JAVA_HOME%\bin;%PATH%"
cd /d "K:\dshworkspace\family-checkin\app\android"

echo [build] JAVA_HOME=%JAVA_HOME%
echo [build] ANDROID_HOME=%ANDROID_HOME%
echo [build] GRADLE_USER_HOME=%GRADLE_USER_HOME%
echo [build] args: assembleDebug %*

call gradlew.bat assembleDebug --console=plain %*
set "RC=%ERRORLEVEL%"
echo [build] exit=%RC%
if exist "app\build\outputs\apk\debug\app-debug.apk" (
  echo [build] APK: %CD%\app\build\outputs\apk\debug\app-debug.apk
)
exit /b %RC%
