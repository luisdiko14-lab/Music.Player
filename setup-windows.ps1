$ErrorActionPreference = "Stop"

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "WinGet is required. Install or update App Installer from the Microsoft Store, then run this script again."
}

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Git for Windows through WinGet..."
    & winget.exe install --id Git.Git --exact --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Git installation failed with exit code $LASTEXITCODE."
    }
}

$python312Available = $false
if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    & py.exe -3.12 --version *> $null
    $python312Available = $LASTEXITCODE -eq 0
}

if (-not $python312Available) {
    Write-Host "Installing Python 3.12 through WinGet..."
    & winget.exe install --id Python.Python.3.12 --exact --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.12 installation failed with exit code $LASTEXITCODE."
    }
}

Write-Host "Git and Python 3.12 are ready. Open a new terminal so PATH updates are available."