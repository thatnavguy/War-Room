$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$port = 4073
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    $portSetting = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)\s*$' |
        Select-Object -First 1
    if ($portSetting -and $portSetting.Matches[0].Groups[1].Success) {
        $port = [int]$portSetting.Matches[0].Groups[1].Value
    }
}
$dashboardUrl = "http://localhost:$port"
$configUrl = "http://127.0.0.1:$port/api/config"

function Test-Dashboard {
    try {
        $response = Invoke-RestMethod -Uri $configUrl -TimeoutSec 5
        return $null -ne $response.PSObject.Properties['configured']
    } catch {
        return $false
    }
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or
    -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js and npm are required. Install Node.js, then run this script again.'
    exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host 'Installing dashboard packages. This can take a few minutes.'
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Package installation failed. Check the message above and try again.'
        exit 1
    }
}

if (-not (Test-Dashboard)) {
    Write-Host "Starting War Room on port $port..."
    $logDirectory = Join-Path $PSScriptRoot 'data'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $outputLog = Join-Path $logDirectory 'dashboard-output.log'
    $errorLog = Join-Path $logDirectory 'dashboard-error.log'
    $server = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList @('/d', '/c', 'npm start') `
        -WorkingDirectory $PSScriptRoot `
        -RedirectStandardOutput $outputLog `
        -RedirectStandardError $errorLog `
        -PassThru

    $started = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Dashboard) {
            $started = $true
            break
        }
        if ($server.HasExited) {
            $details = (Get-Content -LiteralPath $errorLog -Tail 25) -join [Environment]::NewLine
            Write-Error "The dashboard stopped before it was ready. See $errorLog and $outputLog for details.`n$details"
            exit 1
        }
        Start-Sleep -Seconds 1
    }

    if (-not $started) {
        Write-Error "The dashboard did not respond at $dashboardUrl. See $errorLog and $outputLog for details."
        exit 1
    }
}

Start-Process $dashboardUrl
Write-Host "War Room is open at $dashboardUrl"
