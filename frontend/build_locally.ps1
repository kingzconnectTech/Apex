Write-Host "Building Optimized Release APKs locally..."

if (Test-Path ".\gradlew.bat") {
    Write-Host "Already in android directory."
    .\gradlew.bat assembleRelease
} elseif (Test-Path ".\android\gradlew.bat") {
    Write-Host "Changing to android directory..."
    Push-Location android
    .\gradlew.bat assembleRelease
    Pop-Location
} else {
    Write-Error "Could not find gradlew.bat. Please run this script from 'frontend' or 'frontend/android' directory."
    exit 1
}

Write-Host "Build complete!"
Write-Host "You can find the optimized APKs in: android\app\build\outputs\apk\release"
Write-Host "There should be separate APKs for each architecture (arm64-v8a, armeabi-v7a, etc.)"
Write-Host "Pick the one matching your device (usually arm64-v8a for modern phones) for the smallest size."
