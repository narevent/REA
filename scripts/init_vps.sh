#!/bin/bash
set -e

echo "================================"
echo "rea VPS Initialization"
echo "================================"

# Update system
echo "Updating system packages..."
sudo apt update
sudo apt upgrade -y

# Install required packages
echo "Installing required packages..."
sudo apt install -y \
    python3 \
    python3-pip \
    python3-venv \
    nginx \
    git \
    certbot \
    python3-certbot-nginx \
    ufw \
    curl \
    wget \
    htop \
    vim

# Configure firewall
echo "Configuring firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
sudo ufw logging off

echo "Firewall status:"
sudo ufw status

# Create GitHub deploy key (optional but recommended)
echo ""
echo "================================"
echo "GitHub Deploy Key Setup"
echo "================================"
echo "Do you want to create an SSH key for GitHub? (y/n)"
read -r create_key

if [ "$create_key" = "y" ]; then
    if [ ! -f ~/.ssh/id_rsa ]; then
        ssh-keygen -t rsa -b 4096 -C "deploy@rea.vetgaaf.tech" -f ~/.ssh/id_rsa -N ""
        echo ""
        echo "SSH public key created. Add this to your GitHub repository's Deploy Keys:"
        echo "https://github.com/YOUR_USERNAME/YOUR_REPO/settings/keys"
        echo ""
        cat ~/.ssh/id_rsa.pub
        echo ""
        echo "Press Enter after adding the key to GitHub..."
        read -r
    else
        echo "SSH key already exists at ~/.ssh/id_rsa"
        echo ""
        echo "Your public key:"
        cat ~/.ssh/id_rsa.pub
        echo ""
    fi
fi

# Install useful system monitoring tools
echo "Installing system monitoring tools..."
sudo apt install -y htop iotop nethogs

# Configure automatic security updates
echo "Configuring automatic security updates..."
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# Show system info
echo ""
echo "================================"
echo "System Information"
echo "================================"
echo "Hostname: $(hostname)"
echo "IP Address: $(hostname -I | awk '{print $1}')"
echo "OS: $(lsb_release -d | cut -f2)"
echo "Python: $(python3 --version)"
echo "Nginx: $(nginx -v 2>&1)"
echo ""

echo "================================"
echo "VPS Initialization Complete!"
echo "================================"
echo ""
echo "Next steps:"
echo "1. Add your SSH key to GitHub (if you created one)"
echo "2. Run the deploy script: bash scripts/deploy.sh"
echo ""
