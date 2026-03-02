# Comfy Asset Manager (CAM)

![Version](https://img.shields.io/badge/version-1.4.1-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)
![License](https://img.shields.io/badge/license-Proprietary-red)

A local media asset manager for creative production — organize, browse, import, export, and play media files with a project-based hierarchy and ComfyUI integration.

---

## Features

### Project-Based Organization
- Create **Projects** to group related work
- Inside each project, organize by **Sequence → Shot → Role**
- **Roles** categorize assets under shots (Comp, Light, Anim, FX, Enviro, Layout, Matchmove, Roto, Edit, AI, etc.)
- Roles are fully customizable — add, rename, recolor, or delete from Settings

### Smart Import with Auto-Naming
- Built-in **file browser** for selecting files from anywhere on your system
- Assign **Project, Sequence, Shot, Role, and Take number** during import
- **Live rename preview** before importing — see exactly what files will be named
- **Three import modes**:
  - **Move** — Files are moved into the vault; originals are removed
  - **Copy** — Files are copied into the vault; originals stay at source
  - **Register in Place** — Files stay where they are; only a database reference is created (ideal for network drives, large files)
- **ShotGrid naming convention**: Files are auto-renamed following industry-standard patterns (e.g., `EDA1500_comp_v001.exr` — the folder path encodes Project/Sequence, so filenames start at the most specific level)
- **Inline Sequence/Shot creation** — "+" buttons next to dropdowns let you create sequences and shots without leaving the Import tab
- **Drag-and-drop** files directly onto the browser for quick import
- **Keep original filenames** option — skip auto-rename when you just want to organize
- Progress bar for batch imports

### Media Browsing
- **Grid view** with thumbnail previews and **list view** with metadata columns
- **Filter** by media type (video, image, EXR, audio, 3D, document), sequence, or search text
- **Breadcrumb navigation**: Project → Sequence → Shot → Role
- **Tree panel** on the left for quick hierarchy navigation
- **Marquee (rubber-band) selection** — click and drag on empty space in the grid to draw a selection rectangle; all intersecting cards are selected
  - **Shift+drag** adds to existing selection (additive mode)
  - Auto-scrolls when dragging near viewport edges
  - Works in both grid and list views
- **Shift+click range select** — select all assets between last-clicked and current
- **Cmd/Ctrl+click** — toggle individual assets in/out of selection
- **Selection toolbar**: Select All, Move to Sequence, Set Role, Export, Compare in RV, Delete
- **Right-click context menus** on assets, shots, sequences, and projects for quick actions

### Built-in Media Player
- Click any asset to open the **built-in player** (images, video, audio)
- **Custom video transport** with real-time scrubbing, frame stepping (← → arrow keys), and J/K/L shuttle control
- **Frame cache engine** — RV-style sequential decode for instant scrubbing via WebCodecs + mp4box.js
- **Pop-out player** — open media in a separate window with presentation mode
- **Play All** — play all assets in current view as a playlist
- Navigate between assets with Previous/Next buttons
- Shows metadata: resolution, duration, FPS, codec, file size
- **ComfyUI metadata panel** — press Tab to see generation workflow info
- **On-the-fly transcoding** — ProRes, DNxHR, and other pro codecs are automatically transcoded to H.264 for browser playback via FFmpeg

### Export & Transcode
- Export assets to different codecs and resolutions via FFmpeg
- **GPU-accelerated encoding**:
  - **Windows**: H.264 NVENC, H.265/HEVC NVENC (NVIDIA GPUs)
  - **macOS**: H.264 VideoToolbox, H.265/HEVC VideoToolbox (Apple Silicon hardware encoder)
- **Auto-retry with CPU fallback** — if GPU encoder fails, automatically falls back to libx264/libx265
- **ProRes**: 422 HQ, 422 LT, 422 Proxy
- **Resolution presets**: Original, 4K, 1440p, 1080p, 720p, 540p, 480p
- **Copy mode** (no re-encode) for fast container changes
- Exported files are organized in hierarchical folders and auto-registered back into the vault

### External Player Support (RV / OpenRV)
- **RV (OpenRV / ShotGrid)** integration for professional playback (EXR, ProRes, HDR, etc.)
- **A/B wipe comparison**: Select two assets → Compare in RV with side-by-side wipe mode
- **Persistent RV sessions** — send multiple assets to a running RV instance via rvpush
- **CAM RV plugin** — right-click menu inside RV with:
  - Compare To / Switch To — browse assets by role with Qt tree/table picker dialog
  - Prev/Next Version — step through version history of the current asset
  - Add to Crate — send the currently viewed clip to any crate
  - Publish Frame — export current frame with metadata
  - Hierarchical fallback: searches shot → sequence → project for related assets
- **In-window menu bar on macOS** — RV menu bar renders inside the window (not the native macOS system bar) for consistency with Windows/Linux
- **RV overlay system** — heads-up metadata rendered directly in the viewport:
  - **Metadata burn-in** (bottom-right) — shot name + 4-digit frame counter
  - **Status stamp** (top-right) — colored badge: WIP (orange), Review (blue), Approved (green), Final (gold)
  - **Watermark** (center) — faint "CONFIDENTIAL" / "INTERNAL USE ONLY" text
  - **Shift+O** hotkey + checkbox menu items to toggle each layer
- **Auto-update RV binary** — when a code update includes a new `rv_build` stamp, the server automatically downloads the updated RV binary from GitHub Releases using the existing PAT
- **Bundled OpenRV** — auto-downloaded by install.bat / install.sh (no manual build required)
- Also supports any custom external player (set the path in Settings)

### Crate System
- **Crates** — collect assets from any project, sequence, or shot into named crates for review, export, or sharing
- Create, rename, and delete crates from the sidebar or context menu
- **Add to Crate** from right-click context menu on any asset (submenu with crate picker)
- **Add to Crate from RV** — send the currently viewed clip to a crate directly from inside OpenRV
- **Remove from Crate** — context menu option when viewing a crate
- Tree nav sidebar shows all crates with live asset count badges
- Export an entire crate as a batch

### Plugin Architecture
- Resolve, Flow/ShotGrid, and ComfyUI are now **self-contained plugins** under `plugins/`
- Each plugin has a `plugin.json` manifest, routes, optional frontend assets, and scripts
- `pluginLoader.js` auto-discovers plugins, mounts routes, and serves frontend assets
- `pluginRegistry.js` handles frontend plugin registration and settings injection
- Easy to add new integrations without modifying core code

### ComfyUI Integration
- **3 custom ComfyUI nodes** for direct vault integration:
  - **LoadFromMediaVault** — Load an image from the vault by hierarchy selection
  - **LoadVideoFrameFromMediaVault** — Load a specific video frame by frame number
  - **SaveToMediaVault** — Save ComfyUI output back into the vault with proper naming
- **Auto-populate Save from Load** — When you add a SaveToMediaVault node, it automatically copies the Project/Sequence/Shot from an existing Load node in your workflow so you don't have to set them twice

### DaVinci Resolve Integration
- Right-click assets → **"Send to Resolve"** to push media into Resolve's Media Pool
- **Auto-bin-by-hierarchy** creates Project/Sequence/Shot folder structure in Resolve Media Pool
- Python bridge (`resolve_bridge.py`) with status, list_bins, send_to_bin, get_projects commands
- REST API: `GET /status`, `POST /send`, `GET /bins`, `GET /projects`
- Cross-platform: Windows (fusionscript.dll) + macOS (fusionscript.so)
- Resolve must be running; status check shows connection state
- **📂 Copy from Load Node** button — Manually re-sync Save node fields from the Load node at any time
- **Dynamic cascading dropdowns**: Project → Sequence → Shot → Role → Asset
- **🔄 Refresh button** on each node re-queries the vault — including new **projects and roles** — without restarting ComfyUI
- **3-tier asset resolution**: ComfyUI mapping → exact vault name match → fuzzy search
- Point CAM at your **ComfyUI output folder** for auto-import of generated files
- Setup: junction link `custom_nodes\mediavault` → `C:\MediaVault\comfyui`

### User Access Control (v1.3.0)
- **Multi-user profiles** — each team member picks their name on launch
- **PIN protection** — optional 4-8 character PIN (SHA-256 hashed) prevents profile impersonation
- **Blacklist project hiding** — admin can hide specific projects from specific users (users see everything by default)
- **Admin role** — first user is Admin by default; admins see all projects regardless of hidden settings
- **Network-friendly** — other machines on the LAN can connect to your server via browser; each person picks their profile

### Network Discovery & Multi-Machine
- **Automatic server discovery** — fresh installs auto-scan the LAN for existing CAM servers
- **One-click connect** — found servers appear on the setup screen with a green dot; click to connect
- **UDP broadcast** on port 7701 — zero-config, zero-dependency discovery protocol
- **Pull database** from a remote server to sync projects and assets across machines
- **Path mappings** — map Mac paths (`/Volumes/NAS`) to Windows paths (`Z:\`) for cross-platform asset access

### Watch Folders
- Set up **watched directories** that are monitored for new files
- New files trigger automatic import notifications
- Useful for render farm outputs, shared drives, or any automated workflow

### Settings & Customization
- **Vault root path**: Choose where all media files are stored
- **Naming template**: Customize how imported files are named using tokens (`{project}`, `{sequence}`, `{shot}`, `{step}`, `{version}`, `{take}`, `{type}`, `{date}`, `{original}`, `{counter}`)
- Follows **ShotGrid/Flow Production Tracking** naming conventions
- **Thumbnail size**: 100–800px
- **Auto-generate thumbnails** on import toggle
- **Migrate vault**: Move all files to a new location with one click

---

## Supported File Types

| Category | Formats |
|----------|---------|
| **Video** | .mov, .mp4, .avi, .mkv, .wmv, .flv, .webm, .m4v, .mpg, .mpeg, .3gp, .ts, .mts, .m2ts, .prores |
| **Image** | .jpg, .jpeg, .png, .gif, .bmp, .tiff, .tif, .webp, .svg, .heic, .heif, .psd, .psb, .ai, .eps |
| **EXR/HDR** | .exr, .hdr, .dpx |
| **RAW Photo** | .raw, .cr2, .nef, .arw, .dng |
| **Audio** | .wav, .mp3, .aac, .flac, .ogg, .wma, .m4a, .aiff, .aif |
| **3D** | .obj, .fbx, .gltf, .glb, .stl, .blend, .3ds, .dae, .usd, .usda, .usdc, .usdz, .ply, .abc |
| **Document** | .pdf, .doc, .docx, .txt, .rtf, .md, .csv, .xls, .xlsx |

---

## Installation

The one-click installer automatically downloads and installs **everything** you need — Node.js, Git, FFmpeg, and npm packages. No manual setup required.

### Windows

```bash
# 1. Download the ZIP from GitHub and extract it (or clone if you already have Git)
git clone https://github.com/LatentPixelLLC/Comfy-Access-Manager.git
cd Comfy-Access-Manager

# 2. Run the one-click installer (handles Node.js, Git, FFmpeg, npm packages)
install.bat

# 3. Start the server
start.bat
```

### macOS

Open **Terminal** (press ⌘ Space, type "Terminal", hit Enter) and paste this one line:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/LatentPixelLLC/Comfy-Access-Manager/main/scripts/mac-install.sh)"
```

That's it. The installer handles everything — Homebrew, Node.js, FFmpeg, and the app itself.

When it finishes, it will ask if you want to launch the app. Your browser will open automatically.

> **Next time**, just open Terminal and type: `~/Comfy-Asset-Manager/start.sh`

### Linux

```bash
# 1. Clone the repository
git clone https://github.com/LatentPixelLLC/Comfy-Access-Manager.git
cd Comfy-Access-Manager

# 2. Run the installer (handles Node.js, Git, FFmpeg, npm packages)
chmod +x install.sh start.sh
./install.sh

# 3. Start the server
./start.sh
```

> **No Git?** You can also download the [ZIP from GitHub](https://github.com/LatentPixelLLC/Comfy-Access-Manager/archive/refs/heads/main.zip), extract it, and run the installer — it will install Git for you too.

---

## Getting Started

### 1. Open the App

After starting the server, open your browser to:

```
http://localhost:7700
```

### 2. Set Your Vault Root

On first launch, you'll see a **Setup** screen asking you to set your **Vault Root Path**. This is the folder where CAM will store all your media files.

- Click the folder icon to browse and select a directory
- This can be any folder — an external drive, a NAS mount, or a local directory
- Example: `/Users/yourname/MediaVault` (Mac) or `C:\MediaVault` (Windows)

### 3. Create a Project

- Go to the **Projects** tab
- Click **+ New Project**
- Give it a name (e.g., "MyShortFilm")
- Click into the project to manage it

### 4. Add Sequences and Shots

Inside a project:
- Click **+ Sequence** to create a sequence (e.g., "SQ010")
- Click **+ Shot** under a sequence to create shots (e.g., "SH0010", "SH0020")

### 5. Import Media

**Option A — Import Tab:**
1. Go to the **Import** tab
2. Browse to the folder containing your files
3. Select files to import (click to select, Ctrl/Cmd+click for multi-select)
4. Choose the **Project**, **Sequence**, **Shot**, and **Role** from the dropdowns
5. Set a **Take number** and optional **Custom name**
6. Choose the **Import Mode**: Move (default), Copy, or Register in Place
7. Check the **rename preview** to see what files will be named
8. Click **Import & Rename**

> **Register in Place** is ideal for large files or network drives — files stay where they are and only a database reference is created. These assets are marked as "linked" and protected from accidental deletion.

**Option B — Drag & Drop:**
- Drag files directly onto the browser view to start a quick import

### 6. Browse & Play

- Switch to the **Browser** tab
- Navigate using the tree panel on the left, or click through Projects → Sequences → Shots
- Click any thumbnail to open the built-in player
- Use the filter bar to narrow by media type or search by name

### 7. Assign Roles

Roles help categorize assets within a shot (Comp, Light, Anim, FX, etc.):
- Select assets in the browser
- Click **Set Role** in the selection toolbar
- Choose from your configured roles

You can add custom roles in **Settings → Roles**.

### 8. Export

- Select one or more assets
- Click **Export** in the selection toolbar
- Choose a **codec** (H.264 GPU, ProRes, etc.) and **resolution**
- Exported files are saved to your vault and registered as new assets

---

## Settings

Access settings from the **Settings** tab:

| Setting | Description |
|---------|-------------|
| **Vault Root Path** | Where all media files are stored. Changing this offers to migrate existing files. |
| **Naming Template** | How imported files are named. Tokens: `{project}`, `{sequence}`, `{shot}`, `{step}`, `{version}`, `{take}`, `{type}`, `{date}`, `{original}`, `{counter}`. Follows ShotGrid/Flow naming conventions. |
| **Default Player** | Browser (built-in), RV (OpenRV / ShotGrid), or a custom player path |
| **Thumbnail Size** | Size of grid thumbnails (100–800px) |
| **Auto-generate Thumbnails** | Generate thumbnails automatically on import |
| **ComfyUI Output Path** | Point to your ComfyUI output folder for auto-import |
| **Roles** | Add, rename, recolor, or remove asset roles |
| **Watch Folders** | Directories to monitor for new files |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Backend** | Node.js + Express |
| **Database** | sql.js (WASM SQLite — no native compilation needed) |
| **Frontend** | Vanilla JavaScript (ES6 modules), HTML, CSS (no build step) |
| **Thumbnails** | Sharp (images), FFmpeg (video) |
| **Transcode/Export** | FFmpeg with NVENC GPU acceleration |
| **File Watching** | Chokidar |
| **File Upload** | Multer |

No build step required — the frontend is plain HTML/CSS/JS served by Express.

---

## Project Structure

```
Comfy-Access-Manager/
├── src/
│   ├── server.js              # Express server (port 7700)
│   ├── database.js            # sql.js SQLite wrapper
│   ├── pluginLoader.js        # Auto-discovers & mounts plugins from plugins/
│   ├── routes/
│   │   ├── projectRoutes.js   # Project + Sequence + Shot CRUD
│   │   ├── assetRoutes.js     # Asset import, browse, streaming, delete
│   │   ├── crateRoutes.js     # Crate CRUD, add/remove assets, export
│   │   ├── exportRoutes.js    # FFmpeg transcode/export (GPU-aware)
│   │   ├── roleRoutes.js      # Role CRUD
│   │   ├── settingsRoutes.js  # Settings API + vault setup
│   │   ├── userRoutes.js      # User profiles, PIN auth, project visibility
│   │   └── updateRoutes.js    # Auto-update, git pull, RV binary update
│   ├── services/
│   │   ├── ThumbnailService.js  # Thumbnail generation (Sharp + FFmpeg)
│   │   ├── MediaInfoService.js  # Metadata extraction (FFprobe)
│   │   ├── FileService.js       # File operations
│   │   ├── TranscodeService.js  # Platform-aware GPU encoder selection
│   │   └── WatcherService.js    # Folder watching (Chokidar)
│   └── utils/
│       ├── naming.js          # ShotGrid naming engine
│       ├── mediaTypes.js      # File extension → media type mapping
│       └── pathResolver.js    # Cross-platform path mapping (Mac ↔ Windows)
├── plugins/                   # Self-contained integrations
│   ├── comfyui/               # ComfyUI nodes + settings
│   │   ├── plugin.json
│   │   ├── routes.js
│   │   └── frontend/
│   ├── flow/                  # Flow/ShotGrid sync
│   │   ├── plugin.json
│   │   ├── routes.js
│   │   ├── services/FlowService.js
│   │   ├── scripts/flow_bridge.py
│   │   └── frontend/
│   └── resolve/               # DaVinci Resolve integration
│       ├── plugin.json
│       ├── routes.js
│       └── scripts/resolve_bridge.py
├── public/
│   ├── index.html             # Single-page app shell
│   ├── css/styles.css         # Neutral gray theme for VFX work
│   └── js/                    # Frontend ES6 modules
│       ├── main.js            # Entry point, tab switching
│       ├── browser.js         # Asset browser orchestrator
│       ├── assetGrid.js       # Grid/list rendering, selection, marquee drag
│       ├── treeNav.js         # Sidebar tree hierarchy
│       ├── contextMenus.js    # Right-click context menus
│       ├── crate.js           # Crate UI: create, rename, delete, view
│       ├── pluginRegistry.js  # Frontend plugin registration
│       ├── import.js          # File browser, import flow, rename preview
│       ├── export.js          # Export modal
│       ├── player.js          # Media player modal
│       ├── settings.js        # Settings tab, roles, users
│       ├── api.js             # API client
│       ├── state.js           # Global state
│       └── utils.js           # Shared utilities
├── rv-package/
│   └── mediavault_mode.py     # RV plugin (Compare, Crate, Overlay)
├── comfyui/
│   ├── mediavault_node.py     # 3 custom ComfyUI nodes
│   ├── __init__.py
│   └── js/
│       └── mediavault_dynamic.js  # Dynamic cascading dropdowns
├── data/
│   └── mediavault.db          # SQLite database (auto-created)
├── thumbnails/                # Generated thumbnails
├── tools/
│   ├── rv/                    # Bundled OpenRV binary (auto-downloaded)
│   └── ffmpeg/                # Portable FFmpeg (Windows, auto-downloaded)
├── install.bat                # Windows installer (1-click)
├── install.sh                 # macOS/Linux installer
├── start.bat                  # Windows launcher
├── start.sh                   # macOS/Linux launcher
└── package.json
```

---

## Troubleshooting

### "FFmpeg not found"
FFmpeg is **automatically installed** by `install.bat` (Windows) or `install.sh` (Mac/Linux) — you should not need to install it manually. If you still see this error:
- **Windows**: Re-run `install.bat` — it downloads a portable FFmpeg to `tools/ffmpeg/` and CAM finds it automatically
- **macOS**: Re-run `./install.sh` — it installs FFmpeg via Homebrew
- **Linux**: Re-run `./install.sh` — it installs FFmpeg via apt
- If you prefer a manual install, download from [ffmpeg.org](https://ffmpeg.org/download.html) and add the `bin/` folder to your system PATH

### Port 7700 Already in Use
Both `start.bat` (Windows) and `start.sh` / `start.command` (Mac/Linux) automatically clear port 7700 before starting. If you still have issues, manually kill the process:
```bash
# Mac/Linux
lsof -i :7700
kill -9 <PID>

# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 7700 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Video Won't Play in Browser
Some professional codecs (ProRes, DNxHR) can't play directly in a web browser. CAM automatically transcodes these on-the-fly when you click Play. If it's not working, make sure FFmpeg is installed.

### Thumbnails Not Generating
- For **images**: Make sure the `sharp` npm package installed correctly (`npm install`)
- For **videos**: FFmpeg is required — verify with `ffmpeg -version`

### RV Not Detected
CAM auto-discovers RV / OpenRV in standard locations:
- **Windows**: `C:\Program Files\Autodesk\RV*` or `C:\Program Files\Shotgun\RV*`
- **macOS**: `/Applications/RV*.app`
- **Linux**: `/usr/local/rv*` or `/opt/rv*`

If not detected, RV menu items will be hidden. OpenRV is available at [github.com/AcademySoftwareFoundation/OpenRV](https://github.com/AcademySoftwareFoundation/OpenRV) but requires compilation (no pre-built installers).

---

## Development

```bash
# Start with auto-restart on code changes (uses --watch)
npm run dev

# Standard start
npm start
```

The database is created automatically at `data/mediavault.db` on first run. Thumbnails are generated in the `thumbnails/` directory.

---

## Naming Convention

CAM follows **ShotGrid/Flow Production Tracking** naming standards. The folder structure encodes the full hierarchy (Project/Sequence/Shot/), so filenames start at the most specific level — no redundant project or sequence prefixes.

Files are automatically renamed on import based on context:

| Context | Template | Example |
|---------|----------|--------|
| Shot + Role | `{shot}_{step}_v{version}` | `EDA1500_comp_v001.exr` |
| Sequence + Role | `{sequence}_{step}_v{version}` | `EDA_plate_v003.dpx` |
| Project + Role | `{project}_{step}_v{version}` | `AP1_edit_v001.mov` |
| Legacy (no role) | `{shot}_{take}_{counter}` | `EDA1500_T01_0001.mov` |

### Available Tokens

| Token | Description | Example |
|-------|-------------|--------|
| `{project}` | Project code | `AP1` |
| `{sequence}` | Sequence code | `EDA` |
| `{shot}` | Shot code | `EDA1500` |
| `{step}` | Role/pipeline step (lowercase) | `comp` |
| `{version}` | 3-digit zero-padded version | `001` |
| `{take}` | Take number | `T01` |
| `{type}` | Media type | `video` |
| `{date}` | Date YYYYMMDD | `20260211` |
| `{original}` | Original filename | `render_v5` |
| `{counter}` | Auto-increment counter | `0001` |

Version numbers auto-increment — if `v001` exists, the next import becomes `v002`.

---

## UI Help System

The interface includes contextual help throughout:

- **Help icons** (?) next to form labels explain what each field does
- **Tooltips** on all buttons and controls describe their function on hover
- **Info hints** below complex settings provide usage guidance

Hover over any **?** icon or button to see a description.

---

## License

This software is proprietary. All rights reserved.
