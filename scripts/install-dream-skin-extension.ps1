param(
    [string]$InjectorPath = (Join-Path $env:USERPROFILE 'AppData\Local\CodexDreamSkin\engine\scripts\injector.mjs'),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $projectRoot 'integration\skin-extension.mjs'
$stateDirectory = Join-Path $projectRoot 'integration\install-state'
$receiptPath = Join-Path $stateDirectory 'dream-skin-extension.json'
$marker = '// CODEX_COMPANIONS_EXTENSION_START'

# Resolve the path of the opened file, including MSIX file redirection.
if (-not ('CompanionExtension.NativePath' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace CompanionExtension {
    public static class NativePath {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    }
}
'@
}
$requestedPath = [IO.Path]::GetFullPath($InjectorPath)
$stream = [IO.File]::OpenRead($requestedPath)
try {
    $buffer = New-Object Text.StringBuilder 32768
    $length = [CompanionExtension.NativePath]::GetFinalPathNameByHandle($stream.SafeFileHandle, $buffer, $buffer.Capacity, 0)
    if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Could not determine the opened injector file path.' }
    $openedPath = $buffer.ToString()
} finally { $stream.Dispose() }
if ($openedPath.StartsWith('\\?\')) { $openedPath = $openedPath.Substring(4) }
if ($openedPath -match '\\LocalCache\\' -or -not [string]::Equals($requestedPath, $openedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The injector opened at '$openedPath', which differs from the requested physical target '$requestedPath'. Run this script from a normal desktop PowerShell and use the physical injector path. No file was changed."
}

function Get-BytesSha256 {
    param([byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '') }
    finally { $algorithm.Dispose() }
}

function Set-CheckedInjector {
    param([byte[]]$Bytes, [string]$ExpectedSha256)
    $stagedPath = Join-Path (Split-Path -Parent $openedPath) ('.companion-extension-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllBytes($stagedPath, $Bytes)
        if ((Get-FileHash -LiteralPath $openedPath -Algorithm SHA256).Hash -ne $ExpectedSha256) {
            throw 'The injector changed during this operation. Its current contents were preserved.'
        }
        [IO.File]::Replace($stagedPath, $openedPath, $null)
    } finally {
        if (Test-Path -LiteralPath $stagedPath) { Remove-Item -LiteralPath $stagedPath -Force }
    }
}

$commonPath = Join-Path (Split-Path -Parent $openedPath) 'common-windows.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) { throw "Dream Skin operation-lock support is missing: $commonPath" }
. $commonPath
$operationLock = Enter-DreamSkinOperationLock
try {

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $receiptPath)) { throw "No installation receipt exists at '$receiptPath'." }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if (-not [string]::Equals($receipt.targetPath, $openedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The receipt belongs to a different injector target.' }
    $currentHash = (Get-FileHash -LiteralPath $openedPath -Algorithm SHA256).Hash
    if ($currentHash -ne $receipt.patchedSha256) { throw "The injector changed after installation. Restore was stopped to preserve those changes. Original backup: $($receipt.backupPath)" }
    $backupHash = (Get-FileHash -LiteralPath $receipt.backupPath -Algorithm SHA256).Hash
    if ($backupHash -ne $receipt.originalSha256) { throw 'The saved injector backup does not match its recorded hash.' }
    $restoredBytes = [IO.File]::ReadAllBytes($receipt.backupPath)
    if ((Get-BytesSha256 $restoredBytes) -ne $receipt.originalSha256) { throw 'The injector backup changed while being read.' }
    Set-CheckedInjector -Bytes $restoredBytes -ExpectedSha256 $receipt.patchedSha256
    $receipt | Add-Member -NotePropertyName restoredAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
    Write-Output "Restored injector file: $openedPath"
    Write-Output 'Reapply Dream Skin to refresh the running theme. Live activation has not been checked by this script.'
    return
}

if (-not (Test-Path -LiteralPath $modulePath)) { throw "Extension module is missing: $modulePath" }
$originalBytes = [IO.File]::ReadAllBytes($openedPath)
$originalHash = Get-BytesSha256 $originalBytes
$original = [Text.Encoding]::UTF8.GetString($originalBytes)
if ($original.Contains($marker)) {
    Write-Output "The extension hook is already present at: $openedPath"
    Write-Output 'Live activation has not been checked by this script.'
    return
}
$anchor = '  return { ...themeState, payload, revision };'
if ([regex]::Matches($original, [regex]::Escape($anchor)).Count -ne 1 -or -not $original.Contains('export async function loadPayload(')) {
    throw 'This injector version does not match the loadPayload hook. No file was changed.'
}
$moduleUrl = ([Uri]$modulePath).AbsoluteUri | ConvertTo-Json -Compress
$replacement = @'
  // CODEX_COMPANIONS_EXTENSION_START
  let companionPayload = "";
  try {
    const { buildPayload } = await import(__MODULE_URL__);
    companionPayload = "\n;" + await buildPayload();
  } catch (error) {
    console.error(`[dream-skin] companion extension unavailable: ${error.message}`);
  }
  // CODEX_COMPANIONS_EXTENSION_END
  return { ...themeState, payload: payload + companionPayload, revision };
'@
$replacement = $replacement.Replace('__MODULE_URL__', $moduleUrl)
$newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
$replacement = $replacement.Replace("`r`n", "`n").Replace("`n", $newline)
$patched = $original.Replace($anchor, $replacement)
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$backupPath = Join-Path $stateDirectory ("injector-{0}-{1}.mjs.bak" -f [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'), [Guid]::NewGuid().ToString('N').Substring(0, 8))
$patchedBytes = (New-Object Text.UTF8Encoding $false).GetBytes($patched)
$patchedHash = Get-BytesSha256 $patchedBytes
[IO.File]::WriteAllBytes($backupPath, $originalBytes)
try {
    Set-CheckedInjector -Bytes $patchedBytes -ExpectedSha256 $originalHash
    [ordered]@{
        installedAt = [DateTime]::UtcNow.ToString('o')
        requestedPath = $requestedPath
        targetPath = $openedPath
        modulePath = $modulePath
        backupPath = $backupPath
        originalSha256 = $originalHash
        patchedSha256 = $patchedHash
    } | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
} catch {
    if ((Get-FileHash -LiteralPath $openedPath -Algorithm SHA256).Hash -eq $patchedHash) {
        Set-CheckedInjector -Bytes $originalBytes -ExpectedSha256 $patchedHash
    }
    throw
}
Write-Output "Saved injector extension hook: $openedPath"
Write-Output "Original backup: $backupPath"
Write-Output "Receipt: $receiptPath"
Write-Output 'Reapply Dream Skin to load current project assets. Live activation has not been checked by this script.'
} finally {
    Exit-DreamSkinOperationLock -Mutex $operationLock
}
