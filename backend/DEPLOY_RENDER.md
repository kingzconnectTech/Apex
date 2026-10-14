# Deploying Apex Backend to Render

This guide will help you migrate the backend from AWS EC2 to Render.

## Prerequisites
- A Render account (Sign up at [render.com](https://render.com)).
- Your code pushed to a GitHub, GitLab, or Bitbucket repository.
- The contents of your `serviceAccountKey.json` for Firebase Admin SDK.

## Deployment Steps

### Step 1: Push Changes to Git
Make sure you've pushed all the recent changes to your repository, including:
- `Dockerfile` (in the root)
- `render.yaml` (in the root)
- Updated `backend/server.js`

### Step 2: Create a New Blueprint on Render
1.  Log in to the [Render Dashboard](https://dashboard.render.com).
2.  Click **New +** and select **Blueprint**.
3.  Connect your GitHub/GitLab/Bitbucket repository.
4.  Render will automatically detect the `render.yaml` file.
5.  Click **Apply**.

### Step 3: Configure Environment Variables
1.  Once the Blueprint is created, navigate to the `apex-xgrw` service.
2.  Go to **Environment**.
3.  Add the following environment variables:

    **Required for Firebase:**
    - **Key:** `FIREBASE_SERVICE_ACCOUNT_JSON`
    - **Value:** Paste the entire content of your `serviceAccountKey.json` file (including the braces).

    **Required for PitchAPI (football provider):**
    - **Key:** `PITCHAPI_KEY`
    - **Value:** Your PitchAPI key from https://pitchapi.dev
    - **Key:** `PITCHAPI_ENABLED`
    - **Value:** `true`

    **Required for settlement cron authentication:**
    - **Key:** `SETTLEMENT_CRON_SECRET`
    - **Value:** Generate a long random string (e.g., use `openssl rand -base64 32`) - this protects the settlement endpoints

4.  Click **Save Changes**.

### Step 4: Verify Deployment
1.  Render will automatically start a new build.
2.  Once the build is complete, you should see "Live" status.
3.  You can access your API at `https://apex-xgrw.onrender.com/`.

## Step 5: Prevent Service Sleeping (Keep-Alive)
Render's free tier spins down services after 15 minutes of inactivity. Settlement runs as an **in-process** cron (`node-cron` every 5 minutes) inside the web service — if the dyno sleeps, predictions stay Pending.

Set up an external monitor to keep the service awake **and** optionally trigger settlement:

1.  Sign up for a free account at [UptimeRobot](https://uptimerobot.com/) or [FastCron](https://www.fastcron.com/).
2.  Create a new **HTTP(s) Monitor** to: `https://apex-xgrw.onrender.com/health` every **10–12 minutes**.
    - This keeps the service alive so the in-process cron jobs can run.
3.  **Optional** - External settlement trigger (recommended if keep-alive is unreliable):
    - Create a second scheduled HTTP request (every 5–10 minutes):
    - **URL:** `https://apex-xgrw.onrender.com/api/predictions/settle`
    - **Method:** POST
    - **Header:** `x-settlement-secret: <your SETTLEMENT_CRON_SECRET value>`
4.  **Verify settlement health** after deployment:
    - Run: `curl -H "x-settlement-secret: <your SETTLEMENT_CRON_SECRET>" https://apex-xgrw.onrender.com/api/predictions/settlement-health`
    - Confirm `lastSettlementJobAt` advances and `finishedButPending` count drops over time.

## Why Docker?
We use a Docker-based deployment on Render because the backend requires both **Node.js** (for the main server) and **Python 3** (for the prediction engine) along with specialized libraries like `pandas` and `numpy`. Docker ensures all these dependencies are correctly installed in the environment.

## Troubleshooting
- If the build fails, check the **Events** and **Logs** in the Render dashboard.
- Ensure the `PORT` is set to `3000` (Render handles the external mapping automatically).
- Make sure the `FIREBASE_SERVICE_ACCOUNT_JSON` is valid JSON.

## Post-Deployment Verification

After deployment, verify the setup:

1. **Health check:**
   ```bash
   curl https://apex-xgrw.onrender.com/health
   ```
   Should return: `{"status":"ok","timestamp":"...","uptime":...}`

2. **Settlement health check:**
   ```bash
   curl -H "x-settlement-secret: <your SETTLEMENT_CRON_SECRET>" https://apex-xgrw.onrender.com/api/predictions/settlement-health
   ```
   Check that:
   - `lastSettlementJobAt` shows a recent timestamp
   - `finishedButPending` count is low or decreasing
   - `settlementJobRunning` is `false`

3. **Spot-check settled matches:**
   - Find a finished `pa-*` match (PitchAPI ID) in the app
   - Find a finished ESPN match
   - Confirm both show settlement outcomes (✓/✗) in the UI
