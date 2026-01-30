# First time build requires interaction to generate Keystore
# Run this script in PowerShell

Write-Host "Starting Android Build..."
Write-Host "Note: If asked to generate a new Keystore, please select 'Y' (Yes)."

eas build --platform android --profile preview
