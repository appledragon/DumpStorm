@echo off
setlocal enabledelayedexpansion

:: Colors for output (Windows 10+)
set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "NC=[0m"

:: Check if version is provided
if "%~1"=="" (
    echo %RED%[ERROR]%NC% Please provide a version number ^(e.g., 1.0.1^)
    echo Usage: %~nx0 ^<version^> [--prerelease]
    echo Example: %~nx0 1.0.1
    echo Example: %~nx0 1.1.0-beta.1 --prerelease
    exit /b 1
)

set "VERSION=%~1"
set "PRERELEASE=false"

if "%~2"=="--prerelease" (
    set "PRERELEASE=true"
)

:: Basic version validation
echo %VERSION% | findstr /r "^[0-9]*\.[0-9]*\.[0-9]*" >nul
if errorlevel 1 (
    echo %RED%[ERROR]%NC% Invalid version format. Use semantic versioning ^(e.g., 1.0.1 or 1.1.0-beta.1^)
    exit /b 1
)

:: Check current branch
for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD') do set "CURRENT_BRANCH=%%i"
if not "%CURRENT_BRANCH%"=="main" (
    echo %YELLOW%[WARNING]%NC% You're not on the main branch. Current branch: %CURRENT_BRANCH%
    set /p "confirm=Do you want to continue? (y/N): "
    if /i not "!confirm!"=="y" (
        echo %GREEN%[INFO]%NC% Aborted by user
        exit /b 1
    )
)

:: Check for uncommitted changes
git diff-index --quiet HEAD -- 2>nul
if errorlevel 1 (
    echo %RED%[ERROR]%NC% You have uncommitted changes. Please commit or stash them first.
    exit /b 1
)

echo %GREEN%[INFO]%NC% Preparing release v%VERSION%...

:: Update package.json version
echo %GREEN%[INFO]%NC% Updating package.json version to %VERSION%
call npm version %VERSION% --no-git-tag-version
if errorlevel 1 (
    echo %RED%[ERROR]%NC% Failed to update package.json version
    exit /b 1
)

:: Build and test
echo %GREEN%[INFO]%NC% Building the extension...
call npm run compile
if errorlevel 1 (
    echo %RED%[ERROR]%NC% Build failed
    exit /b 1
)

:: Create git commit
echo %GREEN%[INFO]%NC% Creating git commit...
git add package.json
git commit -m "chore: bump version to v%VERSION%"
if errorlevel 1 (
    echo %RED%[ERROR]%NC% Failed to create git commit
    exit /b 1
)

:: Create and push tag
set "TAG=v%VERSION%"
echo %GREEN%[INFO]%NC% Creating and pushing tag %TAG%...
git tag %TAG%
git push origin main
git push origin %TAG%
if errorlevel 1 (
    echo %RED%[ERROR]%NC% Failed to push tag
    exit /b 1
)

echo %GREEN%[INFO]%NC% Release process initiated!
echo %GREEN%[INFO]%NC% Tag %TAG% has been pushed to GitHub.
echo %GREEN%[INFO]%NC% GitHub Actions will now:
echo %GREEN%[INFO]%NC%   1. Create a GitHub Release
echo %GREEN%[INFO]%NC%   2. Build and attach the .vsix file
if "%PRERELEASE%"=="true" (
    echo %GREEN%[INFO]%NC%   3. Mark as pre-release
)

echo.
echo %GREEN%[INFO]%NC% Next steps:
echo %GREEN%[INFO]%NC%   1. Check the GitHub Actions progress at: https://github.com/appledragon/DumpStorm/actions
echo %GREEN%[INFO]%NC%   2. Review the created release at: https://github.com/appledragon/DumpStorm/releases
echo %GREEN%[INFO]%NC%   3. Manually trigger 'Publish to Marketplace' workflow if needed

echo.
echo %GREEN%[INFO]%NC% Release v%VERSION% completed successfully! 🎉

endlocal
