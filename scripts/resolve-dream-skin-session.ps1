$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules;C:\Program Files\WindowsPowerShell\Modules'
$taskStateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexDreamSkin'
. (Join-Path $taskStateRoot 'engine\scripts\common-windows.ps1')
$taskState = Read-DreamSkinState -Path (Join-Path $taskStateRoot 'state.json')
if ($null -eq $taskState) { throw 'No Dream Skin session is recorded. Apply the skin from its tray menu first.' }
$taskPort = [int]$taskState.port
Assert-DreamSkinPort -Port $taskPort
$taskSession = Get-DreamSkinVerifiedCdpIdentityForAnyRegistered -Port $taskPort
if ($null -eq $taskSession -or $taskSession.Identity.BrowserId -cne $taskState.browserId) {
    throw 'The current loopback endpoint does not match the verified Dream Skin application session.'
}
[ordered]@{
    port = $taskPort
    browserId = $taskSession.Identity.BrowserId
    packageVersion = "$($taskSession.Codex.Version)"
} | ConvertTo-Json -Compress
