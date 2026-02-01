Write-Host "Building Release App Bundle (.aab)..."

if (Test-Path ".\gradlew.bat") {
    Write-Host "Already in android directory."
    .\gradlew.bat bundleRelease
} elseif (Test-Path ".\android\gradlew.bat") {
    Write-Host "Changing to android directory..."
    Push-Location android
    .\gradlew.bat bundleRelease
    Pop-Location
} else {
    Write-Error "Could not find gradlew.bat. Please run this script from 'frontend' or 'frontend/android' directory."
    exit 1
}

Write-Host "Build complete!"
Write-Host "You can find the App Bundle (.aab) in: android\app\build\outputs\bundle\release\app-release.aab"
Write-Host "This file is optimized for Google Play Store publishing."
