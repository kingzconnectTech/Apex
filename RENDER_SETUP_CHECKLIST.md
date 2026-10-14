# Render Deployment Setup Checklist

## Before Deployment

1. ✅ Ensure `Dockerfile` exists in the project root
2. ✅ Ensure `render.yaml` exists in the project root
3. ✅ Push all changes to your Git repository (GitHub/GitLab/Bitbucket)

## Step 1: Deploy to Render

1. Log in to [Render Dashboard](https://dashboard.render.com)
2. Click **New +** → **Blueprint**
3. Connect your repository
4. Render will auto-detect `render.yaml`
5. Click **Apply** to deploy

## Step 2: Configure Environment Variables (REQUIRED)

Navigate to your `apex-xgrw` service → **Environment** → Add the following:

### Firebase (Required)
- **Key:** `FIREBASE_SERVICE_ACCOUNT_JSON`
- **Value:** Paste the entire JSON content of your Firebase service account key file
  - Do NOT remove the curly braces `{}` at the start/end
  - Ensure it's valid JSON (copy from `backend/serviceAccountKey.json`)

### PitchAPI (Required for football)
- **Key:** `PITCHAPI_KEY`
- **Value:** Your PitchAPI key from https://pitchapi.dev
- **Key:** `PITCHAPI_ENABLED`
- **Value:** `true`

### Settlement Authentication (Required)
- **Key:** `SETTLEMENT_CRON_SECRET`
- **Value:** Generate a secure random string
  - Mac/Linux: `openssl rand -base64 32`
  - Windows (PowerShell): `-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})`
  - Or use any password generator - make it long and random

Click **Save Changes** after adding all variables.

## Step 3: Set Up Keep-Alive Monitor (REQUIRED)

Render's free tier sleeps after 15 minutes of inactivity. This will break settlement.

1. Sign up at [UptimeRobot](https://uptimerobot.com/) (free)
2. Create a new **HTTP(s) Monitor**:
   - **Type:** HTTP(s)
   - **URL:** `https://apex-xgrw.onrender.com/health`
   - **Monitoring Interval:** 10 minutes (or 12 minutes to be safe)
   - **Alert Contacts:** Add your email
3. Click **Create Monitor**

This pings `/health` every 10-12 minutes to keep the service alive.

## Step 4: Optional - External Settlement Trigger

If you want more reliable settlement (instead of relying on keep-alive only):

1. In UptimeRobot (or FastCron), create a **Cron Job**:
   - **URL:** `https://apex-xgrw.onrender.com/api/predictions/settle`
   - **Method:** POST
   - **Headers:** `x-settlement-secret: <your SETTLEMENT_CRON_SECRET value>`
   - **Schedule:** Every 5-10 minutes

This ensures settlement runs even if the service temporarily sleeps.

## Step 5: Verify Deployment

### Check health endpoint
```bash
curl https://apex-xgrw.onrender.com/health
```
Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-10-14T...",
  "uptime": 123.45
}
```

### Check settlement health
```bash
curl -H "x-settlement-secret: <your SETTLEMENT_CRON_SECRET>" https://apex-xgrw.onrender.com/api/predictions/settlement-health
```

Check the response:
- ✅ `lastSettlementJobAt` should show a recent timestamp
- ✅ `finishedButPending` should be a low number (and decreasing over time)
- ✅ `settlementJobRunning` should be `false`
- ✅ No errors in the response

Wait 5-10 minutes and run again to confirm `lastSettlementJobAt` advances.

## Step 6: Spot-Check Settled Matches

In your Apex app:

1. Find a finished match with a `pa-*` ID (PitchAPI fixture)
   - Confirm it shows a settlement outcome (✓ won or ✗ lost)
2. Find a finished match with an ESPN ID (numeric)
   - Confirm it shows a settlement outcome (✓ won or ✗ lost)

If both show settled correctly, your setup is working!

## Troubleshooting

### Settlement not running
- Check if keep-alive monitor is active (UptimeRobot should show "Up")
- Verify `SETTLEMENT_CRON_SECRET` is set correctly in Render
- Check Render logs for any errors

### Matches not settling
- Ensure `FIREBASE_SERVICE_ACCOUNT_JSON` is valid JSON (check for missing quotes/braces)
- Verify `PITCHAPI_KEY` is set for `pa-*` matches
- Check if match stats are available from the provider

### Service keeps sleeping
- Reduce UptimeRobot interval to 10 minutes
- Add the external settlement trigger (Step 4)
- Consider upgrading to a paid Render plan that doesn't sleep

## Environment Variables Summary

| Variable | Required? | Purpose |
|----------|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | ✅ Yes | Firebase Admin SDK auth |
| `PITCHAPI_KEY` | ✅ Yes | Football secondary provider |
| `PITCHAPI_ENABLED` | ✅ Yes | Enable PitchAPI |
| `SETTLEMENT_CRON_SECRET` | ✅ Yes | Protect settlement endpoints |
| `NODE_ENV` | ✅ Auto | Set to `production` by render.yaml |
| `PORT` | ✅ Auto | Set to `3000` by render.yaml |
