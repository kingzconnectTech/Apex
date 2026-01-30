#!/bin/bash

# Exit on error
set -e

echo "Starting Apex Backend Setup..."

# 1. Update and Upgrade System
echo "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# 2. Install Required Tools
echo "Installing essential tools..."
sudo apt install -y curl git unzip build-essential

# 3. Install Node.js (LTS Version - v20 recommended for Firebase)
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 4. Install Python 3 and Dependencies
# Using apt for system-wide python packages is cleaner on Ubuntu than pip global install
echo "Installing Python and dependencies..."
sudo apt install -y python3 python3-pip python3-venv python3-pandas python3-numpy python3-requests python-is-python3

# 5. Install PM2 Global
echo "Installing PM2 process manager..."
sudo npm install -g pm2

# 6. Install Project Node Dependencies
echo "Installing Node.js project dependencies..."
if [ -f "package.json" ]; then
    npm install
else
    echo "Warning: package.json not found in current directory."
fi

# 7. Setup Firewall (UFW)
echo "Configuring Firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
# Fallback if 'Nginx Full' profile is missing (common on minimal installs)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Enable UFW if not already enabled (be careful not to lock yourself out, usually safe on EC2 if SSH allowed)
sudo ufw --force enable 

# 8. Install and Configure Nginx
echo "Installing and Configuring Nginx..."
sudo apt install -y nginx

# Create Nginx Config for Proxying Port 3000
# We use a heredoc to write the config file
sudo bash -c 'cat > /etc/nginx/sites-available/apex-backend <<EOF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF'

# Enable the site
if [ -L /etc/nginx/sites-enabled/default ]; then
    sudo rm /etc/nginx/sites-enabled/default
fi
sudo ln -sf /etc/nginx/sites-available/apex-backend /etc/nginx/sites-enabled/

# Test and Restart Nginx
sudo nginx -t
sudo systemctl restart nginx

echo "=================================================="
echo "Setup Complete!"
echo "=================================================="
echo "Next Steps:"
echo "1. Upload your 'serviceAccountKey.json' to the backend directory."
echo "2. Start the application with PM2:"
echo "   pm2 start server.js --name apex-backend"
echo "   pm2 save"
echo "   pm2 startup"
echo "=================================================="
