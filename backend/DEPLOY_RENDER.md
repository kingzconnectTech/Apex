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
3.  Add a new environment variable:
    - **Key:** `FIREBASE_SERVICE_ACCOUNT_JSON`
    - **Value:** Paste the entire content of your `serviceAccountKey.json` file.
4.  Click **Save Changes**.

### Step 4: Verify Deployment
1.  Render will automatically start a new build.
2.  Once the build is complete, you should see "Live" status.
3.  You can access your API at `https://apex-xgrw.onrender.com/`.

## Why Docker?
We use a Docker-based deployment on Render because the backend requires both **Node.js** (for the main server) and **Python 3** (for the prediction engine) along with specialized libraries like `pandas` and `numpy`. Docker ensures all these dependencies are correctly installed in the environment.

## Troubleshooting
- If the build fails, check the **Events** and **Logs** in the Render dashboard.
- Ensure the `PORT` is set to `3000` (Render handles the external mapping automatically).
- Make sure the `FIREBASE_SERVICE_ACCOUNT_JSON` is valid JSON.
