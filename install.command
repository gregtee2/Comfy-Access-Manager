#!/bin/bash
# ═══════════════════════════════════════════════════════
#   Double-click this file in Finder to install CAM
# ═══════════════════════════════════════════════════════
#
#   If macOS says this file "can't be opened":
#     1. Right-click (or Control-click) this file
#     2. Choose "Open" from the menu
#     3. Click "Open" in the dialog that appears
#
#   You only need to do this once.
# ═══════════════════════════════════════════════════════
cd "$(dirname "$0")"

# Make sure all scripts are executable
chmod +x install.sh start.sh start.command 2>/dev/null

# Run the installer
./install.sh

echo ""
echo "  Press any key to close this window..."
read -n 1 -s
