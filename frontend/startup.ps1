# SkyWatch Live - Complete Startup Script
# Automates all setup and startup steps

param(
    [switch]$NoDocker = $false
)

$ErrorActionPreference = "Stop"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "🚀 SkyWatch Live - Starting up..." -ForegroundColor Cyan

# Colors for output
$success = "Green"
$warning = "Yellow"
$error = "Red"
$info = "Cyan"

# Check for required tools
function Test-Command {
    param($Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

# Step 1: Docker services
if (-not $NoDocker) {
    Write-Host "`n📦 Starting Docker services..." -ForegroundColor $info
    if (Test-Command docker-compose) {
        Push-Location $scriptPath
        docker-compose up -d
        Write-Host "✓ Docker services started" -ForegroundColor $success
        Pop-Location
        Start-Sleep -Seconds 3
    } else {
        Write-Host "⚠ Docker not found. Please start Docker manually or run: docker-compose up -d" -ForegroundColor $warning
    }
}

# Step 2: Frontend setup
Write-Host "`n📚 Setting up frontend..." -ForegroundColor $info
if (Test-Command npm) {
    Push-Location $scriptPath
    npm install
    Write-Host "✓ Frontend dependencies installed" -ForegroundColor $success
    Pop-Location
} else {
    Write-Host "✗ Node.js/npm not found. Please install Node.js from https://nodejs.org/" -ForegroundColor $error
    exit 1
}

# Step 3: Backend setup
Write-Host "`n🐍 Setting up backend..." -ForegroundColor $info
if (Test-Command python) {
    $backendPath = Join-Path $scriptPath "backend"
    Push-Location $backendPath
    
    # Create virtual environment if it doesn't exist
    if (-not (Test-Path "venv")) {
        Write-Host "  Creating virtual environment..." -ForegroundColor $info
        python -m venv venv
    }
    
    # Activate venv
    & ".\venv\Scripts\Activate.ps1"
    
    # Install dependencies
    Write-Host "  Installing backend dependencies..." -ForegroundColor $info
    pip install -q -r requirements.txt
    
    # Run migrations
    Write-Host "  Running database migrations..." -ForegroundColor $info
    python manage.py migrate --noinput
    
    Write-Host "✓ Backend setup complete" -ForegroundColor $success
    Pop-Location
} else {
    Write-Host "✗ Python not found. Please install Python from https://www.python.org/" -ForegroundColor $error
    exit 1
}

# Step 4: Environment files
Write-Host "`n⚙️  Checking environment files..." -ForegroundColor $info

# Check frontend env
if (-not (Test-Path ".env.local")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env.local"
        Write-Host "✓ Created .env.local from .env.example" -ForegroundColor $success
    }
}

# Check backend env
$backendEnv = Join-Path $scriptPath "backend\.env"
if (-not (Test-Path $backendEnv)) {
    if (Test-Path (Join-Path $scriptPath "backend\.env.example")) {
        Copy-Item (Join-Path $scriptPath "backend\.env.example") $backendEnv
        Write-Host "✓ Created backend/.env from backend/.env.example" -ForegroundColor $success
    }
}

# Summary
Write-Host "`n" -ForegroundColor $success
Write-Host "════════════════════════════════════════════" -ForegroundColor $success
Write-Host "✅ Setup complete! Next steps:" -ForegroundColor $success
Write-Host "════════════════════════════════════════════" -ForegroundColor $success

Write-Host "`nStart the development servers:
  
  Option 1 - Run all services (recommended):
  PS> npm run dev-all

  Option 2 - Run services individually in separate terminals:
  Terminal 1 (Frontend):
    PS> npm run dev

  Terminal 2 (Backend):
    PS> npm run backend-dev

" -ForegroundColor $info

Write-Host "🌐 Frontend will be available at: http://localhost:5173" -ForegroundColor $success
Write-Host "🔧 Backend will be available at: http://localhost:8000" -ForegroundColor $success
