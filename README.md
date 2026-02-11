# Digital Media Vault (DMV)

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
- **Copy or Move** originals (keep originals checkbox)
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
- **mrViewer2** integration for professional playback (EXR, ProRes, HDR, etc.)
- **Player comparison**: Select two assets and compare side-by-side in mrViewer2
- Customizable keyboard shortcuts for mrViewer2 hotkeys
- Also supports any custom external player (set the path in Settings)

### ComfyUI Integration
- Point DMV at your **ComfyUI output folder**
- New ComfyUI-generated files auto-appear in the import queue
- Optional auto-watch mode monitors the folder continuously
- Includes a custom ComfyUI node (`comfyui/mediavault_node.py`) for direct integration

### Watch Folders
- Set up **watched directories** that are monitored for new files
- New files trigger automatic import notifications
- Useful for render farm outputs, shared drives, or any automated workflow

### Settings & Customization
- **Vault root path**: Choose where all media files are stored
- **Naming template**: Customize how imported files are named using tokens (`{project}`, `{sequence}`, `{shot}`, `{take}`, `{type}`, `{date}`, `{original}`, `{counter}`)
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

## Prerequisites

### Required
- **Node.js** v18 or later — [Download](https://nodejs.org/)
- **Git** (for cloning the repo) — [Download](https://git-scm.com/)

### Optional (recommended)
- **FFmpeg** — Required for video thumbnails, playback transcoding, and export/transcode features
  - Windows: [Download from ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
- **mrViewer2** — Professional media viewer for EXR, ProRes, HDR playback — [Download](https://mrv2.sourceforge.io/)
  - Windows: Install to default location (`C:\Program Files\`)
  - macOS: Drag to `/Applications/`

> **Note:** DMV will work without FFmpeg, but you won't get video thumbnails, transcoding, or export features. Images and basic browsing work fine without it.

---

## Installation

### Windows

```bash
# 1. Clone the repository
git clone https://github.com/gregtee2/Digital-Media-Vault.git
cd Digital-Media-Vault

# 2. Install dependencies
npm install

# 3. Start the server
start.bat
```

Or manually:
```bash
npm start
```

### macOS

```bash
# 1. Install prerequisites (if you don't have them)
brew install node git ffmpeg

# 2. Clone the repository
git clone https://github.com/gregtee2/Digital-Media-Vault.git
cd Digital-Media-Vault

# 3. Install dependencies
npm install

# 4. Start the server
chmod +x start.sh
./start.sh
```

Or manually:
```bash
npm start
```

### Linux

```bash
# 1. Install prerequisites
sudo apt update
sudo apt install nodejs npm git ffmpeg

# 2. Clone the repository
git clone https://github.com/gregtee2/Digital-Media-Vault.git
cd Digital-Media-Vault

# 3. Install dependencies
npm install

# 4. Start the server
chmod +x start.sh
./start.sh
```

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
6. Check the **rename preview** to see what files will be named
7. Click **Import & Rename**

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
| **Naming Template** | How imported files are named. Tokens: `{project}`, `{sequence}`, `{shot}`, `{take}`, `{type}`, `{date}`, `{original}`, `{counter}` |
| **Default Player** | Browser (built-in), mrViewer2, or a custom player path |
| **Thumbnail Size** | Size of grid thumbnails (100–800px) |
| **Auto-generate Thumbnails** | Generate thumbnails automatically on import |
| **ComfyUI Output Path** | Point to your ComfyUI output folder for auto-import |
| **Roles** | Add, rename, recolor, or remove asset roles |
| **Watch Folders** | Directories to monitor for new files |
| **Keyboard Shortcuts** | Customize mrViewer2 hotkeys |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Backend** | Node.js + Express |
| **Database** | sql.js (WASM SQLite — no native compilation needed) |
| **Frontend** | Vanilla JavaScript (ES6 modules), HTML, CSS |
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
│   │   ├── projectRoutes.js   # Project CRUD
│   │   ├── assetRoutes.js     # Asset management, streaming, mrViewer2
│   │   ├── exportRoutes.js    # FFmpeg transcode/export
│   │   ├── roleRoutes.js      # Role management
│   │   ├── settingsRoutes.js  # Settings API
│   │   └── comfyuiRoutes.js   # ComfyUI integration
│   ├── services/
│   │   ├── ThumbnailService.js  # Thumbnail generation (Sharp + FFmpeg)
│   │   ├── MediaInfoService.js  # Metadata extraction (FFprobe)
│   │   ├── FileService.js       # File operations
│   │   └── WatcherService.js    # Folder watching (Chokidar)
│   └── utils/
│       └── mediaTypes.js      # File extension → media type mapping
├── public/
│   ├── index.html             # Single-page app shell
│   ├── css/styles.css         # Dark theme UI
│   └── js/                    # Frontend ES6 modules
│       ├── main.js            # Entry point, tab switching
│       ├── browser.js         # Asset browser, grid/list views
│       ├── import.js          # File browser, import flow
│       ├── export.js          # Export modal
│       ├── player.js          # Media player modal
│       ├── settings.js        # Settings tab
│       ├── api.js             # API client
│       ├── state.js           # Global state
│       └── utils.js           # Shared utilities
├── comfyui/
│   ├── mediavault_node.py     # Custom ComfyUI node
│   └── __init__.py
├── start.bat                  # Windows launcher
├── start.sh                   # macOS/Linux launcher
└── package.json
```

---

## Troubleshooting

### "FFmpeg not found"
DMV needs FFmpeg for video thumbnails, transcoding, and export. Install it and make sure it's in your system PATH:
- **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html), extract, and add the `bin/` folder to your PATH environment variable
- **macOS**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg`

### Port 7700 Already in Use
The Windows `start.bat` automatically clears port 7700 before starting. On Mac/Linux, find and kill the process:
```bash
lsof -i :7700
kill -9 <PID>
```

### Video Won't Play in Browser
Some professional codecs (ProRes, DNxHR) can't play directly in a web browser. DMV automatically transcodes these on-the-fly when you click Play. If it's not working, make sure FFmpeg is installed.

### Thumbnails Not Generating
- For **images**: Make sure the `sharp` npm package installed correctly (`npm install`)
- For **videos**: FFmpeg is required — verify with `ffmpeg -version`

### mrViewer2 Not Detected
DMV auto-discovers mrViewer2 in standard install locations:
- **Windows**: `C:\Program Files\vmrv2-*\bin\mrv2.exe`
- **macOS**: `/Applications/mrv2*.app`

If installed elsewhere, set the path manually in **Settings → External Player → Custom**.

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

## License

This software is proprietary. All rights reserved.
