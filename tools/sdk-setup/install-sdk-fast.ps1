# Fast SDK package extraction using .NET ZipFile (Expand-Archive is ~50x slower here).
# ASCII-only: Windows PowerShell 5.1 misparses BOM-less UTF-8 containing CJK.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sdk = "K:\dshworkspace\android-sdk"
$dl = "$sdk\_dl"

function Install-Pkg($zipName, $targetRel, $expectedTop) {
    $zip = Join-Path $dl $zipName
    if (-not (Test-Path $zip)) { throw "missing zip: $zipName" }
    $target = Join-Path $sdk $targetRel
    $staging = Join-Path $sdk ("_stage_" + [IO.Path]::GetFileNameWithoutExtension($zipName))
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
    $sw.Stop()
    Write-Host ("  extracted {0} in {1:N1}s" -f $zipName, $sw.Elapsed.TotalSeconds)

    $tops = @(Get-ChildItem $staging -Force)
    if ($tops.Count -ne 1) { throw "unexpected top-level entries in $zipName : $($tops.Name -join ', ')" }
    $src = $tops[0].FullName

    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Move-Item $src $target
    Remove-Item -Recurse -Force $staging
    Write-Host "  -> $target"
}

Install-Pkg "platform-35_r02.zip" "platforms\android-35"
Install-Pkg "build-tools_r34-windows.zip" "build-tools\34.0.0"
Install-Pkg "build-tools_r35_windows.zip" "build-tools\35.0.0"

$lic = Join-Path $sdk "licenses"
New-Item -ItemType Directory -Force -Path $lic | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $lic "android-sdk-license"), "24333f8a63b6825ea9c5514f83c2829b004d1fee`n84831b9409646a918e30573bab4c9c91346d8abd`nd975f751698a77b662f1254ddbeed3901e976f5a`n", $utf8)
[System.IO.File]::WriteAllText((Join-Path $lic "android-sdk-preview-license"), "84831b9409646a918e30573bab4c9c91346d8abd`n", $utf8)

Write-Host ""
Write-Host "=== verify ==="
foreach ($p in @("platform-tools\adb.exe", "platforms\android-34\android.jar", "platforms\android-35\android.jar", "build-tools\34.0.0\aapt2.exe", "build-tools\35.0.0\aapt2.exe")) {
    Write-Host ("{0,-40} {1}" -f $p, (Test-Path (Join-Path $sdk $p)))
}
Write-Host "=== sizes ==="
foreach ($d in @("platform-tools", "platforms\android-34", "platforms\android-35", "build-tools\34.0.0", "build-tools\35.0.0")) {
    $p = Join-Path $sdk $d
    if (Test-Path $p) {
        $f = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue
        Write-Host ("{0,-22} {1,6} files {2,7:N0} MB" -f $d, $f.Count, (($f | Measure-Object -Sum Length).Sum / 1MB))
    }
}
