#!/bin/bash
# GTSS Growth Engine Setup Script

echo "Installing dependencies..."
npm install

echo "Installing Playwright Chromium..."
npx playwright install chromium

echo "Setting up encryption passphrase..."
node src/utils/setupPassphrase.js "${1:-gtss2026}"

echo "Creating runtime directories..."
mkdir -p data/browser-locks sessions profiles artifacts/automation media public/pages public/css public/js public/uploads

echo "Setup complete. Run: npm start"
