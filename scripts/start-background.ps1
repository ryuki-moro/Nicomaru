param(
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$logDir = Join-Path $env:LOCALAPPDATA 'Nicomaru\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$created = $false
$mutex = [Threading.Mutex]::new($true, 'Local\Nicomaru.AutoStart', [ref]$created)
if (-not $created) {
    $mutex.Dispose()
    exit 0
}

try {
    foreach ($required in @($NodePath, '.env.local', '.env.ai-worker', '.env.dev-admin.json', 'node_modules\tsx')) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "起動に必要なファイルがありません: $required"
        }
    }
    $services = @(
        @{ Name = 'app'; Arguments = @('--import', 'tsx', 'scripts/dev-admin.mts'); Process = $null },
        @{ Name = 'worker'; Arguments = @('--env-file=.env.ai-worker', '--import', 'tsx', 'worker/ai-worker.ts'); Process = $null }
    )
    while ($true) {
        foreach ($service in $services) {
            if ($null -eq $service.Process -or $service.Process.HasExited) {
                try {
                    $service.Process = Start-Process -FilePath $NodePath -ArgumentList $service.Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$($service.Name).stdout.log") -RedirectStandardError (Join-Path $logDir "$($service.Name).stderr.log") -PassThru
                    Add-Content -LiteralPath (Join-Path $logDir 'autostart.log') -Value "$(Get-Date -Format o) $($service.Name) started PID=$($service.Process.Id)"
                } catch {
                    Add-Content -LiteralPath (Join-Path $logDir 'autostart.log') -Value "$(Get-Date -Format o) $($service.Name) start failed"
                }
            }
        }
        Start-Sleep -Seconds 30
    }
} catch {
    Add-Content -LiteralPath (Join-Path $logDir 'autostart.log') -Value "$(Get-Date -Format o) startup failed: $($_.Exception.Message)"
    exit 1
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
