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

# ─── [6/6] mrViewer2 ───
echo "  [6/6] Checking mrViewer2..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS — check /Applications for mrv2 or mrViewer
    if ls /Applications/mrv2*.app /Applications/mrViewer*.app &>/dev/null 2>&1; then
        echo "         mrViewer2 found in /Applications."
    else
        echo ""
        echo "         mrViewer2 is optional but recommended for pro video playback"
        echo "         (EXR, ProRes, HDR, DPX, etc.)"
        echo ""
        read -p "         Install mrViewer2? (y/N): " INSTALL_MRV2
        if [[ "$INSTALL_MRV2" =~ ^[Yy]$ ]]; then
            echo "         Downloading mrViewer2 (this may take a minute)..."
            mkdir -p tools
            curl -L -o tools/mrv2-installer.dmg \
                "https://sourceforge.net/projects/mrv2/files/latest/download" \
                --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" \
                --progress-bar --max-redirs 10

            # Verify we got a real disk image, not an HTML redirect page
            if [ -f tools/mrv2-installer.dmg ] && [ -s tools/mrv2-installer.dmg ] && ! file tools/mrv2-installer.dmg | grep -q "HTML"; then
                echo "         Mounting disk image..."
                MOUNT_OUTPUT=$(hdiutil attach tools/mrv2-installer.dmg -nobrowse 2>&1)
                VOLUME=$(echo "$MOUNT_OUTPUT" | grep "/Volumes/" | awk -F'\t' '{print $NF}' | head -1)

                if [ -n "$VOLUME" ] && [ -d "$VOLUME" ]; then
                    MRV2_APP=$(find "$VOLUME" -maxdepth 1 -name "*.app" -type d 2>/dev/null | head -1)
                    if [ -n "$MRV2_APP" ]; then
                        echo "         Installing to /Applications/..."
                        cp -R "$MRV2_APP" /Applications/
                        # Remove quarantine flag so macOS doesn't block it
                        APP_NAME=$(basename "$MRV2_APP")
                        xattr -cr "/Applications/$APP_NAME" 2>/dev/null
                        echo "         ✅ mrViewer2 installed!"
                    else
                        echo "         Could not find app in disk image."
                        echo "         Opening disk image — drag the app to /Applications/..."
                        open tools/mrv2-installer.dmg
                        sleep 3
                    fi
                    hdiutil detach "$VOLUME" -quiet 2>/dev/null
                else
                    echo "         Could not mount disk image."
                    echo "         Opening it for manual install — drag the app to /Applications/..."
                    open tools/mrv2-installer.dmg
                    sleep 3
                fi
                rm -f tools/mrv2-installer.dmg 2>/dev/null
            else
                echo "         Auto-download failed (SourceForge redirect issue)."
                echo "         Download manually from: https://mrv2.sourceforge.io/"
                echo "         Then drag the app into /Applications/ and run:"
                echo "           xattr -cr /Applications/mrv2*.app"
                rm -f tools/mrv2-installer.dmg 2>/dev/null
            fi
        else
            echo "         Skipping. You can install later from: https://mrv2.sourceforge.io/"
        fi
    fi
else
    # Linux — check if mrv2 exists
    if command -v mrv2 &>/dev/null; then
        echo "         mrViewer2 found."
    else
        echo ""
        echo "         mrViewer2 is optional but recommended for pro video playback."
        echo "         Download from: https://mrv2.sourceforge.io/"
        echo ""
    fi
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
