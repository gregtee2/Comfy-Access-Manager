#!/bin/bash
# ═══════════════════════════════════════════════════════════
#   Double-click this file in Finder to install MediaVault
# ═══════════════════════════════════════════════════════════
cd "$(dirname "$0")"

# Make sure all scripts are executable
chmod +x install.sh start.sh start.command 2>/dev/null

# Run the real installer
./install.sh

echo ""
echo "  Press any key to close this window..."
read -n 1 -s
