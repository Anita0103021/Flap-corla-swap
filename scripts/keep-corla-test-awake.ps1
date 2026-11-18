param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9-]{5,95}$')][string]$RunId,
    [Parameter(Mandatory = $true)][int]$WorkerPid
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path (Join-Path $PSScriptRoot '..\reports\snipe-adversarial') $RunId
$manifest = Get-Content -LiteralPath (Join-Path $dir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.runId -ne $RunId -or $manifest.mode -ne 'offline_adversarial' -or $manifest.status -ne 'RUNNING' -or $manifest.pid -ne $WorkerPid) {
    throw 'Worker identity or run state did not match.'
}
$worker = Get-Process -Id $WorkerPid
if ($worker.ProcessName -ne 'node') { throw 'Unexpected worker process.' }
$until = [DateTimeOffset]::Parse([string]$manifest.until)
if ($until -le [DateTimeOffset]::UtcNow -or ($until - [DateTimeOffset]::UtcNow).TotalHours -gt 24) {
    throw 'Wake request needs a valid deadline within 24 hours.'
}

# One thread owns and releases the request. No power plan, display, lock
# screen, start-up configuration, or operating-system setting is changed.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public static class CorlaTestAwake {
    const uint Continuous = 0x80000000;
    const uint SystemRequired = 0x00000001;
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint SetThreadExecutionState(uint flags);

    public static void Hold(Process worker, DateTimeOffset until, string logPath) {
        if (worker.HasExited || DateTimeOffset.UtcNow >= until) return;
        if (SetThreadExecutionState(Continuous | SystemRequired) == 0)
            throw new InvalidOperationException("Windows denied the transient system-awake request.");
        try {
            File.AppendAllText(logPath, DateTimeOffset.UtcNow.ToString("o") + " awake-requested\n");
            while (DateTimeOffset.UtcNow < until) {
                int wait = (int)Math.Max(1, Math.Min(2000, (until - DateTimeOffset.UtcNow).TotalMilliseconds));
                if (worker.WaitForExit(wait)) break;
            }
        } finally {
            SetThreadExecutionState(Continuous);
            File.AppendAllText(logPath, DateTimeOffset.UtcNow.ToString("o") + " awake-released\n");
        }
    }
}
'@
try { [CorlaTestAwake]::Hold($worker, $until, (Join-Path $dir 'wake-guard.log')) }
finally { $worker.Dispose() }
