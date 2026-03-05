#!/bin/bash
# Comfy Asset Manager (CAM) — macOS/Linux Installer
set -e

cd "$(dirname "$0")"

echo ""
echo "  ============================================"
echo "    Comfy Asset Manager — Installer"
echo "  ============================================"
echo ""
echo "  Sit back — this installs everything you need."
echo ""

# ─── [1/8] Homebrew (macOS only) ───
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  [1/8] Checking Homebrew..."
    if command -v brew &>/dev/null; then
        echo "         ✓ Homebrew ready."
    else
        echo "         Installing Homebrew (needed to install other tools)..."
        echo "         You may be asked for your Mac password — that's normal."
        echo ""
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Add brew to PATH for this session (Apple Silicon default location)
        if [ -f /opt/homebrew/bin/brew ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
        echo "         ✓ Homebrew installed."
    fi
else
    echo "  [1/8] Linux detected — using apt."
fi

# ─── [2/8] Node.js (need v18+) ───
echo "  [2/8] Checking Node.js..."
NEED_NODE=false
if command -v node &>/dev/null; then
    NODE_VER_FULL=$(node --version)
    NODE_VER=$(echo "$NODE_VER_FULL" | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -lt 18 ] 2>/dev/null; then
        echo "         Node.js ${NODE_VER_FULL} is outdated (need v18+). Upgrading..."
        NEED_NODE=true
    else
        echo "         ✓ Node.js ${NODE_VER_FULL}"
    fi
else
    NEED_NODE=true
fi

if [ "$NEED_NODE" = true ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if brew list node &>/dev/null 2>&1; then
            brew upgrade node 2>&1 | tail -1 || true
        else
            echo "         Installing Node.js..."
            brew install node 2>&1 | tail -1
        fi
        # Ensure Homebrew's node is in PATH
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        hash -r 2>/dev/null
    else
        sudo apt update -qq && sudo apt install -y nodejs npm
    fi
    echo "         ✓ Node.js $(node --version)"
fi

# ─── [3/8] Git ───
echo "  [3/8] Checking Git..."
if command -v git &>/dev/null; then
    echo "         ✓ Git ready."
else
    echo "         Installing Git..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install git 2>&1 | tail -1
    else
        sudo apt install -y git
    fi
    echo "         ✓ Git installed."
fi

# ─── [4/8] Python3 + ShotGrid SDK ───
echo "  [4/8] Checking Python3..."
if command -v python3 &>/dev/null; then
    echo "         ✓ Python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
else
    echo "         Installing Python3..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # Xcode CLT includes Python3; prompt install if missing
        echo "         Python3 comes with Xcode Command Line Tools."
        echo "         If prompted, click Install and wait for download."
        xcode-select --install 2>/dev/null || true
    else
        sudo apt install -y python3
    fi
    echo "         ✓ Python3 ready."
fi
# Install ShotGrid API (needed for Flow/ShotGrid sync)
if command -v python3 &>/dev/null; then
    echo "         Installing ShotGrid API..."
    python3 -m pip install shotgun_api3 --quiet 2>/dev/null || \
        pip3 install shotgun_api3 --quiet 2>/dev/null || \
        echo "         NOTE: pip install failed. Run: pip3 install shotgun_api3"
fi

# ─── [5/8] FFmpeg ───
echo "  [5/8] Checking FFmpeg..."
if command -v ffmpeg &>/dev/null; then
    echo "         ✓ FFmpeg ready."
else
    echo "         Installing FFmpeg (for video thumbnails)..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install ffmpeg 2>&1 | tail -1
    else
        sudo apt install -y ffmpeg
    fi
    echo "         ✓ FFmpeg installed."
fi

# ─── [6/8] oiiotool (OpenImageIO) ───
# oiiotool is needed for full-resolution DWAB EXR proxy compression.
# FFmpeg's EXR encoder only supports none/rle/zip1/zip16 — no DWA/DWAB.
echo "  [6/8] Checking oiiotool (OpenImageIO)..."
if command -v oiiotool &>/dev/null; then
    echo "         ✓ oiiotool ready."
else
    echo "         Installing oiiotool (for DWAB EXR proxy)..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: brew has openimageio, pip is a fallback
        brew install openimageio 2>&1 | tail -1 || \
            python3 -m pip install OpenImageIO --quiet 2>/dev/null || \
            echo "         NOTE: install failed. Run: brew install openimageio"
    else
        # Linux: apt has openimageio-tools, pip is a fallback
        sudo apt install -y openimageio-tools 2>/dev/null || \
            python3 -m pip install OpenImageIO --quiet 2>/dev/null || \
            echo "         NOTE: install failed. Try: sudo apt install openimageio-tools"
    fi
    if command -v oiiotool &>/dev/null; then
        echo "         ✓ oiiotool installed."
    else
        echo "         NOTE: oiiotool not available — half-res proxy via FFmpeg still works."
        echo "         Full-res DWAB proxy requires oiiotool."
        echo "         Install Python (https://www.python.org) then run:"
        echo "           python3 -m pip install OpenImageIO"
    fi
fi

# ─── [7/8] App dependencies ───
echo "  [7/8] Installing app dependencies..."
echo "         This may take a minute on first install..."
npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -1 || true
echo "         ✓ Dependencies ready."

# ─── [8/8] RV / OpenRV (optional) ───
echo "  [8/8] Checking RV / OpenRV..."
RV_BUNDLED=false
RV_SYSTEM=false
if [[ "$OSTYPE" == "darwin"* ]]; then
    # Check for our bundled native arm64 build first
    if [ -f "tools/rv/RV.app/Contents/MacOS/RV" ]; then
        RV_BUNDLED=true
    fi
    # Check for any system-wide RV (may be old Intel/x86)
    if ls /Applications/RV*.app &>/dev/null 2>&1 || [ -f /usr/local/bin/rv ]; then
        RV_SYSTEM=true
    fi
else
    if [ -f "tools/rv/bin/rv" ] || command -v rv &>/dev/null; then
        RV_BUNDLED=true
    fi
fi

if [ "$RV_BUNDLED" = true ]; then
    echo "         ✓ OpenRV (bundled) ready."
elif [ "$RV_SYSTEM" = true ] && [[ "$OSTYPE" == "darwin"* ]] && [ "$(uname -m)" = "arm64" ]; then
    # System RV exists but may be old Intel — offer our native arm64 build
    echo "         Found an older RV in /Applications (may be Intel-only)."
    echo "         A native Apple Silicon version with pro codecs is available."
    echo ""
    read -p "         Download the native OpenRV? (~642 MB) [Y/n]: " INSTALL_RV
    # Default to Yes — fall through to download below
    if [[ "$INSTALL_RV" =~ ^[Nn]$ ]]; then
        echo "         Keeping existing RV."
    else
        INSTALL_RV="y"
    fi
elif [ "$RV_SYSTEM" = true ]; then
    echo "         ✓ RV found."
else
    echo ""
    echo "         RV is not installed (optional — everything else works without it)."
    echo "         It adds side-by-side video comparison and professional EXR playback."
    echo ""

    if [[ "$OSTYPE" == "darwin"* ]]; then
        MAC_ARCH=$(uname -m)
        if [ "$MAC_ARCH" = "arm64" ]; then
            read -p "         Would you like to download OpenRV? (~642 MB) [y/N]: " INSTALL_RV
            if [[ "$INSTALL_RV" =~ ^[Yy]$ ]]; then
                INSTALL_RV="y"
            else
                echo "         Skipped. You can add RV later from Settings."
            fi
        else
            echo "         Pre-built OpenRV is available for Apple Silicon (M1/M2/M3/M4) only."
            echo "         For Intel Macs, see: docs/BUILD_OPENRV_MACOS.md"
        fi
    else
        echo "         For Linux, see: https://github.com/AcademySoftwareFoundation/OpenRV"
        echo "         Then set the RV path in Settings after launching."
    fi
    echo ""
fi

# ─── Download OpenRV if requested ───
if [[ "$INSTALL_RV" == "y" ]]; then
    mkdir -p tools
    RV_URL="https://github.com/LatentPixelLLC/Comfy-Access-Manager/releases/download/rv-3.1.0/OpenRV-3.1.0-macos-arm64-mediavault.zip"
    echo ""
    echo "         Downloading OpenRV 3.1.0..."
    echo "         (this is a large file — it may take a few minutes)"
    echo ""
    curl -L -o tools/rv.zip "$RV_URL" --progress-bar --connect-timeout 15 || true

    if [ -f tools/rv.zip ] && [ -s tools/rv.zip ]; then
        echo ""
        echo "         Extracting..."
        rm -rf tools/rv 2>/dev/null
        mkdir -p tools/rv
        ditto -x -k tools/rv.zip tools/rv/
        rm -f tools/rv.zip
        # Remove quarantine so macOS doesn't block it
        xattr -cr tools/rv/RV.app 2>/dev/null
        if [ -f "tools/rv/RV.app/Contents/MacOS/RV" ]; then
            echo "         ✓ OpenRV installed (native Apple Silicon)."
        else
            echo "         ⚠ Extraction may have failed."
            echo "         You can set a custom RV path in Settings later."
        fi
    else
        echo "         ⚠ Download failed. You can add RV later from Settings."
        rm -f tools/rv.zip 2>/dev/null
    fi
fi

# Create working directories
mkdir -p data thumbnails logs

echo ""
echo "  ============================================"
echo "    ✅ Installation Complete!"
echo "  ============================================"
echo ""

# ─── Create macOS .app in /Applications ───
if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v cc &>/dev/null; then
        read -p "  Install to /Applications for Dock + Spotlight access? [Y/n]: " INSTALL_APP
        if [[ ! "$INSTALL_APP" =~ ^[Nn]$ ]]; then
            bash scripts/create-macos-app.sh
            echo ""
            read -p "  Launch Comfy Asset Manager now? [Y/n]: " LAUNCH_NOW
            if [[ ! "$LAUNCH_NOW" =~ ^[Nn]$ ]]; then
                echo "  🚀 Launching..."
                open "/Applications/Comfy Asset Manager.app"
            fi
            exit 0
        fi
    fi
fi

# Offer to launch immediately (non-.app fallback)
if [[ "$OSTYPE" == "darwin"* ]]; then
    read -p "  Launch Comfy Asset Manager now? [Y/n]: " LAUNCH_NOW
    if [[ ! "$LAUNCH_NOW" =~ ^[Nn]$ ]]; then
        echo ""
        exec ./start.sh
    else
        echo ""
        echo "  To start later, double-click:  start.command"
        echo ""
    fi
else
    read -p "  Launch now? [Y/n]: " LAUNCH_NOW
    if [[ ! "$LAUNCH_NOW" =~ ^[Nn]$ ]]; then
        echo ""
        exec ./start.sh
    else
        echo ""
        echo "  To start later:  ./start.sh"
        echo ""
    fi
fi
