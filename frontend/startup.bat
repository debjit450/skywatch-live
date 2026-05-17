@echo off
REM SkyWatch Live - Quick Startup Launcher

setlocal enabledelayedexpansion

echo.
echo ========================================
echo   SkyWatch Live - Startup Launcher
echo ========================================
echo.
echo Choose an option:
echo.
echo 1. First-time setup (recommended)
echo 2. Start all services (frontend + backend)
echo 3. Frontend only
echo 4. Backend only
echo 5. Setup only (no auto-start)
echo 6. Exit
echo.
set /p choice="Enter your choice (1-6): "

if "%choice%"=="1" (
    echo Starting complete setup...
    call npm run startup
) else if "%choice%"=="2" (
    echo Starting frontend and backend...
    call npm run dev-all
) else if "%choice%"=="3" (
    echo Starting frontend only...
    call npm run dev
) else if "%choice%"=="4" (
    echo Starting backend only...
    call npm run backend-dev
) else if "%choice%"=="5" (
    echo Running setup...
    call npm run startup:nodock
) else if "%choice%"=="6" (
    exit /b 0
) else (
    echo Invalid choice
    exit /b 1
)

pause
