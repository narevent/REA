#!/bin/bash
set -e

# CONFIGURATION
PROJECT_NAME="rea"                                    # Project name (used for directories and services)
PROJECT_DIR="/var/www/rea"                            # Where to install the project
REPO_URL="https://github.com/narevent/rea.git"       # GitHub repository URL
DOMAIN_NAMES="rea.vetgaaf.tech"               # Space-separated domain names
PRIMARY_DOMAIN="rea.vetgaaf.tech"                              # Primary domain (first one)
WSGI_MODULE="rea.wsgi:application"                    # Django WSGI module (usually projectname.wsgi:application)

SERVICE_NAME="gunicorn-${PROJECT_NAME}"

echo "================================"
echo "${PROJECT_NAME} Django Deployment"
echo "================================"

# Prompt for repository URL
echo "Enter your GitHub repository URL"
echo "Current: $REPO_URL"
echo "(Press Enter to use current, or paste new URL):"
read -r input_repo
if [ ! -z "$input_repo" ]; then
    REPO_URL=$input_repo
fi

# Clone or update repository
if [ -d "$PROJECT_DIR/.git" ]; then
    echo "Repository already exists. Skipping clone..."
    echo "Note: Run update.sh to pull latest changes"
else
    echo "Cloning repository..."
    sudo rm -rf $PROJECT_DIR/*
    sudo git clone $REPO_URL $PROJECT_DIR
fi

# Change to project directory
cd $PROJECT_DIR

# Create necessary directories
echo "Creating necessary directories..."
sudo mkdir -p $PROJECT_DIR/logs
sudo mkdir -p $PROJECT_DIR/staticfiles
sudo mkdir -p $PROJECT_DIR/media
sudo mkdir -p $PROJECT_DIR/db
sudo mkdir -p $PROJECT_DIR/locale

# Set ownership and permissions
sudo chown -R www-data:www-data $PROJECT_DIR
sudo chmod -R 755 $PROJECT_DIR

# Create virtual environment
echo "Creating virtual environment..."
sudo -u www-data python3 -m venv venv

# Activate virtual environment and install dependencies
echo "Installing Python dependencies..."
sudo -u www-data $PROJECT_DIR/venv/bin/pip install --upgrade pip
sudo -u www-data $PROJECT_DIR/venv/bin/pip install -r requirements.txt

# Create .env file if it doesn't exist
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "Creating .env file..."
    sudo cp $PROJECT_DIR/.env.example $PROJECT_DIR/.env
    
    # Generate secret key using the venv Python with Django installed
    SECRET_KEY=$($PROJECT_DIR/venv/bin/python -c 'from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())')
    sudo sed -i "s/your-secret-key-here-generate-a-new-one/$SECRET_KEY/" $PROJECT_DIR/.env
    
    # Get VPS IP
    VPS_IP=$(hostname -I | awk '{print $1}')
    sudo sed -i "s/YOUR_VPS_IP/$VPS_IP/" $PROJECT_DIR/.env
    
    echo ".env file created with generated secret key"
    echo ""
    echo "IMPORTANT: Edit ${PROJECT_DIR}/.env and configure:"
    echo "  - Email settings (if using email)"
    echo "  - Payment gateway keys (Stripe/PayPal if using)"
    echo "  - Any other sensitive settings"
    echo ""
else
    echo ".env file already exists, skipping..."
fi

# Run Django migrations
echo "Running Django migrations..."
sudo -u www-data $PROJECT_DIR/venv/bin/python manage.py migrate

# Create translations (if using django-parler)
echo "Compiling translations..."
if [ -d "$PROJECT_DIR/locale" ]; then
    sudo -u www-data $PROJECT_DIR/venv/bin/python manage.py compilemessages || echo "No translations to compile"
fi

# Collect static files
echo "Collecting static files..."
sudo -u www-data $PROJECT_DIR/venv/bin/python manage.py collectstatic --noinput

# Create superuser (optional)
echo ""
echo "Do you want to create a Django superuser? (y/n)"
read -r create_superuser
if [ "$create_superuser" = "y" ]; then
    sudo -u www-data $PROJECT_DIR/venv/bin/python manage.py createsuperuser
fi

# Setup Gunicorn service
echo "Setting up Gunicorn service..."
sudo cp $PROJECT_DIR/gunicorn.service /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

# Setup Nginx
echo "Setting up Nginx..."
sudo cp $PROJECT_DIR/nginx.conf /etc/nginx/sites-available/${PROJECT_NAME}
sudo ln -sf /etc/nginx/sites-available/${PROJECT_NAME} /etc/nginx/sites-enabled/

# Test Nginx configuration
echo "Testing Nginx configuration..."
if sudo nginx -t; then
    echo "Nginx configuration is valid"
    sudo systemctl reload nginx
else
    echo "ERROR: Nginx configuration test failed!"
    exit 1
fi

# Setup SSL with Let's Encrypt
echo ""
echo "================================"
echo "SSL Certificate Setup"
echo "================================"
echo "Do you want to setup SSL with Let's Encrypt now? (y/n)"
echo "Note: Make sure your domain DNS is pointing to this server first!"
read -r setup_ssl

if [ "$setup_ssl" = "y" ]; then
    echo "Enter your email for Let's Encrypt notifications:"
    read -r email
    
    # Build certbot command with all domains
    CERTBOT_DOMAINS=""
    for domain in $DOMAIN_NAMES; do
        CERTBOT_DOMAINS="$CERTBOT_DOMAINS -d $domain"
    done
    
    echo "Setting up SSL certificate..."
    sudo certbot --nginx $CERTBOT_DOMAINS --non-interactive --agree-tos --email $email --redirect
    
    if [ $? -eq 0 ]; then
        echo "SSL certificate installed successfully!"
        # Setup auto-renewal
        sudo systemctl enable certbot.timer
        sudo systemctl start certbot.timer
    else
        echo "SSL setup failed. You can try again later with:"
        echo "sudo certbot --nginx $CERTBOT_DOMAINS"
    fi
else
    echo "Skipping SSL setup. You can run it later with:"
    CERTBOT_DOMAINS=""
    for domain in $DOMAIN_NAMES; do
        CERTBOT_DOMAINS="$CERTBOT_DOMAINS -d $domain"
    done
    echo "sudo certbot --nginx $CERTBOT_DOMAINS"
fi

echo ""
echo "================================"
echo "Deployment Complete!"
echo "================================"
echo ""
echo "Service status:"
sudo systemctl status ${SERVICE_NAME} --no-pager | head -5
echo ""
echo "Your site should now be accessible at:"
if [ "$setup_ssl" = "y" ]; then
    echo "  https://${PRIMARY_DOMAIN}"
    echo "  Admin panel: https://${PRIMARY_DOMAIN}/admin/"
else
    echo "  http://${PRIMARY_DOMAIN} (HTTP only - setup SSL for HTTPS)"
    echo "  Admin panel: http://${PRIMARY_DOMAIN}/admin/"
fi
echo ""
echo "Useful commands:"
echo "  View Gunicorn logs: sudo journalctl -u ${SERVICE_NAME} -f"
echo "  View Nginx logs: sudo tail -f /var/log/nginx/error.log"
echo "  Restart services: sudo systemctl restart ${SERVICE_NAME} nginx"
echo "  Update site: bash scripts/update.sh"
echo ""
echo "Don't forget to:"
echo "  - Configure email settings in .env"
echo "  - Configure payment gateways in .env (if needed)"
echo "  - Upload media files if migrating from another server"
echo ""
