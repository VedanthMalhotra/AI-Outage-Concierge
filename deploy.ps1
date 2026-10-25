# Updates the live site (https://d22vd18uidf0yz.cloudfront.net) with the code in this folder.
#
#   git pull                                   # get the latest from GitHub first
#   aws sso login --sso-session osu-sandbox    # if your AWS login expired
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#
# Builds the dashboard, packages it with the backend and mock data, uploads the package to S3,
# then tells the EC2 server (via SSM) to install it and restart. Details: docs/04-data-and-aws/hosting.md
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
$Root     = $PSScriptRoot
$Bucket   = "sagemaker-aep-outage-indiansassemble"
$Key      = "deploy/aep-app.zip"
$Instance = "i-08a3da92e46ccadfa"
$Region   = "us-east-2"
$SiteUrl  = "https://d22vd18uidf0yz.cloudfront.net"

$aws = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe" }
if (-not (Test-Path $aws)) { throw "AWS CLI not found. Install it from https://aws.amazon.com/cli/" }

Write-Host "Checking AWS login..."
& $aws sts get-caller-identity --region $Region --output text | Out-Null
if ($LASTEXITCODE -ne 0) { throw "AWS login expired. Run: aws sso login --sso-session osu-sandbox" }

# 1. Build the dashboard (API calls go to the same site, so the base is "/")
if (-not $SkipBuild) {
    Write-Host "Building the dashboard..."
    Push-Location "$Root\web"
    try {
        npm install --no-audit --no-fund   # picks up packages teammates added to package.json
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        $env:VITE_API_BASE = "/"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Dashboard build failed (see errors above)" }
    } finally { Remove-Item Env:VITE_API_BASE -ErrorAction SilentlyContinue; Pop-Location }
}

# 2. Stage the package: backend/ (code + dependency list), site/ (built dashboard + its mock data), mock/ (used by the backend)
$stage = Join-Path $env:TEMP "aep-deploy"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory "$stage\backend", "$stage\site" | Out-Null
Copy-Item "$Root\backend\app" "$stage\backend\app" -Recurse
Copy-Item "$Root\backend\pyproject.toml" "$stage\backend\"
Copy-Item "$Root\web\dist\*" "$stage\site\" -Recurse
Copy-Item "$Root\mock" "$stage\site\mock" -Recurse
Copy-Item "$Root\mock" "$stage\mock" -Recurse
Get-ChildItem $stage -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force

# 3. Zip with forward-slash paths (Linux unzip needs them; Compress-Archive on PowerShell 5 writes backslashes)
$zip = Join-Path $env:TEMP "aep-app.zip"
if (Test-Path $zip) { Remove-Item $zip }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, "Create")
try {
    Get-ChildItem $stage -Recurse -File | ForEach-Object {
        $name = $_.FullName.Substring($stage.Length + 1).Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name) | Out-Null
    }
} finally { $archive.Dispose() }

# 4. Upload and install on the server
Write-Host "Uploading package..."
& $aws s3 cp $zip "s3://$Bucket/$Key" --region $Region --only-show-errors
if ($LASTEXITCODE -ne 0) { throw "Upload failed" }

Write-Host "Installing on the server..."
$cmds = @(
    "aws s3 cp s3://$Bucket/$Key /tmp/aep-app.zip --region $Region --only-show-errors",
    "unzip -oq /tmp/aep-app.zip -d /opt/aep",
    "python3.11 -c `"import tomllib; print(chr(10).join(tomllib.load(open('/opt/aep/backend/pyproject.toml','rb'))['project']['dependencies']))`" > /opt/aep/requirements.txt",
    "/opt/aep/venv/bin/pip install -q -r /opt/aep/requirements.txt",
    "systemctl restart aep"
)
$params = @{ commands = $cmds } | ConvertTo-Json -Compress
$paramFile = Join-Path $env:TEMP "aep-ssm.json"
[System.IO.File]::WriteAllText($paramFile, $params)
$cmdId = & $aws ssm send-command --region $Region --instance-ids $Instance --document-name AWS-RunShellScript `
    --parameters "file://$paramFile" --query Command.CommandId --output text
if ($LASTEXITCODE -ne 0) { throw "Could not reach the server. Is the EC2 instance running? (see hosting.md)" }

do {
    Start-Sleep -Seconds 3
    $status = & $aws ssm get-command-invocation --region $Region --command-id $cmdId --instance-id $Instance --query Status --output text 2>$null
} while ($status -in @("Pending", "InProgress", "Delayed", ""))
if ($status -ne "Success") {
    & $aws ssm get-command-invocation --region $Region --command-id $cmdId --instance-id $Instance --query StandardErrorContent --output text
    throw "Install on the server failed ($status)"
}

# 5. Wait for the app to come back up
Write-Host "Waiting for the site..."
for ($i = 0; $i -lt 20; $i++) {
    try { $h = Invoke-RestMethod "$SiteUrl/health" -TimeoutSec 10; break } catch { Start-Sleep -Seconds 3 }
}
if (-not $h) { throw "Server restarted but $SiteUrl/health is not answering yet. Try again in a minute." }
Write-Host "Done. Live at $SiteUrl  (data: $($h.tables_loaded)/$($h.tables_total) tables loaded)" -ForegroundColor Green
