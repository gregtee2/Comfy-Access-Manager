#!/bin/bash
# Digital Media Vault — macOS/Linux launcher
cd "$(dirname "$0")"

# ─── Ensure Node.js is in PATH ───
# nvm installs node in a non-standard location — source it if available
if ! command -v node &>/dev/null; then
    # Try nvm (most common Node version manager)
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi

if ! command -v node &>/dev/null; then
    # Try Homebrew paths (Apple Silicon + Intel)
    for p in /opt/homebrew/bin /usr/local/bin; do
        [ -x "$p/node" ] && export PATH="$p:$PATH" && break
    done
fi

if ! command -v node &>/dev/null; then
    echo ""
    echo "  ❌ Node.js not found!"
    echo ""
    echo "  Please run the installer first:"
    echo "    chmod +x install.sh && ./install.sh"
    echo ""
    echo "  Or install Node.js manually:"
    echo "    macOS:  brew install node"
    echo "    Linux:  sudo apt install nodejs npm"
    echo "    nvm:    nvm install --lts"
    echo ""
    exit 1
fi

echo "Starting Digital Media Vault on http://localhost:7700"
echo "  Node: $(node --version) at $(which node)"
node src/server.js
