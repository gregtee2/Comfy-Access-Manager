#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  create-macos-app.sh — Build the native macOS .app bundle
#  Creates "Comfy Asset Manager.app" in /Applications
#
#  Requirements: Xcode Command Line Tools (for cc + iconutil)
#  Run from the repo root, or pass APP_HOME to override
# ═══════════════════════════════════════════════════════════════════
set -e

APP_NAME="Comfy Asset Manager"
BUNDLE_ID="com.gregtee.comfy-asset-manager"
APP_PATH="/Applications/${APP_NAME}.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -e "console.log(require('$REPO_DIR/package.json').version)" 2>/dev/null || echo "1.0.0")
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  Building macOS App: ${APP_NAME}  ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Compile native Cocoa launcher ───────────────────────
echo "  [1/4] Compiling native launcher..."

MAIN_M="${SCRIPT_DIR}/macos/main.m"
if [ ! -f "$MAIN_M" ]; then
    echo "  ❌ Source not found: $MAIN_M"
    exit 1
fi

if ! command -v cc &>/dev/null; then
    echo "  ❌ C compiler not found. Install Xcode Command Line Tools:"
    echo "         xcode-select --install"
    exit 1
fi

cc -framework Cocoa \
   -fobjc-arc \
   -mmacosx-version-min=12.0 \
   -O2 \
   -o "${TMPDIR}/launcher" \
   "$MAIN_M"

echo "         ✓ Native binary compiled (arm64/x86_64)"

# ─── Step 2: Generate app icon ───────────────────────────────────
echo "  [2/4] Generating app icon..."

ICONSET="${TMPDIR}/AppIcon.iconset"
mkdir -p "$ICONSET"

# Generate icon PNG using Python (pure stdlib — no dependencies)
python3 << 'PYEOF' - "${TMPDIR}/icon_1024.png"
import struct, zlib, sys

def create_icon_png(filename, size=1024):
    """Create a nice-looking app icon with a dark gradient and centered play symbol."""
    w = h = size
    pixels = bytearray()

    # Colors
    bg_top = (22, 28, 38)       # Dark navy top
    bg_bot = (38, 55, 80)       # Lighter navy bottom
    accent = (90, 160, 255)     # Blue accent

    # Play triangle geometry (centered, pointing right)
    cx, cy = w * 0.48, h * 0.5
    tri_size = w * 0.22
    # Triangle vertices
    ax, ay = cx - tri_size * 0.4, cy - tri_size    # top-left
    bx, by = cx - tri_size * 0.4, cy + tri_size    # bottom-left
    dx, dy = cx + tri_size * 0.7, cy               # right point

    # Folder tab geometry
    tab_left = w * 0.18
    tab_right = w * 0.45
    tab_top = h * 0.22
    tab_height = h * 0.06
    folder_top = tab_top + tab_height
    folder_bottom = h * 0.78
    folder_left = w * 0.18
    folder_right = w * 0.82
    corner_r = w * 0.03

    for y in range(h):
        pixels.append(0)  # PNG filter byte: None
        t = y / h
        # Background gradient
        br = int(bg_top[0] * (1-t) + bg_bot[0] * t)
        bg = int(bg_top[1] * (1-t) + bg_bot[1] * t)
        bb = int(bg_top[2] * (1-t) + bg_bot[2] * t)

        for x in range(w):
            # Default: background
            r, g, b = br, bg, bb

            # Folder shape (rounded rect)
            in_folder = False
            if folder_left <= x <= folder_right and folder_top <= y <= folder_bottom:
                # Check corner rounding
                corners = [
                    (folder_left + corner_r, folder_top + corner_r),
                    (folder_right - corner_r, folder_top + corner_r),
                    (folder_left + corner_r, folder_bottom - corner_r),
                    (folder_right - corner_r, folder_bottom - corner_r),
                ]
                in_corner = False
                for ccx, ccy in corners:
                    if ((x < folder_left + corner_r or x > folder_right - corner_r) and
                        (y < folder_top + corner_r or y > folder_bottom - corner_r)):
                        dist = ((x - ccx)**2 + (y - ccy)**2) ** 0.5
                        if dist > corner_r:
                            in_corner = True
                            break
                if not in_corner:
                    in_folder = True

            # Folder tab
            if tab_left <= x <= tab_right and tab_top <= y <= folder_top:
                in_folder = True

            if in_folder:
                r, g, b = 45, 58, 80  # Slightly lighter than background

                # Inner shadow at top
                if y - folder_top < 2 and y >= folder_top:
                    r, g, b = 35, 45, 65

            # Play triangle (inside folder)
            if in_folder:
                # Point-in-triangle test using cross products
                def sign(x1, y1, x2, y2, x3, y3):
                    return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)

                d1 = sign(x, y, ax, ay, bx, by)
                d2 = sign(x, y, bx, by, dx, dy)
                d3 = sign(x, y, dx, dy, ax, ay)

                has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
                has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)

                if not (has_neg and has_pos):
                    # Inside triangle — use accent color with slight gradient
                    tri_t = (y - ay) / (by - ay) if by != ay else 0
                    tri_t = max(0, min(1, tri_t))
                    r = int(accent[0] * (1 - tri_t * 0.15))
                    g = int(accent[1] * (1 - tri_t * 0.1))
                    b = int(accent[2])

            # Subtle vignette (darken edges)
            edge_x = abs(x - w/2) / (w/2)
            edge_y = abs(y - h/2) / (h/2)
            vignette = max(0, 1 - (edge_x**2 + edge_y**2) * 0.3)
            r = int(r * (0.7 + 0.3 * vignette))
            g = int(g * (0.7 + 0.3 * vignette))
            b = int(b * (0.7 + 0.3 * vignette))

            pixels.extend([min(255, max(0, r)), min(255, max(0, g)), min(255, max(0, b))])

    # Build PNG
    def chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    compressed = zlib.compress(bytes(pixels), 9)

    png = (b'\x89PNG\r\n\x1a\n' +
           chunk(b'IHDR', ihdr) +
           chunk(b'IDAT', compressed) +
           chunk(b'IEND', b''))

    with open(filename, 'wb') as f:
        f.write(png)

