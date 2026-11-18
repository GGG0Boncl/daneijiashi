@echo off
chcp 65001 >nul
setlocal
set "SDK=K:\dshworkspace\android-sdk"
set "JAVA_HOME=C:\Program Files\Java\jdk-17.0.11"
set "PATH=%JAVA_HOME%\bin;%PATH%"
set "SM=%SDK%\cmdline-tools\latest\bin\sdkmanager.bat"

echo [1/2] accepting licenses...
(for /L %%i in (1,1,60) do @echo y) | call "%SM%" --sdk_root="%SDK%" --licenses

echo [2/2] installing packages...
(for /L %%i in (1,1,60) do @echo y) | call "%SM%" --sdk_root="%SDK%" "platform-tools" "platforms;android-34" "platforms;android-35" "build-tools;34.0.0" "build-tools;35.0.0"

echo DONE exitcode=%ERRORLEVEL%
