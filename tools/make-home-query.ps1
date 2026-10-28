# Regenerates app/home-query.js from tools/GetMemberHomePage.graphql (the member home page query exactly as
# beacon.tv sends it). Run after updating the .graphql file:  pwsh tools/make-home-query.ps1
$ErrorActionPreference = 'Stop'
$q = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'GetMemberHomePage.graphql')) -replace "`r`n", "`n"
$js = "// Beacon's member home page query, exactly as beacon.tv sends it (generated from tools/GetMemberHomePage.graphql`n" +
      "// by tools/make-home-query.ps1)`nwindow.BEACON_HOME_QUERY = " + (ConvertTo-Json $q -Compress) + ";`n"
[IO.File]::WriteAllText((Join-Path $PSScriptRoot '..\app\home-query.js'), $js)
"wrote app/home-query.js"
