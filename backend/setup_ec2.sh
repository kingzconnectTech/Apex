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

# 5. Install PM2 Global and Log Rotation
echo "Installing PM2 process manager..."
sudo npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10


# 6. Install Project Node Dependencies
echo "Installing Node.js project dependencies..."
if [ -d "$HOME/apex-backend" ]; then
    cd "$HOME/apex-backend"
fi

if [ -f "package.json" ]; then
    npm install
else
    echo "Warning: package.json not found in current directory."
fi

# 6. Configure Firewall (UFW)
echo "Configuring Firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full' || echo "Nginx Full profile not found, using fallback ports..."
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
# 9. Start Application with PM2 and Configure Auto-Restart
echo "Starting Application..."
# Stop existing if any (ignore error)
pm2 delete apex-backend 2>/dev/null || true

# Start the application
pm2 start server.js --name apex-backend

# Save the list of processes
pm2 save

# Generate and Execute Startup Script
# This detects the init system (systemd) and configures it to start PM2 on boot
echo "Configuring PM2 to start on system boot..."
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save

echo "=================================================="
echo "Setup Complete!"
echo "=================================================="
echo "Deployment Status:"
echo "1. Backend is RUNNING (Managed by PM2)"
echo "2. Auto-Restart is ENABLED (Systemd)"
echo "3. Log Rotation is ENABLED"
echo ""
echo "To monitor your app:"
echo "   pm2 status"
echo "   pm2 logs"
echo "   pm2 monit"
echo "=================================================="
