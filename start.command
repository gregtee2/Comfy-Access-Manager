#!/bin/bash
# ═══════════════════════════════════════════════════════
#   Double-click this file in Finder to launch CAM
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
chmod +x start.sh 2>/dev/null
./start.sh
