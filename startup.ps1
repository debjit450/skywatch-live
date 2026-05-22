# SkyWatch Live local setup script.
# Creates local environment files, installs dependencies, starts optional Docker services,
# and runs backend database migrations.

param(
    [switch]$NoDocker = $false
)

$ErrorActionPreference = "Stop"
$rootPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $rootPath "backend"
$frontendPath = Join-Path $rootPath "frontend"

$success = "Green"
$warning = "Yellow"
$errorColor = "Red"
$info = "Cyan"

function Test-Command {
    param([string]$Command)
    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host $Message -ForegroundColor $info
}

function Write-LocalBackendEnv {
    param([bool]$UseDocker)

    $backendEnv = Join-Path $backendPath ".env"
    if (Test-Path -LiteralPath $backendEnv) {
        Write-Host "Backend .env already exists; leaving it unchanged" -ForegroundColor $warning
        return
    }

    $common = @(
        "DJANGO_SECRET_KEY=local-dev-only-change-before-production",
        "DJANGO_DEBUG=True",
        "ALLOWED_HOSTS=localhost,127.0.0.1,[::1]",
        "CSRF_TRUSTED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000",
        "CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000",
        "ALLOW_IN_MEMORY_CHANNEL_LAYER=True",
        "OPENSKY_CLIENT_ID=",
        "OPENSKY_CLIENT_SECRET=",
        "OPENSKY_USERNAME=",
        "OPENSKY_PASSWORD=",
        "LOG_LEVEL=INFO"
    )

    if ($UseDocker) {
        $database = @(
            "DATABASE_URL=postgres://skywatch:skywatch_dev@localhost:5432/skywatch",
            "REDIS_URL=redis://localhost:6379/0"
        )
    } else {
        $database = @(
            "# SQLite and in-memory channels are used when DATABASE_URL and REDIS_URL are omitted."
        )
    }

    ($common[0..5] + $database + $common[6..($common.Length - 1)]) |
        Set-Content -LiteralPath $backendEnv -Encoding UTF8
    Write-Host "Created backend/.env for local development" -ForegroundColor $success
}

function Start-DockerServices {
    Push-Location $rootPath
    try {
        if (Test-Command "docker") {
            & docker compose version *> $null
            if ($LASTEXITCODE -eq 0) {
                & docker compose up -d
                Write-Host "Docker services started with docker compose" -ForegroundColor $success
                return
            }
        }

        if (Test-Command "docker-compose") {
            & docker-compose up -d
            Write-Host "Docker services started with docker-compose" -ForegroundColor $success
            return
        }

        throw "Docker Compose was not found. Install Docker Desktop or rerun npm run startup:nodock."
    } finally {
        Pop-Location
    }
}

Write-Host "SkyWatch Live - Local Setup" -ForegroundColor $info

Write-Step "Checking environment files"
Push-Location $frontendPath
try {
    if (-not (Test-Path -LiteralPath ".env.local") -and (Test-Path -LiteralPath ".env.example")) {
        Copy-Item -LiteralPath ".env.example" -Destination ".env.local"
        Write-Host "Created frontend .env.local from .env.example" -ForegroundColor $success
    } else {
        Write-Host "Frontend .env.local already exists or .env.example is missing" -ForegroundColor $warning
    }
} finally {
    Pop-Location
}
Write-LocalBackendEnv -UseDocker:(-not $NoDocker)

if (-not $NoDocker) {
    Write-Step "Starting Docker services"
    Start-DockerServices
    Start-Sleep -Seconds 5
}

Write-Step "Installing frontend dependencies"
if (-not (Test-Command "npm")) {
    Write-Host "Node.js/npm was not found. Install Node.js 22 or newer." -ForegroundColor $errorColor
    exit 1
}
Push-Location $frontendPath
try {
    npm install
    Write-Host "Frontend dependencies installed" -ForegroundColor $success
} finally {
    Pop-Location
}

Write-Step "Installing backend dependencies"
if (-not (Test-Command "python")) {
    Write-Host "Python was not found. Install Python 3.11 or newer and add it to PATH." -ForegroundColor $errorColor
    exit 1
}

Push-Location $backendPath
try {
    if (-not (Test-Path -LiteralPath "venv")) {
        python -m venv venv
        Write-Host "Created backend virtual environment" -ForegroundColor $success
    }

    $venvPython = Join-Path $backendPath "venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        throw "Virtual environment Python was not found at $venvPython"
    }

    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r requirements.txt
    Write-Host "Backend dependencies installed" -ForegroundColor $success

    Write-Step "Running backend migrations"
    & $venvPython manage.py migrate --noinput
    Write-Host "Database migrations complete" -ForegroundColor $success
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor $success
Write-Host ""
Write-Host "Start both services:" -ForegroundColor $info
Write-Host "  npm run dev-all"
Write-Host ""
Write-Host "Or start services separately:" -ForegroundColor $info
Write-Host "  npm run dev"
Write-Host "  npm run backend:dev"
Write-Host ""
Write-Host "Frontend: http://localhost:5173" -ForegroundColor $success
Write-Host "Backend API: http://localhost:8000/api/v1/" -ForegroundColor $success
