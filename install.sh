#!/bin/bash
# Digital Media Vault — macOS/Linux Installer
set -e

cd "$(dirname "$0")"

echo ""
echo "  ============================================="
echo "    Digital Media Vault (DMV) — One-Click Installer"
echo "  ============================================="
echo ""
echo "  This installer handles everything for you."
echo "  Just sit back — it will install all dependencies"
echo "  automatically if they are not already present."
echo ""

# ─── [1/6] Homebrew (macOS only) ───
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  [1/6] Checking Homebrew..."
    if command -v brew &>/dev/null; then
        echo "         Homebrew found."
    else
        echo "         Homebrew not found. Installing..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Add brew to PATH for this session (Apple Silicon default location)
        if [ -f /opt/homebrew/bin/brew ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
    fi
else
    echo "  [1/6] Linux detected — using apt package manager."
fi

# ─── [2/6] Node.js ───
echo "  [2/6] Checking Node.js..."
if command -v node &>/dev/null; then
    echo "         Found Node.js $(node --version)"
else
    echo "         Node.js not found. Installing..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install node
    else
        sudo apt update && sudo apt install -y nodejs npm
    fi
    echo "         Installed Node.js $(node --version)"
fi

# ─── [3/6] Git ───
echo "  [3/6] Checking Git..."
if command -v git &>/dev/null; then
    echo "         Found $(git --version)"
else
    echo "         Git not found. Installing..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install git
    else
        sudo apt install -y git
    fi
    echo "         Installed $(git --version)"
fi

# ─── [4/6] FFmpeg ───
echo "  [4/6] Checking FFmpeg..."
if command -v ffmpeg &>/dev/null; then
    echo "         FFmpeg already installed."
else
    echo "         FFmpeg not found. Installing..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install ffmpeg
    else
        sudo apt install -y ffmpeg
    fi
    echo "         FFmpeg installed."
fi

# ─── [5/6] npm packages ───
echo "  [5/6] Installing npm packages..."
npm install --no-audit --no-fund
echo "         Done."

# ─── [6/6] Check RV / OpenRV ───
echo "  [6/6] Checking RV / OpenRV..."
RV_FOUND=false
if [[ "$OSTYPE" == "darwin"* ]]; then
    if ls /Applications/RV*.app &>/dev/null 2>&1 || [ -f /usr/local/bin/rv ]; then
        RV_FOUND=true
    fi
else
    if command -v rv &>/dev/null; then
        RV_FOUND=true
    fi
fi

if [ "$RV_FOUND" = true ]; then
    echo "         RV / OpenRV found."
else
    echo ""
    echo "         RV / OpenRV not found (optional but recommended)."
    echo "         RV provides professional A/B wipe comparison and EXR/HDR playback."
    echo ""
    echo "         NOTE: The bundled OpenRV zip is Windows-only."
    echo "         For macOS/Linux, build OpenRV from source:"
    echo "           https://github.com/AcademySoftwareFoundation/OpenRV"
    echo "         Or download a pre-built release from:"
    echo "           https://github.com/AcademySoftwareFoundation/OpenRV/releases"
    echo "         Then set the RV path in DMV Settings after launch."
    echo ""
fi

# Create directories
mkdir -p data thumbnails

echo ""
echo "  ============================================="
echo "    ✅ Installation Complete!"
echo "  ============================================="
echo ""
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  To start DMV:"
    echo "    Double-click start.command"
    echo "    — or —"
    echo "    ./start.sh"
else
    echo "  To start DMV, run:  ./start.sh"
fi
echo ""
echo "  Then open:  http://localhost:7700"
echo ""
