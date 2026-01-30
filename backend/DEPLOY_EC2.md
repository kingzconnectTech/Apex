# Deploying Apex Backend to AWS EC2

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
    ssh -i "apex-key.pem" ubuntu@<YOUR-EC2-PUBLIC-IP>
    ```
    *(Note: On Windows, you might need to adjust permissions for the key file or use Putty, but Windows 10/11 OpenSSH usually works).*

## Step 3: Transfer Code
You can transfer files using `scp` or by cloning from a git repository (recommended).

### Option A: Using SCP (Copy from local machine)
Run this command from your local machine (not the EC2):
```bash
# Zip the backend folder first to make it faster
# Then copy:
scp -i "path/to/apex-key.pem" -r path/to/Apex/backend ubuntu@<YOUR-EC2-PUBLIC-IP>:~/apex-backend
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
2.  Run the script:
    ```bash
    ./setup_ec2.sh
    ```
    *This script will update the system, install Node.js, Python, Nginx, and dependencies.*

## Step 5: Configure Secrets
You need to upload your `serviceAccountKey.json` to the server.
1.  From your local machine:
    ```bash
    scp -i "apex-key.pem" path/to/serviceAccountKey.json ubuntu@<YOUR-EC2-PUBLIC-IP>:~/apex-backend/backend/serviceAccountKey.json
    ```
    *(Adjust the destination path based on where you put the code).*

## Step 6: Start the Server
1.  Back on the EC2 instance, inside the backend directory:
    ```bash
    pm2 start server.js --name apex-backend
    ```
2.  Check status:
    ```bash
    pm2 status
    pm2 logs
    ```
3.  Make it start automatically on reboot:
    ```bash
    pm2 startup
    pm2 save
    ```

## Step 7: Access the API
Your API should now be accessible at:
`http://<YOUR-EC2-PUBLIC-IP>/`

Test it:
`http://<YOUR-EC2-PUBLIC-IP>/api/predict` (Postman/Curl)