output = sys.argv[1]
create_icon_png(output, 1024)
print(f"  Icon generated: {output}")
PYEOF

# Create iconset from 1024px source
if [ -f "${TMPDIR}/icon_1024.png" ]; then
    for sz in 16 32 128 256 512; do
        sips -z $sz $sz "${TMPDIR}/icon_1024.png" --out "${ICONSET}/icon_${sz}x${sz}.png" >/dev/null 2>&1
        double=$((sz * 2))
        sips -z $double $double "${TMPDIR}/icon_1024.png" --out "${ICONSET}/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
    done

    iconutil -c icns "$ICONSET" -o "${TMPDIR}/AppIcon.icns" 2>/dev/null && \
        echo "         ✓ App icon created" || \
        echo "         ⚠ Icon creation failed (will use default)"
else
    echo "         ⚠ Icon generation failed (will use default)"
fi

# ─── Step 3: Assemble .app bundle ────────────────────────────────
echo "  [3/4] Assembling app bundle..."

# Remove old version
if [ -d "$APP_PATH" ]; then
    rm -rf "$APP_PATH"
fi

mkdir -p "${APP_PATH}/Contents/MacOS"
mkdir -p "${APP_PATH}/Contents/Resources"

# Copy binary
cp "${TMPDIR}/launcher" "${APP_PATH}/Contents/MacOS/${APP_NAME}"
chmod +x "${APP_PATH}/Contents/MacOS/${APP_NAME}"

# Copy icon
if [ -f "${TMPDIR}/AppIcon.icns" ]; then
    cp "${TMPDIR}/AppIcon.icns" "${APP_PATH}/Contents/Resources/"
fi

# PkgInfo
echo -n "APPL????" > "${APP_PATH}/Contents/PkgInfo"

# Info.plist
cat > "${APP_PATH}/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright © 2026 Greg Tee. All Rights Reserved.</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.video</string>
</dict>
</plist>
PLIST

echo "         ✓ App bundle assembled at ${APP_PATH}"

# ─── Step 4: Sign and clean up ───────────────────────────────────
echo "  [4/4] Signing and registering..."

# Ad-hoc code sign (prevents Gatekeeper complaints for locally-built apps)
codesign --force --deep -s - "${APP_PATH}" 2>/dev/null && \
    echo "         ✓ Ad-hoc code signed" || \
    echo "         ⚠ Code signing skipped (app will still work)"

# Remove quarantine flag
xattr -cr "${APP_PATH}" 2>/dev/null || true

# Tell Launch Services about the new app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "${APP_PATH}" 2>/dev/null || true

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  ✅ ${APP_NAME} installed!        ║"
echo "  ╠══════════════════════════════════════════════════╣"
echo "  ║                                                  ║"
echo "  ║  📍 Location: /Applications                     ║"
echo "  ║  🚀 Launch from Finder, Dock, or Spotlight      ║"
echo "  ║  ⌘Q to quit (stops the server)                  ║"
echo "  ║  Click Dock icon to re-open browser              ║"
echo "  ║                                                  ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
