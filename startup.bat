@echo off
setlocal

echo.
echo ========================================
echo   SkyWatch Live - Local Launcher
echo ========================================
echo.
echo 1. First-time setup with Docker
echo 2. First-time setup without Docker
echo 3. Start frontend and backend
echo 4. Start frontend only
echo 5. Start backend only
echo 6. Exit
echo.

set /p choice="Enter your choice (1-6): "

if "%choice%"=="1" (
    call npm run startup
) else if "%choice%"=="2" (
    call npm run startup:nodock
) else if "%choice%"=="3" (
    call npm run dev-all
) else if "%choice%"=="4" (
    call npm run dev
) else if "%choice%"=="5" (
    call npm run backend:dev
) else if "%choice%"=="6" (
    exit /b 0
) else (
    echo Invalid choice.
    exit /b 1
)

pause
