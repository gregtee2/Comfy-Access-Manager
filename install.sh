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
            mkdir -p tools
            DOWNLOAD_OK=false
            MAC_ARCH=$(uname -m)

            # --- Strategy 1: GitHub Releases (most reliable) ---
            echo "         Finding latest mrViewer2 version on GitHub..."
            GH_JSON=$(curl -s --connect-timeout 10 \
                "https://api.github.com/repos/ggarra13/mrv2/releases/latest" 2>/dev/null || true)

            if [ -n "$GH_JSON" ]; then
                # Pick the correct macOS DMG for this architecture
                if [ "$MAC_ARCH" = "arm64" ]; then
                    ARCH_FILTER="Darwin-arm64"
                else
                    ARCH_FILTER="Darwin-amd64"
                fi

                # Parse GitHub JSON with python3 to find the right .dmg URL
                DMG_URL=$(echo "$GH_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for asset in data.get('assets', []):
        name = asset.get('name', '')
        # Prefer OpenGL (mrv2) over Vulkan (vmrv2), must be .dmg
        if name.startswith('mrv2-') and name.endswith('.dmg') and '${ARCH_FILTER}' in name:
            print(asset['browser_download_url'])
            break
except:
    pass" 2>/dev/null || true)

                if [ -n "$DMG_URL" ]; then
                    DMG_NAME=$(basename "$DMG_URL")
                    echo "         Downloading ${DMG_NAME} from GitHub..."
                    curl -L -o tools/mrv2-installer.dmg "$DMG_URL" \
                        --progress-bar --connect-timeout 15 || true

                    if [ -f tools/mrv2-installer.dmg ] && [ -s tools/mrv2-installer.dmg ] && \
                       ! file tools/mrv2-installer.dmg | grep -q "HTML"; then
                        DOWNLOAD_OK=true
                    else
                        echo "         GitHub download failed, trying SourceForge..."
                        rm -f tools/mrv2-installer.dmg 2>/dev/null
                    fi
                fi
            fi

            # --- Strategy 2: SourceForge API + mirror URL ---
            if [ "$DOWNLOAD_OK" = false ]; then
                echo "         Trying SourceForge..."
                SF_JSON=$(curl -s --connect-timeout 10 \
                    "https://sourceforge.net/projects/mrv2/best_release.json" 2>/dev/null || true)

                if [ -n "$SF_JSON" ]; then
                    DMG_PATH=$(echo "$SF_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    mac = data.get('platform_releases', {}).get('mac', {})
    print(mac.get('filename', ''))
except:
    pass" 2>/dev/null || true)

                    if [ -n "$DMG_PATH" ]; then
                        if [ "$MAC_ARCH" = "x86_64" ] && echo "$DMG_PATH" | grep -q "arm64"; then
                            DMG_PATH=$(echo "$DMG_PATH" | sed 's/arm64/amd64/g')
                        fi
                        DMG_NAME=$(basename "$DMG_PATH")
                        echo "         Downloading ${DMG_NAME} from SourceForge..."
                        curl -L -o tools/mrv2-installer.dmg \
                            "https://downloads.sourceforge.net/project/mrv2${DMG_PATH}" \
                            --progress-bar --max-redirs 10 --connect-timeout 15 \
                            --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" \
                            || true

                        if [ -f tools/mrv2-installer.dmg ] && [ -s tools/mrv2-installer.dmg ] && \
                           ! file tools/mrv2-installer.dmg | grep -q "HTML"; then
                            DOWNLOAD_OK=true
                        else
                            rm -f tools/mrv2-installer.dmg 2>/dev/null
                        fi
                    fi
                fi
            fi

            # --- Install from downloaded DMG ---
            if [ "$DOWNLOAD_OK" = true ]; then
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

            # --- Strategy 3: Open browser for manual download ---
            else
                echo ""
                echo "         ⚠️  Auto-download failed. Opening download page in Safari..."
                open "https://mrv2.sourceforge.io/" 2>/dev/null
                echo ""
                echo "         Please download the macOS .dmg file from the page that opened."
                echo "         Then drag the app into /Applications/ and run:"
                echo "           xattr -cr /Applications/mrv2*.app"
                echo ""
                echo "         Press Enter after installing (or Enter to skip)..."
                read -r
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
