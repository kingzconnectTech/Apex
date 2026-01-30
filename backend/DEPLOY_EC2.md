# Deploying Apex Backend to AWS EC2

**Current Deployment Status:**
- **Public IP:** `54.160.213.128`
- **Status:** Online (Node.js + Nginx)
- **Last Updated:** 2026-01-30
- **Action Required:** Upload `serviceAccountKey.json` for Firebase functionality.

This guide will help you deploy the Apex backend to an AWS EC2 instance.

## Prerequisites
- An AWS Account
- Access to the AWS Console
- The `serviceAccountKey.json` file for Firebase Admin SDK

## Step 1: Launch an EC2 Instance
1.  **Log in** to the AWS Console and navigate to **EC2**.
2.  Click **Launch Instance**.
3.  **Name**: `Apex-Backend`
4.  **AMI (OS)**: Select **Ubuntu** (Ubuntu Server 22.04 LTS or 24.04 LTS).
5.  **Instance Type**: `t2.micro` (Free tier eligible) or `t3.micro`.
6.  **Key Pair**: Create a new key pair (e.g., `apex-key`) and download the `.pem` file. **Keep this safe!**
7.  **Network Settings**:
    *   Create a security group.
    *   Allow **SSH** traffic from "My IP" (for security) or "Anywhere" (0.0.0.0/0).
    *   Allow **HTTP** traffic from the internet.
    *   Allow **HTTPS** traffic from the internet.
8.  **Storage**: Default (8GB) is usually fine, but 20GB is recommended.
9.  Click **Launch Instance**.

## Step 2: Connect to your Instance
1.  Open your terminal (PowerShell or Bash).
2.  Navigate to where you saved your key file (e.g., `cd Downloads`).
3.  Connect using SSH:
    ```bash
    ssh -i "apex-key.pem" ubuntu@54.160.213.128
    ```
    *(Note: On Windows, you might need to adjust permissions for the key file or use Putty, but Windows 10/11 OpenSSH usually works).*

## Step 3: Transfer Code
You can transfer files using `scp` or by cloning from a git repository (recommended).

### Option A: Using SCP (Copy from local machine)
Run this command from your local machine (not the EC2):
```bash
# Zip the backend folder first to make it faster
# Then copy:
scp -i "path/to/apex-key.pem" -r path/to/Apex/backend ubuntu@54.160.213.128:~/apex-backend
```

### Option B: Using Git (Recommended)
1.  Push your code to GitHub/GitLab.
2.  On the EC2 instance:
    ```bash
    git clone <YOUR_REPO_URL>
    cd <REPO_FOLDER>/backend
    ```

## Step 4: Run Setup Script
Once your code is on the server and you are inside the `backend` directory:

1.  Make the script executable:
    ```bash
    chmod +x setup_ec2.sh
    ```
    IMPORTANT: If using the automated deployment, the script might be in `~/apex-backend`.
    ```bash
    cd ~/apex-backend
    ./setup_ec2.sh
    ```
    *This script will update the system, install Node.js, Python, Nginx, and dependencies.*

## Step 5: Configure Secrets
You need to upload your `serviceAccountKey.json` to the server.
1.  From your local machine:
    ```bash
    scp -i "apex-key.pem" path/to/serviceAccountKey.json ubuntu@54.160.213.128:~/apex-backend/serviceAccountKey.json
    ```
    *(Adjust the destination path based on where you put the code).*

## Step 6: Start the Server (Automated)
The updated `setup_ec2.sh` script now automatically:
1.  Starts the application using PM2.
2.  Configures `systemd` to restart the app on server reboot.
3.  Installs `pm2-logrotate` to manage log file sizes.
4.  Saves the process list.

You can verify the status by running:
```bash
pm2 status
```

## Step 7: Access the API
Your API should now be accessible at:
`http://54.160.213.128/`

Test it:
`http://54.160.213.128/` (Should say "Apex API is running")
