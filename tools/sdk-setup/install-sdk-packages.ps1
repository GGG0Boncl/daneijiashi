# ASCII-only on purpose: Windows PowerShell 5.1 misparses BOM-less UTF-8 with CJK text.
$ErrorActionPreference = "Stop"
$sdk = "K:\dshworkspace\android-sdk"
$dl = "$sdk\_dl"
$tmp = "$sdk\_unzip"

function Install-Pkg($zipName, $targetRel) {
    $zip = Join-Path $dl $zipName
    if (-not (Test-Path $zip)) { throw "missing zip: $zipName" }
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Write-Host "unzip $zipName ..."
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $tops = @(Get-ChildItem $tmp)
    if ($tops.Count -ne 1) { Write-Host "  ! top-level entries=$($tops.Count): $($tops.Name -join ', ')" }
    $src = $tops[0].FullName
    $target = Join-Path $sdk $targetRel
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Move-Item $src $target
    Write-Host "  -> $target"
}

Install-Pkg "platform-tools_r37.0.1-win.zip" "platform-tools"
Install-Pkg "platform-34-ext7_r03.zip" "platforms\android-34"
Install-Pkg "platform-35_r02.zip" "platforms\android-35"
Install-Pkg "build-tools_r34-windows.zip" "build-tools\34.0.0"
Install-Pkg "build-tools_r35_windows.zip" "build-tools\35.0.0"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }

$lic = Join-Path $sdk "licenses"
New-Item -ItemType Directory -Force -Path $lic | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $lic "android-sdk-license"), "24333f8a63b6825ea9c5514f83c2829b004d1fee`n84831b9409646a918e30573bab4c9c91346d8abd`nd975f751698a77b662f1254ddbeed3901e976f5a`n", $utf8)
[System.IO.File]::WriteAllText((Join-Path $lic "android-sdk-preview-license"), "84831b9409646a918e30573bab4c9c91346d8abd`n", $utf8)

Write-Host ""
Write-Host "=== verify ==="
foreach ($p in @("platform-tools\adb.exe", "platforms\android-34\android.jar", "platforms\android-35\android.jar", "build-tools\34.0.0\aapt2.exe", "build-tools\35.0.0\aapt2.exe")) {
    $full = Join-Path $sdk $p
    Write-Host ("{0,-40} {1}" -f $p, (Test-Path $full))
}
Get-ChildItem $sdk -Directory | Select-Object -ExpandProperty Name | ForEach-Object { Write-Host "dir: $_" }
