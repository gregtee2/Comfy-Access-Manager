#!/bin/bash
# ═══════════════════════════════════════════════════════
#   Comfy Asset Manager — One-Line Mac Installer
#
#   Usage (paste into Terminal):
#     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/LatentPixelLLC/Comfy-Access-Manager/main/scripts/mac-install.sh)"
#
# ═══════════════════════════════════════════════════════
set -e

echo ""
echo "  ============================================"
echo "    Comfy Asset Manager — Mac Setup"
echo "  ============================================"
echo ""

# ─── Where to install ───
INSTALL_DIR="$HOME/Comfy-Asset-Manager"

if [ -d "$INSTALL_DIR" ]; then
    echo "  Found existing install at:"
    echo "    $INSTALL_DIR"
    echo ""
    read -p "  Update it? [Y/n]: " UPDATE
    if [[ "$UPDATE" =~ ^[Nn]$ ]]; then
        echo "  Cancelled."
        exit 0
    fi
    echo ""
    echo "  Updating..."
    cd "$INSTALL_DIR"
    git pull origin main 2>&1 | tail -3
else
    echo "  Installing to:"
    echo "    $INSTALL_DIR"
    echo ""

    # Make sure git is available (comes with Xcode CLT on most Macs)
    if ! command -v git &>/dev/null; then
        echo "  Git not found — installing Xcode Command Line Tools..."
        echo "  (A dialog may pop up — click 'Install' and wait for it to finish)"
        echo ""
        xcode-select --install 2>/dev/null || true
        echo ""
        echo "  After Xcode tools finish installing, run this command again."
        exit 1
    fi

    echo "  Downloading..."
    git clone https://github.com/LatentPixelLLC/Comfy-Access-Manager.git "$INSTALL_DIR" 2>&1 | tail -3
    cd "$INSTALL_DIR"
fi

# Make scripts executable
chmod +x install.sh start.sh install.command start.command 2>/dev/null

# Run the real installer
echo ""
exec ./install.sh
