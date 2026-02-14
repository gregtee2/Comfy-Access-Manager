# Digital Media Vault (DMV)

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)
![License](https://img.shields.io/badge/license-Proprietary-red)

A local media asset manager for creative production — organize, browse, import, export, and play media files with a project-based hierarchy.

Built for artists and studios who work with video, images, EXR sequences, 3D files, and audio, and want a fast way to manage them without cloud services.

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
- **Drag-and-drop** files directly onto the browser for quick import
- Progress bar for batch imports

### Media Browsing
- **Grid view** with thumbnail previews and **list view** with metadata columns
- **Filter** by media type (video, image, EXR, audio, 3D, document), sequence, or search text
- **Breadcrumb navigation**: Project → Sequence → Shot → Role
- **Tree panel** on the left for quick hierarchy navigation
- **Selection toolbar**: Select All, Move to Sequence, Set Role, Export, Compare, Delete
- **Right-click context menu** on asset tiles for quick actions

### Built-in Media Player
- Click any asset to open the **built-in player** (images, video, audio)
- Navigate between assets with Previous/Next buttons
- Shows metadata: resolution, duration, FPS, codec, file size
- **On-the-fly transcoding** — ProRes, DNxHR, and other pro codecs are automatically transcoded to H.264 for browser playback via FFmpeg

### Export & Transcode
- Export assets to different codecs and resolutions via FFmpeg
- **GPU-accelerated encoding**: H.264 NVENC, H.265/HEVC NVENC (NVIDIA GPUs)
- **CPU fallbacks**: H.264 (libx264), H.265 (libx265)
- **ProRes**: 422 HQ, 422 LT, 422 Proxy
- **Resolution presets**: Original, 4K, 1440p, 1080p, 720p, 540p, 480p
- **Copy mode** (no re-encode) for fast container changes
- ~~Exports~~ Exported files are organized in hierarchical folders and auto-registered back into the vault

### External Player Support
- **RV (OpenRV / ShotGrid)** integration for professional playback (EXR, ProRes, HDR, etc.)
- **Player comparison**: Select two assets and compare side-by-side in RV with wipe mode
- **Persistent RV sessions** — send multiple assets to a running RV instance via rvpush
- **MediaVault RV plugin** — Compare To submenu with role-based version switching
- Also supports any custom external player (set the path in Settings)

### ComfyUI Integration
- **3 custom ComfyUI nodes** for direct vault integration:
  - **LoadFromMediaVault** — Load an image from the vault by hierarchy selection
  - **LoadVideoFrameFromMediaVault** — Load a specific video frame by frame number
  - **SaveToMediaVault** — Save ComfyUI output back into the vault with proper naming
- **Auto-populate Save from Load** — When you add a SaveToMediaVault node, it automatically copies the Project/Sequence/Shot from an existing Load node in your workflow so you don't have to set them twice
- **📂 Copy from Load Node** button — Manually re-sync Save node fields from the Load node at any time
- **Dynamic cascading dropdowns**: Project → Sequence → Shot → Role → Asset
- **🔄 Refresh button** on each node re-queries the vault — including new **projects and roles** — without restarting ComfyUI
- **3-tier asset resolution**: ComfyUI mapping → exact vault name match → fuzzy search
- Point DMV at your **ComfyUI output folder** for auto-import of generated files
- Setup: junction link `custom_nodes\mediavault` → `C:\MediaVault\comfyui`

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
git clone https://github.com/gregtee2/Digital-Media-Vault.git
cd Digital-Media-Vault

# 2. Run the one-click installer (handles Node.js, Git, FFmpeg, npm packages)
install.bat

# 3. Start the server
start.bat
```

### macOS

```bash
# 1. Clone the repository (Git comes pre-installed on most Macs)
git clone https://github.com/gregtee2/Digital-Media-Vault.git
cd Digital-Media-Vault

# 2. Double-click install.command in Finder
#    (or from Terminal: chmod +x install.sh && ./install.sh)
#    Installs: Homebrew, Node.js, Git, FFmpeg, npm packages

# 3. Double-click start.command in Finder to launch
#    (or from Terminal: ./start.sh)
```

> **macOS Gatekeeper**: The first time you double-click a `.command` file, macOS may say it can't be opened. Just **right-click → Open** instead — this only happens once per file.

### Linux

```bash
# 1. Clone the repository
git clone https://github.com/gregtee2/Digital-Media-Vault.git
cd Digital-Media-Vault

# 2. Run the installer (handles Node.js, Git, FFmpeg, npm packages)
chmod +x install.sh start.sh
./install.sh

# 3. Start the server
./start.sh
```

> **No Git?** You can also download the [ZIP from GitHub](https://github.com/gregtee2/Digital-Media-Vault/archive/refs/heads/main.zip), extract it, and run the installer — it will install Git for you too.

---

## Getting Started

### 1. Open the App

After starting the server, open your browser to:

```
http://localhost:7700
```

### 2. Set Your Vault Root

On first launch, you'll see a **Setup** screen asking you to set your **Vault Root Path**. This is the folder where DMV will store all your media files.

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
Digital-Media-Vault/
├── src/
│   ├── server.js              # Express server (port 7700)
│   ├── database.js            # sql.js SQLite wrapper
│   ├── routes/
│   │   ├── projectRoutes.js   # Project + Sequence + Shot CRUD
│   │   ├── assetRoutes.js     # Asset import, browse, streaming, delete
│   │   ├── exportRoutes.js    # FFmpeg transcode/export
│   │   ├── roleRoutes.js      # Role CRUD
│   │   ├── settingsRoutes.js  # Settings API + vault setup
│   │   ├── comfyuiRoutes.js   # ComfyUI integration endpoints
│   │   └── flowRoutes.js      # Flow/ShotGrid sync (planned)
│   ├── services/
│   │   ├── ThumbnailService.js  # Thumbnail generation (Sharp + FFmpeg)
│   │   ├── MediaInfoService.js  # Metadata extraction (FFprobe)
│   │   ├── FileService.js       # File operations
│   │   ├── WatcherService.js    # Folder watching (Chokidar)
│   │   └── FlowService.js       # Flow/ShotGrid API client (planned)
│   └── utils/
│       ├── naming.js          # ShotGrid naming engine
│       └── mediaTypes.js      # File extension → media type mapping
├── public/
│   ├── index.html             # Single-page app shell
│   ├── css/styles.css         # Neutral gray theme for VFX work
│   └── js/                    # Frontend ES6 modules
│       ├── main.js            # Entry point, tab switching
│       ├── browser.js         # Asset browser, grid/list views, tree nav
│       ├── import.js          # File browser, import flow, rename preview
│       ├── export.js          # Export modal
│       ├── player.js          # Media player modal
│       ├── settings.js        # Settings tab, roles
│       ├── api.js             # API client
│       ├── state.js           # Global state
│       └── utils.js           # Shared utilities
├── comfyui/
│   ├── mediavault_node.py     # 3 custom ComfyUI nodes
│   ├── __init__.py
│   └── js/
│       └── mediavault_dynamic.js  # Dynamic cascading dropdowns
├── data/
│   └── mediavault.db          # SQLite database (auto-created)
├── thumbnails/                # Generated thumbnails
├── install.bat                # Windows installer (1-click)
├── install.sh                 # macOS/Linux installer
├── install.command            # macOS double-click installer wrapper
├── start.bat                  # Windows launcher
├── start.sh                   # macOS/Linux launcher
├── start.command              # macOS double-click launcher wrapper
└── package.json
```

---

## Troubleshooting

### "FFmpeg not found"
FFmpeg is **automatically installed** by `install.bat` (Windows) or `install.sh` (Mac/Linux) — you should not need to install it manually. If you still see this error:
- **Windows**: Re-run `install.bat` — it downloads a portable FFmpeg to `tools/ffmpeg/` and DMV finds it automatically
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
Some professional codecs (ProRes, DNxHR) can't play directly in a web browser. DMV automatically transcodes these on-the-fly when you click Play. If it's not working, make sure FFmpeg is installed.

### Thumbnails Not Generating
- For **images**: Make sure the `sharp` npm package installed correctly (`npm install`)
- For **videos**: FFmpeg is required — verify with `ffmpeg -version`

### RV Not Detected
DMV auto-discovers RV / OpenRV in standard locations:
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

DMV follows **ShotGrid/Flow Production Tracking** naming standards. The folder structure encodes the full hierarchy (Project/Sequence/Shot/), so filenames start at the most specific level — no redundant project or sequence prefixes.

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
