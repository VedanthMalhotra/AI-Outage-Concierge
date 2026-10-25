<#
.SYNOPSIS
  Start the AI Outage Concierge dev servers: FastAPI backend (port 8000) and Vite dashboard (port 5173).

.DESCRIPTION
  Works whether or not npm / uv are on PATH. First run installs what is missing:
    - web/node_modules  (npm install)
    - backend/.venv     (only when uv is not installed; deps read from backend/pyproject.toml)
  Each server opens in its own window so its logs stay visible. Close a window to stop that server.

  Backend data source:
    - backend/_data (or -LocalData) if present -> reads parquet locally, no AWS needed
    - otherwise S3, which needs an active AWS SSO session:  aws sso login --sso-session osu-sandbox

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\dev.ps1
  powershell -ExecutionPolicy Bypass -File .\dev.ps1 -FrontendOnly
  powershell -ExecutionPolicy Bypass -File .\dev.ps1 -LocalData C:\path\to\processed
#>
param(
    [switch]$FrontendOnly,
    [switch]$BackendOnly,
    [string]$LocalData,
    [int]$BackendPort = 8000
)

$ErrorActionPreference = "Stop"
$root    = $PSScriptRoot
$web     = Join-Path $root "web"
$backend = Join-Path $root "backend"

function Find-Exe([string]$name, [string[]]$fallbacks) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($f in $fallbacks) { if (Test-Path $f) { return $f } }
    return $null
}

function Test-PortInUse([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------- backend
function Start-Backend {
    if (Test-PortInUse $BackendPort) {
        Write-Host "[backend] port $BackendPort is already in use - assuming the backend is running." -ForegroundColor Yellow
        return
    }

    # data source: local parquet if available, otherwise S3 via the AWS profile
    $dataDir = $LocalData
    if (-not $dataDir -and (Test-Path (Join-Path $backend "_data"))) { $dataDir = Join-Path $backend "_data" }
    if ($dataDir) {
        $env:AEP_LOCAL_DATA_DIR = (Resolve-Path $dataDir).Path
        Write-Host "[backend] reading local data: $env:AEP_LOCAL_DATA_DIR"
    } else {
        Write-Host "[backend] reading from S3 - needs an active AWS SSO session (aws sso login --sso-session osu-sandbox)."
        $awsConfig = Join-Path $env:USERPROFILE ".aws\config"
        if (-not (Test-Path $awsConfig) -and -not $env:AWS_ACCESS_KEY_ID) {
            Write-Host "[backend] note: no AWS config found (~/.aws/config); S3 calls will fail. Set up SSO or use -LocalData / backend/_data to run offline." -ForegroundColor Yellow
        }
    }

    $uvicornArgs = @("-m", "uvicorn", "app.main:app", "--reload", "--port", "$BackendPort")
    $uv = Find-Exe "uv" @("$env:USERPROFILE\.local\bin\uv.exe", "$env:USERPROFILE\.cargo\bin\uv.exe")
    if ($uv) {
        Write-Host "[backend] starting with uv on port $BackendPort"
        Start-Process -FilePath $uv -ArgumentList (@("run", "uvicorn", "app.main:app", "--reload", "--port", "$BackendPort")) -WorkingDirectory $backend
        return
    }

    # no uv: use (or create) backend/.venv
    $venvPy = Join-Path $backend ".venv\Scripts\python.exe"
    if (-not (Test-Path $venvPy)) {
        $py = Find-Exe "python" @()
        if (-not $py) { throw "[backend] neither uv nor python was found. Install Python 3.10+ or uv." }
        Write-Host "[backend] first run: creating backend/.venv and installing dependencies (a few minutes)..."
        & $py -m venv (Join-Path $backend ".venv")
        $deps = & $venvPy -c "import tomllib; print('\n'.join(tomllib.load(open(r'$backend\pyproject.toml','rb'))['project']['dependencies']))"
        & $venvPy -m pip install --quiet --upgrade pip
        & $venvPy -m pip install --quiet @($deps -split "`n" | Where-Object { $_.Trim() })
        if ($LASTEXITCODE -ne 0) { throw "[backend] dependency install failed - see the output above." }
    }
    Write-Host "[backend] starting with backend/.venv on port $BackendPort"
    Start-Process -FilePath $venvPy -ArgumentList $uvicornArgs -WorkingDirectory $backend
}

# ---------------------------------------------------------------- frontend
function Start-Frontend {
    $node = Find-Exe "node" @("$env:ProgramFiles\nodejs\node.exe")
    if (-not $node) { throw "[web] Node.js not found. Install Node 18+ from https://nodejs.org" }
    $nodeDir = Split-Path $node
    $vite = Join-Path $web "node_modules\vite\bin\vite.js"

    if (-not (Test-Path $vite)) {
        $npm = Find-Exe "npm.cmd" @((Join-Path $nodeDir "npm.cmd"))
        if (-not $npm) { throw "[web] npm not found next to node ($nodeDir)." }
        Write-Host "[web] first run: npm install..."
        Push-Location $web
        try { & $npm install; if ($LASTEXITCODE -ne 0) { throw "[web] npm install failed - see the output above." } }
        finally { Pop-Location }
    }
    Write-Host "[web] starting Vite (opens http://localhost:5173/web/index.html, or the next free port)"
    Start-Process -FilePath $node -ArgumentList "`"$vite`"" -WorkingDirectory $web
}

if (-not $FrontendOnly) { Start-Backend }
if (-not $BackendOnly)  { Start-Frontend }

Write-Host ""
Write-Host "Backend docs: http://127.0.0.1:$BackendPort/docs   |   Dashboard: http://localhost:5173/web/index.html" -ForegroundColor Green
Write-Host "Each server runs in its own window - close it to stop that server."
