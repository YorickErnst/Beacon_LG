# Packs the Beacon app into a webOS .ipk without LG's SDK: an ar archive of debian-binary, control.tar.gz and
# data.tar.gz. The web app goes under usr/palm/applications/<id>/, the JS service under usr/palm/services/<id>/,
# and usr/palm/packages/<id>/packageinfo.json ties them together (the layout ares-package produces).
# Needs PowerShell 7 and tar (built into Windows 10+, macOS and Linux).
#   pwsh tools/make-ipk.ps1                      -> dist/org.home.beacon_<version>_all.ipk
#   pwsh tools/make-ipk.ps1 -OutIpk my.ipk
param(
    [string]$AppDir = (Join-Path $PSScriptRoot '..\app'),
    [string]$ServiceDir = (Join-Path $PSScriptRoot '..\service'),
    [string]$OutIpk = ''
)
$ErrorActionPreference = 'Stop'
$info = Get-Content (Join-Path $AppDir 'appinfo.json') -Raw | ConvertFrom-Json
if (-not $OutIpk) {
    $dist = Join-Path $PSScriptRoot '..\dist'
    New-Item -ItemType Directory -Force $dist | Out-Null
    $OutIpk = Join-Path $dist "$($info.id)_$($info.version)_all.ipk"
}
$OutIpk = [IO.Path]::GetFullPath($OutIpk)

# Short temp path: Windows tar struggles with very long ones
$work = Join-Path ([IO.Path]::GetTempPath()) ("ipk-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stage = Join-Path $work 'data'; $ctl = Join-Path $work 'control'
$appDest = Join-Path $stage "usr/palm/applications/$($info.id)"
New-Item -ItemType Directory -Force $appDest, $ctl | Out-Null
Copy-Item (Join-Path $AppDir '*') $appDest -Recurse

$services = @()
if (Test-Path (Join-Path $ServiceDir 'services.json')) {
    $svc = Get-Content (Join-Path $ServiceDir 'services.json') -Raw | ConvertFrom-Json
    $svcDest = Join-Path $stage "usr/palm/services/$($svc.id)"
    New-Item -ItemType Directory -Force $svcDest | Out-Null
    Copy-Item (Join-Path $ServiceDir '*') $svcDest -Recurse
    $services = @($svc.id)
}
$pkgDir = Join-Path $stage "usr/palm/packages/$($info.id)"
New-Item -ItemType Directory -Force $pkgDir | Out-Null
$pkgInfo = [ordered]@{ app = $info.id; id = $info.id; loc_name = $info.title; package_format_version = 2;
                       vendor = $info.vendor; version = $info.version; services = $services }
[IO.File]::WriteAllText((Join-Path $pkgDir 'packageinfo.json'), ($pkgInfo | ConvertTo-Json))

$control = "Package: $($info.id)`nVersion: $($info.version)`nSection: misc`nPriority: optional`nArchitecture: all`n" +
           "Installed-Size: 1`nMaintainer: $($info.vendor)`nDescription: $($info.title)`n" +
           "webOS-Package-Format-Version: 2`nwebOS-Packager-Version: x.y.x`n"
[IO.File]::WriteAllText((Join-Path $ctl 'control'), $control)
$tarArgs = @('--format', 'ustar', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root')
& tar -czf (Join-Path $work 'control.tar.gz') @tarArgs -C $ctl ./control
if ($LASTEXITCODE) { throw 'tar failed (control)' }
& tar -czf (Join-Path $work 'data.tar.gz') @tarArgs -C $stage ./usr
if ($LASTEXITCODE) { throw 'tar failed (data)' }

# ar archive: global header, then per member a 60-byte header and the data (padded to an even length)
$ms = [IO.MemoryStream]::new()
function Add-Bytes([byte[]]$b) { $ms.Write($b, 0, $b.Length) }
Add-Bytes ([Text.Encoding]::ASCII.GetBytes("!<arch>`n"))
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$members = @(
    @{ Name = 'debian-binary'; Data = [Text.Encoding]::ASCII.GetBytes("2.0`n") },
    @{ Name = 'control.tar.gz'; Data = [IO.File]::ReadAllBytes((Join-Path $work 'control.tar.gz')) },
    @{ Name = 'data.tar.gz'; Data = [IO.File]::ReadAllBytes((Join-Path $work 'data.tar.gz')) }
)
foreach ($m in $members) {
    $hdr = ('{0,-16}{1,-12}{2,-6}{3,-6}{4,-8}{5,-10}' -f "$($m.Name)/", $now, 0, 0, 100644, $m.Data.Length) + [char]0x60 + "`n"
    Add-Bytes ([Text.Encoding]::ASCII.GetBytes($hdr))
    Add-Bytes $m.Data
    if ($m.Data.Length % 2) { Add-Bytes ([byte[]](10)) }
}
[IO.File]::WriteAllBytes($OutIpk, $ms.ToArray())
Remove-Item $work -Recurse -Force
"built $OutIpk ($($ms.Length) bytes)"
