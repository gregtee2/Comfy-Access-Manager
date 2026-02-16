# Comfy Asset Manager (CAM) — AI Agent Instructions

## Project Overview

**Comfy Asset Manager (CAM)** — formerly Digital Media Vault (DMV) — is a local media asset manager for creative production. Organize, browse, import, export, and play media files with a project-based hierarchy following ShotGrid/Flow Production Tracking naming conventions.

**Version**: 1.2.7
**Port**: 7700
**Repo**: `github.com/gregtee2/Digital-Media-Vault` (branches: `main`, `stable`)
**Status**: Active development (February 2026)
**Platforms**: macOS (primary dev), Windows (production users), Linux (supported)

### Install Locations (per platform)
| Platform | Install Dir | How Launched |
|----------|-------------|-------------|
| **macOS** | `~/Comfy-Asset-Manager/` | `/Applications/Comfy Asset Manager.app` (native Cocoa wrapper) or `./start.sh` |
| **Windows** | `C:\MediaVault` or `C:\Comfy-Asset-Manager` | `start.bat` |
| **Linux** | `~/Comfy-Asset-Manager/` | `./start.sh` |

Built for artists and studios who work with video, images, EXR sequences, 3D files, and audio, and want a fast way to manage them without cloud services.

---

## Architecture

### Tech Stack
- **Frontend**: Vanilla JavaScript ES6 modules, HTML, CSS (no build step, no framework)
- **Backend**: Node.js + Express
- **Database**: sql.js v1.11.0 (WASM SQLite — no native compilation needed)
- **Thumbnails**: Sharp (images), FFmpeg (video)
- **Transcode/Export**: FFmpeg (NVENC GPU on Windows, VideoToolbox on macOS, CPU fallback everywhere)
- **External Player**: OpenRV 3.1.0 (compiled from source, bundled in `tools/rv/`)
- **File Watching**: Chokidar (cross-platform)
- **File Upload**: multer (multipart form handling for DB import)
- **Network Discovery**: UDP broadcast on port 7701 (dgram, zero dependencies)
- **RV Plugin**: Python + PySide2/6 Qt dialog (auto-deployed on server start)
- **ComfyUI**: Custom Python nodes + JS dynamic dropdown extension
- **macOS Native App**: Objective-C / Cocoa framework wrapper

### File Structure (current, with line counts)
```
Comfy-Asset-Manager/
├── src/
│   ├── server.js                 # Express server entry (154 lines)
│   ├── database.js               # sql.js wrapper, better-sqlite3 compat API (448 lines)
│   ├── routes/
│   │   ├── assetRoutes.js        # Import, browse, stream, delete, RV launch, compare (1874 lines)
│   │   ├── projectRoutes.js      # Project + Sequence + Shot CRUD (349 lines)
│   │   ├── settingsRoutes.js     # Settings, vault setup, RV plugin sync, DB transfer (656 lines)
│   │   ├── exportRoutes.js       # FFmpeg transcode/export (488 lines)
│   │   ├── comfyuiRoutes.js      # ComfyUI integration endpoints + workflow extraction (515 lines)
│   │   ├── flowRoutes.js         # Flow/ShotGrid sync (188 lines)
│   │   ├── updateRoutes.js       # Auto-update from GitHub stable branch + PAT auth (226 lines)
│   │   ├── serverRoutes.js       # Network discovery, multi-machine (160 lines)
│   │   ├── transcodeRoutes.js    # Transcode queue management (109 lines)
│   │   └── roleRoutes.js        # Role CRUD (107 lines)
│   ├── services/
│   │   ├── TranscodeService.js   # FFmpeg transcode engine (496 lines)
│   │   ├── FileService.js        # File ops + cross-platform drive detection (474 lines)
│   │   ├── FlowService.js        # Flow/ShotGrid API client (394 lines)
│   │   ├── RVPluginSync.js       # Auto-deploy RV plugin via rvpkg CLI (341 lines)
│   │   ├── DiscoveryService.js   # UDP broadcast discovery on LAN (202 lines)
│   │   ├── ThumbnailService.js   # Thumbnail gen — Sharp + FFmpeg (194 lines)
│   │   ├── MediaInfoService.js   # Metadata extraction via FFprobe (164 lines)
│   │   └── WatcherService.js     # Chokidar folder watching (163 lines)
│   └── utils/
│       ├── naming.js             # ShotGrid naming engine (294 lines)
│       ├── pathResolver.js       # Cross-platform path mapping (149 lines)
│       ├── sequenceDetector.js   # EXR/DPX frame sequence grouping (150 lines)
│       └── mediaTypes.js         # File ext → media type mapping (114 lines)
├── public/
│   ├── index.html                # SPA shell (657 lines)
│   ├── popout-player.html        # Detachable media player (739 lines)
│   ├── css/styles.css            # Neutral gray VFX theme (2622 lines)
│   └── js/
│       ├── player.js             # Built-in media player modal (2082 lines)
│       ├── browser.js            # Asset browser, grid/list, tree nav, selection, context menu (1713 lines)
│       ├── settings.js           # Settings tab + network discovery + DB transfer UI (1097 lines)
│       ├── import.js             # File browser, import flow (764 lines)
│       ├── export.js             # Export modal (357 lines)
│       ├── main.js               # Entry point, tab switching (93 lines)
│       ├── utils.js              # Shared utilities (82 lines)
│       ├── state.js              # Global state singleton (40 lines)
│       └── api.js                # API client helper (26 lines)
├── rv-package/                   # OpenRV plugin (auto-deployed by RVPluginSync)
│   ├── mediavault_mode.py        # Full Qt asset picker + menus + auto-audio strip (838 lines)
│   ├── PACKAGE                   # RV package manifest
│   └── mediavault-1.0.rvpkg     # Pre-built rvpkg zip
├── comfyui/
│   ├── mediavault_node.py        # 3 custom ComfyUI nodes (873 lines)
│   ├── js/mediavault_dynamic.js  # Cascading dropdown extension (423 lines)
│   └── __init__.py
├── scripts/
│   ├── macos/main.m              # Native Cocoa .app source (397 lines)
│   ├── create-macos-app.sh       # Builds .app bundle for /Applications (291 lines)
│   ├── mac-install.sh            # One-line curl installer (59 lines)
│   ├── build.js                  # JS obfuscation for production (133 lines)
│   ├── flow_bridge.py            # Flow/ShotGrid Python bridge (311 lines)
│   ├── launch_player.ps1         # Windows force-foreground helper (85 lines) — DEAD CODE
│   ├── fix_collision_names.js    # DB migration utility (126 lines)
│   └── fix_timestamps.js         # DB migration utility (85 lines)
├── docs/
│   └── BUILD_OPENRV_MACOS.md     # macOS OpenRV compile guide (341 lines)
├── tools/rv/                     # Bundled OpenRV (downloaded during install)
├── data/mediavault.db            # SQLite database (auto-created)
├── thumbnails/                   # Generated thumbnails
├── logs/                         # Server logs (macOS .app)
├── install.sh                    # macOS/Linux installer (241 lines)
├── install.bat                   # Windows installer (231 lines)
├── install.command               # macOS Finder double-click wrapper
├── start.sh / start.command      # macOS/Linux launcher (79 lines)
├── start.bat                     # Windows launcher (51 lines)
├── MediaVault-AutoRestart.bat    # Windows watchdog (38 lines)
├── Getting Started.html          # Visual install guide (409 lines)
├── package.json
└── .github/copilot-instructions.md  # THIS FILE
```

---

## Cross-Platform Development Guide

### CRITICAL: Keeping Mac and Windows Congruent

The codebase is architected so that **95% of code is automatically cross-platform**. The Node.js backend and entire frontend have zero OS-specific logic. Platform differences are isolated to exactly 5 backend files and the installer/launcher scripts.

### Where Platform Branches Live

These are the ONLY files with `process.platform` checks. When adding features that touch these areas, **always add both platform branches in the same commit**:

| File | What Branches | Lines |
|------|---------------|-------|
| `FileService.js` `getDrives()` | Drive letter scan (Win) vs `/Volumes` + `mount` parse (Mac) vs `/mnt`+`/media` (Linux) | ~100 lines |
| `assetRoutes.js` `findRV()` | `rv.exe` paths (Win) vs `RV.app` bundle paths (Mac) vs `/usr/local/rv` (Linux) | ~90 lines |
| `assetRoutes.js` `findRvPush()`, `isRvRunning()` | `tasklist` (Win) vs `pgrep` (Mac/Linux) | ~15 lines |
| `ThumbnailService.js` `findFFmpeg()` | `C:\ffmpeg\` (Win) vs `/opt/homebrew/bin/` (Mac) vs `/usr/bin/` (Linux) | ~25 lines |
| `MediaInfoService.js` `findFFprobe()` | Same pattern as FFmpeg | ~20 lines |
| `FlowService.js` `_executeCommand()` | `python` (Win) vs `python3` (Mac/Linux) | 1 line |
| `assetRoutes.js` `findFontFile()` | `C:/Windows/Fonts/` (Win) vs `/System/Library/Fonts/` (Mac) | ~10 lines |

### Platform-Specific Files (not shared)

| macOS Only | Windows Only |
|------------|-------------|
| `install.sh` (241 lines) | `install.bat` (231 lines) |
| `start.sh` / `start.command` | `start.bat` (51 lines) |
| `scripts/macos/main.m` (Cocoa .app) | `MediaVault-AutoRestart.bat` |
| `scripts/create-macos-app.sh` | `scripts/launch_player.ps1` (DEAD CODE) |
| `scripts/mac-install.sh` (curl installer) | — |

### Everything Else is Shared
- All route files, all services, all frontend JS/HTML/CSS
- The `rv-package/mediavault_mode.py` plugin (Python + Qt, no OS branches)
- All npm dependencies (Sharp ships pre-built binaries for all OS)

### RV Plugin Auto-Sync System

**`src/services/RVPluginSync.js`** automatically deploys the MediaVault RV plugin on every server startup:

1. Builds a fresh `.rvpkg` (zip) from `rv-package/PACKAGE` + `mediavault_mode.py`
2. Scans for ALL RV installations via `findRVInstalls()` — returns `[{packagesDir, rvpkgBin}]`:
   - Bundled: `tools/rv/RV.app/Contents/PlugIns/Packages/` (Mac) or `tools/rv/Packages/` (Win)
   - System: `/Applications/RV*.app` (Mac) or `C:\Program Files\*RV*` (Win)
   - Self-compiled: `~/OpenRV/_build/...` or `C:\OpenRV\_build\...`
   - User-level: `~/.rv/Packages/` (all platforms — RV checks this automatically)
3. Deploys with MD5 hash check — skips if already current
4. Uses `zip` on Mac/Linux, PowerShell `Compress-Archive` on Windows
5. **Registers via `rvpkg` CLI** — runs `rvpkg -install -force <filename>` using the `rvpkg` binary found alongside each RV installation. This is required because RV has an internal package registry; just dropping a `.rvpkg` file is NOT enough (`rvpkg -list` would show `- L -` = present but not installed).
6. Falls back to manual `.py` file copy to `PlugIns/Python/` if no `rvpkg` binary available.

**Key exports**: `{ sync, findRVInstalls, buildRvpkg }`

**Workflow for plugin changes**: Edit `rv-package/mediavault_mode.py` on any platform → commit → push → other platform pulls → server restart auto-deploys the updated plugin to all RV installations.

**Manual re-sync**: `POST /api/settings/sync-rv-plugin`

**Gotcha**: `rvpkg -list` flags: `I` = Installed (registered), `L` = Loaded (file present), `O` = Optional. A package showing `- L -` means the file is there but NOT registered — the plugin won't load until `rvpkg -install` is run.

---

## Auto-Update System

**`src/routes/updateRoutes.js`** + frontend in `settings.js` provide one-click updates:

1. Frontend calls `GET /api/update/check` on page load
2. Backend fetches `package.json` from GitHub `stable` branch, compares semver
3. If newer: shows banner "A new version is available" with "Update Now" button
4. User clicks Update → `POST /api/update/apply`:
   - Temporarily sets git remote URL to include PAT (if configured)
   - `git fetch origin stable`
   - `git reset --hard origin/stable`
   - Restores clean remote URL (strips token)
   - `npm install`
   - Server restarts itself
5. On restart, `RVPluginSync.sync()` deploys any updated RV plugin

**Branches**: `main` = development, `stable` = tested releases pushed to users.

### Private Repository Support (GitHub PAT)

The GitHub repo is **private**. The auto-update system uses a GitHub **Personal Access Token (PAT)** stored in `data/config.json` (machine-local, not shared in DB or git).

**How it works:**
- `updateRoutes.js` reads `github_pat` from `config.json` via `loadConfig()`
- All GitHub API fetch() calls include `Authorization: token <PAT>` header
- `git fetch` temporarily sets the remote URL to `https://<PAT>@github.com/repo.git`, then restores it
- Token is NEVER committed to git or shared between machines

**Settings UI:**
- Settings → System Info → "🔑 GitHub Token" field
- Save/Clear buttons, status shows masked token
- Endpoints: `GET/POST /api/settings/github-token`

**Generating a PAT:**
1. GitHub → Settings → Developer Settings → Fine-grained Personal Access Tokens
2. "Generate new token" → select repo `gregtee2/Digital-Media-Vault`
3. Permissions: **Contents → Read-only** (that's all you need)
4. Copy token → paste into Settings UI

**IMPORTANT**: The auto-update system compares the `version` field in `package.json` (semver). If you push code changes without bumping the version, remote installs will report "up to date" even though files changed. **Always bump the version in `package.json` when pushing changes that should reach users via auto-update.** Use patch (`1.2.1`) for fixes, minor (`1.3.0`) for features.

---

## Database Transfer (Cross-Machine DB Sharing)

The Settings → "Database Transfer" section allows copying the full SQLite database between machines (e.g., PC → Mac). This is the primary way to share project/asset databases across platforms.

### Architecture
- **Backend**: 4 endpoints in `settingsRoutes.js` using `multer` for file uploads
- **Frontend**: Settings tab section with Export, Import, and Pull-from-Remote
- **Safety**: Auto-backup before every import/pull (`data/mediavault.db.backup-<timestamp>`), automatic rollback on failure
- **Validation**: Pull validates SQLite header (first 6 bytes = "SQLite") before replacing

### Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings/export-db` | GET | Streams DB as file download with timestamped filename |
| `/api/settings/db-info` | GET | Returns `{projects, assets, sequences, shots, fileSize, modified, path}` |
| `/api/settings/import-db` | POST | Multipart file upload (field: `database`), replaces current DB |
| `/api/settings/pull-db` | POST | `{url}` — downloads from remote CAM server's export endpoint |

### Import/Pull Flow
1. Backup current DB to `data/mediavault.db.backup-<timestamp>`
2. `closeDb()` — flush and close current sql.js instance
3. Replace `data/mediavault.db` with new file
4. `initDb()` — re-open database
5. On failure: restore from backup, re-init, return error

### Frontend Functions (settings.js)
- `loadDbInfo()` — shows current DB stats
- `exportDatabase()` — browser download via `window.location.href`
- `importDatabase(input)` — FormData upload with confirm dialog
- `pullRemoteDatabase()` — POST with URL; quick-pick buttons from discovered servers
- `loadDiscoveredServersForPull()` — shows saved + LAN-discovered servers as buttons

### After Pulling a Cross-Platform DB
Windows file paths (e.g., `Z:\Media\...`) won't resolve on Mac and vice versa. Use **Settings → Path Mappings** to map paths: `/Volumes/NAS` ↔ `Z:\`.

### Path Resolution (pathResolver.js)
`src/utils/pathResolver.js` handles bidirectional path mapping for cross-platform support:

| Function | Purpose |
|----------|---------|
| `resolveFilePath(path)` | Maps a stored DB path to the current platform (e.g., `Z:\MediaVault\...` → `/Volumes/home/AI Projects/MediaVault/...` on Mac) |
| `getAllPathVariants(path)` | Returns array of ALL platform path variants for a given path — used by `compare-targets-by-path` to find assets regardless of which platform stored them |

Path mappings are stored in the `settings` table as JSON (`path_mappings` key) and configured via Settings → Network → Path Mappings. The listing API (`GET /api/assets`) now resolves `file_path` for every asset so the frontend always sees platform-correct absolute paths.

### Asset Context Menu — Copy File Path
Right-click any asset → **"📋 Copy File Path"** copies the resolved absolute path to clipboard. Uses `navigator.clipboard.writeText()` with a `prompt()` fallback. Useful for debugging which file an asset actually points to on disk.

### Dependencies
- `multer` — multipart file upload handling (installed in `package.json`)
- `http`/`https` — Node built-ins for pull-from-remote

---

## Network Discovery & Multi-Machine

### DiscoveryService (UDP port 7701)
- `src/services/DiscoveryService.js` — binds UDP socket, responds to discovery broadcasts
- Protocol: JSON with magic `"DMV_DISCOVER"` header
- Returns: server name, version, platform, asset count, port, local IPs

### serverRoutes (/api/servers/*)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/servers/info` | GET | This server's identity |
| `/api/servers/discover` | GET | Scan LAN for other instances (2s timeout) |
| `/api/servers/saved` | GET | Bookmarked servers from settings |
| `/api/servers/save` | POST | Save a discovered server |
| `/api/servers/saved/:index` | DELETE | Remove a saved server |
| `/api/servers/ping` | POST | Check if a server is reachable |
| `/api/servers/name` | POST | Set this server's friendly name |
| `/api/servers/path-map` | GET/POST | Cross-OS path mappings (e.g. `/Volumes/NAS` = `Z:\`) |

### Frontend
- Network button in top bar opens server panel dropdown
- Scan for servers, save favorites, manual add by IP
- Path mapping UI for cross-platform NAS access (Mac sees `/Volumes/media`, Windows sees `Z:\media`)

---

## Network Drive Detection (FileService.getDrives)

Smart volume detection for NAS/SAN/external drives:

| Platform | How | What It Finds |
|----------|-----|---------------|
| **macOS** | Parses `mount` output, classifies by filesystem type | SMB/CIFS (Synology, etc), AFP, NFS, USB/Thunderbolt externals, APFS local |
| **Windows** | Scans drive letters A-Z, runs `net use` for mapped network drives | Network mapped drives, local drives |
| **Linux** | Scans `/mnt/*`, `/media/*`, parses `mount -t cifs,nfs,nfs4` | CIFS/NFS mounts, USB drives |

Returns objects with `{ path, name, type, icon, server }` — `type` is `network`, `external`, or `local`. Sorted network-first. Filters out hidden volumes, .dmg mounts, system partitions.

---

## macOS Native .app Bundle

### Architecture
`/Applications/Comfy Asset Manager.app` is a native Cocoa binary that:
1. Finds Node.js (checks homebrew `/opt/homebrew/bin/`, nvm, fnm, system PATH)
2. Starts `node src/server.js` as a child process (NSTask)
3. Shows a "Starting..." window with spinner while server boots
4. Polls `http://localhost:7700` until ready
5. Opens the default browser
6. Lives in the Dock with a proper icon
7. Menu bar: About, Open in Browser, Hide, Quit (Cmd+Q)
8. Cmd+Q sends SIGTERM to the Node process, waits for clean shutdown
9. Crash detection: if Node exits unexpectedly, offers restart dialog

### Source Files
- `scripts/macos/main.m` — Objective-C Cocoa AppDelegate (397 lines)
- `scripts/create-macos-app.sh` — Build script:
  - Compiles with `cc -framework Cocoa -fobjc-arc -mmacosx-version-min=12.0`
  - Generates icon via Python3 (dark gradient + folder + play button triangle)
  - Creates iconset with `sips` + `iconutil` -> `.icns`
  - Assembles `.app` bundle with `Info.plist` + `PkgInfo`
  - Ad-hoc code signs (`codesign --force --deep -s -`)
  - Registers with Launch Services for Spotlight

### Building
```bash
cd ~/Comfy-Asset-Manager
bash scripts/create-macos-app.sh
```
Requires Xcode Command Line Tools (`xcode-select --install`).

---

## Database Schema

sql.js (WASM SQLite). All queries go through `database.js` which wraps the raw sql.js API to be compatible with better-sqlite3's `.prepare().run/get/all()` pattern.

### Tables
| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `projects` | Top-level containers | id, name, code, type, flow_id |
| `sequences` | Groups shots within a project | id, project_id, name, code, flow_id |
| `shots` | Individual shots within sequences | id, sequence_id, **project_id**, name, code, flow_id |
| `assets` | Media files (the core table) | id, project_id, sequence_id, shot_id, role_id, original_name, vault_name, file_path, relative_path, media_type, is_linked, ... |
| `roles` | Pipeline steps (Comp, Light, Anim...) | id, name, code, color, icon, flow_id |
| `settings` | Key-value configuration | key, value |
| `watch_folders` | Monitored directories | id, path, project_id |
| `comfyui_mappings` | ComfyUI node->asset persistence | workflow_id, node_id, asset_id |
| `activity_log` | Action audit trail | action, entity_type, entity_id, details |

### CRITICAL: Shot Table Has BOTH sequence_id AND project_id
The `shots` table has both `sequence_id` and `project_id`. This is intentional because the shots query in `projectRoutes.js` filters on **both** columns:
```sql
SELECT * FROM shots WHERE sequence_id = ? AND project_id = ?
```
**If you migrate/restructure the hierarchy, you MUST update `project_id` on shots too!**

### Default Roles (seeded on first run)
Comp, Light, Anim, FX, Enviro, Layout, Matchmove, Roto

---

## ShotGrid Naming Convention

### Templates (naming.js)
| Context | Template | Example |
|---------|----------|--------|
| Shot + Role | `{shot}_{step}_v{version}` | `EDA1500_comp_v001.exr` |
| Sequence + Role | `{sequence}_{step}_v{version}` | `EDA_plate_v003.dpx` |
| Project + Role | `{project}_{step}_v{version}` | `AP1_edit_v001.mov` |
| Legacy (no role) | `{shot}_{take}_{counter}` | `EDA1500_T01_0001.mov` |

### CRITICAL: generateVaultName() Returns an Object
```javascript
// WRONG — returns { vaultName, ext } object, not a string!
const vaultName = naming.generateVaultName({ ... });

// CORRECT — destructure the result
const nameResult = naming.generateVaultName({ ... });
const vaultName = nameResult.vaultName;  // "AP1_EDA_EDA1500_comp_v001.exr"
const ext = nameResult.ext;              // ".exr"
```

---

## Import Modes

| Mode | Behavior | `is_linked` |
|------|----------|-------------|
| **Move** (default) | Files moved into vault folder structure. Originals removed. | 0 |
| **Copy** | Files copied into vault. Originals stay at source. | 0 |
| **Register in Place** | Files stay where they are. Only DB reference created. | 1 |

Register-in-place assets: `file_path` stores original absolute path, cannot be safely deleted from disk.

---

## OpenRV Integration

### RV Plugin (rv-package/mediavault_mode.py)

An 838-line Python plugin that adds a **MediaVault** menu to OpenRV's menu bar:

| Menu Item | Hotkey | What It Does |
|-----------|--------|-------------|
| Compare to... | Alt+V | Opens Qt asset picker dialog, loads selected asset as A/B wipe source |
| Switch to... | Alt+Shift+V | Opens Qt asset picker dialog, replaces current source |
| Prev Version | Alt+Left | Steps to previous version within same role |
| Next Version | Alt+Right | Steps to next version within same role |

**AssetPickerDialog**: Full Qt dialog (PySide2/PySide6) with:
- Left: Project/Sequence/Shot hierarchy tree
- Center: Scrollable asset table (Name, Role, Version, Date) with sorting
- Right: Role filter checkboxes
- Dark theme with teal (#2ec4b6) accent matching CAM's style

**API endpoint**: `GET /api/assets/compare-targets-by-path?path=<filepath>` — returns related assets with hierarchical fallback (shot -> sequence -> project). Uses `getAllPathVariants()` to try all platform path variants (Mac ↔ Windows) when looking up the asset.

**Connection**: Plugin connects to `http://127.0.0.1:7700` (NOT `localhost` — macOS resolves `localhost` to IPv6 `::1` first, which fails since the server binds IPv4 only).

**Auto-audio stripping**: `_stripAutoAudio()` runs after every Compare/Switch load. RV's built-in `source_setup` package scans nearby directories for audio files; on a NAS with multiple projects, this grabs unrelated audio from other project trees. The stripper handles all three vectors: (a) extra entries in `.media.movie`, (b) `.media.audio` property, (c) separate RVFileSource/RVSoundTrack nodes. Also clears `.request.audioFile`. Does NOT strip audio that's muxed inside the video container itself.

**Deployment**: Auto-deployed by `RVPluginSync.sync()` on server startup. No manual install needed.

### findRV() Path Priority (assetRoutes.js)
1. User-configured `rv_path` setting
2. Bundled: `tools/rv/RV.app/Contents/MacOS/RV` (Mac) or `tools/rv/bin/rv.exe` (Win)
3. Self-compiled: `~/OpenRV/_build/...` (Mac) or `C:\OpenRV\_build\...` (Win)
4. System installs: `/Applications/RV*.app` (Mac) or `C:\Program Files\*RV*` (Win) or `/opt/rv` (Linux)

### OpenRV Build Status
| Platform | Status | Binary Location |
|----------|--------|----------------|
| **macOS arm64** | Compiled from source, bundled as zip on GitHub Release `rv-3.1.0` | `tools/rv/RV.app` (642 MB zip) |
| **Windows x64** | Compiled from source, bundled as zip on GitHub Release `rv-3.1.0` | `tools/rv/bin/rv.exe` (272 MB zip) |
| **Linux** | Not pre-built — user compiles from OpenRV source | — |

Both builds include ProRes, DNxHD, AAC, AC3 codecs enabled.

### OpenRV macOS Build Reference
Full build guide: `docs/BUILD_OPENRV_MACOS.md`
- Build environment: Xcode 16.4, CMake, Qt 5.15.17, Python 3.11 (VFX CY2024)
- Uses `rvcmds.sh` helper script for bootstrap/configure/build cycle
- Pro codec flags: `-DRV_FFMPEG_NON_FREE_DECODERS_TO_ENABLE="dnxhd;prores;aac;aac_fixed;aac_latm;ac3;qtrle"`

### OpenRV Windows Build Reference
- Build environment: VS 2022 Build Tools, CMake 4.0.3, Qt 6.5.3, MSYS2, Strawberry Perl
- **Must run from MSYS2 MinGW64 shell** (FFmpeg configure is a bash script)
- `PKG_CONFIG_LIBDIR` must point to only OpenRV's built deps (not system OpenSSL)
- `CMAKE_POLICY_VERSION_MINIMUM=3.5` required for CMake 4.x compatibility
- AJA plugin disabled (moved `src/plugins/output/AJADevices` out of source tree)

---

## ComfyUI Integration

### Architecture
```
ComfyUI (Python + LiteGraph)
    |
    custom_nodes/mediavault -> symlink to CAM's comfyui/ directory
    |
    ├── mediavault_node.py (3 nodes)
    │   ├── LoadFromMediaVault — Load image by hierarchy selection
    │   ├── LoadVideoFrameFromMediaVault — Load video frame by number
    │   └── SaveToMediaVault — Save ComfyUI output back to vault
    │
    ├── js/mediavault_dynamic.js (frontend extension)
    │   ├── Cascading dropdowns: Project -> Sequence -> Shot -> Role -> Asset
    │   ├── prefillFromLoadNode(saveNode) — auto-copies hierarchy from Load node
    │   ├── "Copy from Load Node" button on Save nodes
    │   ├── Refresh button — re-queries all dropdowns without restart
    │   └── setup() — picks up pending workflow on ?cam_load=1 URL param
    │
    └── Proxy Routes (registered via PromptServer)
        ├── /mediavault/projects
        ├── /mediavault/sequences?project_id=X
        ├── /mediavault/shots?project_id=X&sequence_id=Y
        ├── /mediavault/roles
        ├── /mediavault/assets?project_id=X&...
        ├── POST /mediavault/load-workflow  — Store pending workflow (one-shot)
        └── GET  /mediavault/load-workflow  — Retrieve & clear pending workflow
```

**CRITICAL**: `INPUT_TYPES` classmethod runs once at node registration. New projects require ComfyUI restart or the Refresh button.

**Symlink setup**:
- Windows: `mklink /J ComfyUI\custom_nodes\mediavault C:\MediaVault\comfyui`
- Mac/Linux: `ln -s ~/Comfy-Asset-Manager/comfyui ~/ComfyUI/custom_nodes/mediavault`

### Load in ComfyUI (Right-Click → 🎨 Load in ComfyUI)

Right-click any PNG or video asset that was generated by ComfyUI to extract the embedded workflow and load it directly into ComfyUI.

**5-Component Flow:**
```
1. CAM Frontend (browser.js)     — Right-click → "Load in ComfyUI" → POST /api/comfyui/load-in-comfy/:id
2. CAM Backend (comfyuiRoutes.js) — Extract workflow from file metadata (ffprobe for video, tEXt for PNG)
3. CAM Backend → ComfyUI Python   — POST workflow JSON to /mediavault/load-workflow (one-shot storage)
4. CAM Frontend                    — window.open(comfyUrl + '?cam_load=1', 'comfyui') — reuses same tab
5. ComfyUI JS Extension (setup()) — Detects ?cam_load param → GET /mediavault/load-workflow → app.loadGraphData()
```

**Workflow Extraction:**
- **Video** (MP4/WebM/MKV/MOV/AVI): `ffprobe -show_format` → `format.tags.comment` → JSON parse
- **PNG**: Binary tEXt chunk scan for keyword `"workflow"` → JSON parse
- ComfyUI embeds workflow JSON automatically when using VHS video output or standard image save

**One-Shot Pattern:** Python global `_pending_workflow` stores workflow on POST, returns and clears on GET. This avoids CORS issues (JS extension fetches from its own origin) and ensures stale workflows don't persist.

**Settings:** ComfyUI URL is configurable in Settings tab (default `http://127.0.0.1:8188`), stored as `comfyui_url` setting.

**⚠️ IMPORTANT:** If ComfyUI returns 404 on `/mediavault/load-workflow`, it means ComfyUI needs to be restarted to pick up the new Python routes in `mediavault_node.py`.

---

## API Endpoints Reference

### Projects
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/projects` | GET | List all projects |
| `/api/projects` | POST | Create project |
| `/api/projects/:id` | GET | Get project with stats |
| `/api/projects/:id` | DELETE | Delete project + assets |
| `/api/projects/:id/sequences` | GET/POST | List/create sequences |
| `/api/projects/:projectId/sequences/:seqId/shots` | GET/POST | List/create shots |

### Assets
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/assets` | GET | List/filter assets |
| `/api/assets/import` | POST | Import files (move/copy/register) |
| `/api/assets/browse` | GET | Browse filesystem (drives + directories) |
| `/api/assets/:id` | GET/DELETE | Get/delete single asset |
| `/api/assets/bulk-delete` | POST | Bulk delete |
| `/api/assets/:id/stream` | GET | Stream media file |
| `/api/assets/:id/thumbnail` | GET | Get thumbnail |
| `/api/assets/open-compare` | POST | Launch RV with A/B wipe comparison |
| `/api/assets/compare-targets-by-path` | GET | Find related assets for RV plugin |
| `/api/assets/viewer-status` | GET | Check if RV is running/available |

### Settings
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings` | GET/POST | Get/save all settings |
| `/api/settings/status` | GET | System status (vault configured, asset count) |
| `/api/settings/setup-vault` | POST | First-time vault setup |
| `/api/settings/sync-rv-plugin` | POST | Force re-deploy RV plugin to all installations |
| `/api/settings/export-db` | GET | Download SQLite database file (timestamped filename) |
| `/api/settings/db-info` | GET | Database stats (projects, assets, sequences, shots, fileSize) |
| `/api/settings/import-db` | POST | Upload & replace database (multer multipart, auto-backup + rollback) |
| `/api/settings/pull-db` | POST | Pull database from remote CAM server by URL (validates SQLite header) |

### Export & Transcode
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/export/presets` | GET | Available codecs + resolutions |
| `/api/export/probe/:id` | GET | FFprobe asset info |
| `/api/export` | POST | Start export job |
| `/api/transcode` | POST | Start transcode job |

### Update
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/update/check` | GET | Check GitHub stable branch for new version |
| `/api/update/version` | GET | Current local version |
| `/api/update/apply` | POST | Pull latest + npm install + restart |
| `/api/update/health` | GET | Health check (for restart detection) |

### Network Discovery
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/servers/info` | GET | This server's identity |
| `/api/servers/discover` | GET | Scan LAN for other instances |
| `/api/servers/saved` | GET/POST | Bookmarked servers |
| `/api/servers/ping` | POST | Check server reachability |
| `/api/servers/path-map` | GET/POST | Cross-OS path mappings |

### Roles, ComfyUI, Flow
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/roles` | GET/POST | List/create roles |
| `/api/roles/:id` | PUT/DELETE | Update/delete role |
| `/api/comfyui/*` | GET/POST | ComfyUI dropdown data + save |
| `/api/comfyui/status` | GET | Check if ComfyUI is reachable |
| `/api/comfyui/check-workflow/:id` | GET | Check if asset has embedded ComfyUI workflow |
| `/api/comfyui/load-in-comfy/:id` | POST | Extract workflow + send to ComfyUI + return URL |
| `/api/flow/*` | GET/POST | Flow/ShotGrid sync (awaiting credentials) |

---

## Frontend Architecture

### Module Structure
All frontend code uses ES6 modules loaded from `/js/main.js`. **No React, no build step, no JSX.** Use `document.createElement()` or template literals.

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `main.js` | Entry point, tab switching, vault setup | `switchTab()` |
| `state.js` | Global state singleton | `state` object |
| `api.js` | Fetch wrapper with error handling | `api(url, opts)` |
| `browser.js` | Projects grid, tree nav, asset grid/list, selection, drag-drop | `loadProjects()`, `loadTree()` |
| `import.js` | File browser, import flow, rename preview | `loadImportTab()` |
| `export.js` | Export modal with codec/resolution selection | `showExportModal()` |
| `player.js` | Built-in media player modal + popout | `openPlayer()` |
| `settings.js` | Settings tab, roles, watch folders, network discovery, update banner | `loadSettings()`, `loadRoles()` |
| `utils.js` | Shared utilities | `esc()`, `formatSize()`, `showToast()` |

### Tab System
4 tabs: **Projects**, **Browser**, **Import**, **Settings** — controlled by `data-tab` attributes.

### CSS Theme
Neutral gray for VFX / color-critical work. No saturated accent colors.
- Variables: `--bg-dark: #1a1a1a`, `--bg-card: #222222`, `--accent: #888888`
- Media type colors: video (#88aacc), image (#88aa88), audio (#aa88aa), EXR (#bb9966)

### All onclick handlers must be on `window`
ES6 modules scope functions. Expose via `window.functionName = functionName` for onclick in HTML.

---

## Server Startup Sequence

When `node src/server.js` runs (or the .app launches it):

1. `initDb()` — Initialize sql.js WASM SQLite
2. `app.listen(PORT)` — Start Express on port 7700
3. `WatcherService.start()` — Resume folder watching
4. **`RVPluginSync.sync()`** — Build and deploy MediaVault RV plugin to all detected RV installations
5. `DiscoveryService.start()` — Bind UDP 7701 for network discovery
6. Register SIGINT/SIGTERM handlers for graceful shutdown

---

## Git Workflow & Deployment

```bash
# Development on main
git add -A && git commit -m "feat: Description" && git push origin main

# Deploy to stable (triggers auto-update for users)
git checkout stable && git merge main --ff-only && git push origin stable && git checkout main
```

Users pick up updates automatically via the in-app update banner.

### Commit Prefixes
- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `refactor:` — Code restructure
- `chore:` — Maintenance

---

## Important Rules for AI Agents

1. **Port is 7700** — `http://localhost:7700`
2. **Database is sql.js (WASM)** — NOT better-sqlite3. The wrapper in database.js provides compatibility.
3. **`generateVaultName()` returns `{ vaultName, ext }`** — Always destructure! Never assign to a string.
4. **Shots have both `sequence_id` AND `project_id`** — Update both when migrating.
5. **Frontend is plain ES6 modules** — No React, no build step. `document.createElement()` or template literals.
6. **All onclick must be on `window`** — ES6 modules scope functions.
7. **Database auto-saves on every write** — `_save()` called after each `.run()`. Use `wrapper.transaction()` for batches.
8. **Neutral gray theme** — No saturated accent colors. VFX color-critical work.
9. **FFmpeg is required** — For thumbnails, transcoding, streaming, export.
10. **`is_linked = 1` = register-in-place** — Cannot safely delete from disk. Warn the user.
11. **Platform branches in exactly 5 files** — See "Cross-Platform Development Guide" above. Always add both branches.
12. **RV plugin auto-deploys** — Edit `rv-package/mediavault_mode.py`, commit, push. Server restart deploys everywhere.
13. **Auto-update via stable branch** — Push to `stable` = users get the update.
14. **ComfyUI junction/symlink** — `custom_nodes/mediavault` points to CAM's `comfyui/` directory.
15. **Settings are key-value** — `getSetting(key)` / `setSetting(key, value)` in the `settings` table.
16. **Activity log** — `logActivity(action, entityType, entityId, details)` for audit trail.
17. **GitHub PAT for updates** — Repo is private. PAT stored in `data/config.json` (machine-local). See "Private Repository Support" section.

---

## Known Issues & Pinned Features

### FFmpeg Burn-In Bug (Pinned)
FFmpeg's drawtext fails when chaining 3+ filters with expressions (`y=ih-26`). Fix: pre-calculate dimensions with ffprobe, use static pixel values.

### Flow/ShotGrid Integration (Pinned — awaiting credentials)
UI in Settings tab ready. `flowRoutes.js` + `FlowService.js` + `flow_bridge.py` implemented. Needs ShotGrid API credentials.

### Route Order Bug (Known)
`router.get('/:id')` catches before `/viewer-status` in assetRoutes.js. Move `/viewer-status` above `/:id` to fix.

### Dead Code
- `scripts/launch_player.ps1` — Windows force-foreground helper, never called from any JS code.
- `test_ffmpeg_filter.js`, `test_arial.ttf` — Cleanup needed from root directory.

---

## Recent Development History (February 2026)

| Commit | What Changed |
|--------|-------------|
| `8913e48` | Auto-deploy RV plugin on server startup (cross-platform sync) |
| `dc69339` | Native macOS .app bundle for /Applications |
| `58aceae` | Network discovery & multi-machine server switcher |
| `879ffb9` | Smart network drive detection (Synology, SMB, AFP, NFS) |
| `e02e6e8` | Detect Intel RV, offer arm64 download |
| `f4b71da` | Getting Started.html visual install guide |
| `cbe5327` | One-line Mac installer (curl pipe) |
| `b32a7ca` | Idiot-proof installer UX |
| `64584ba` | macOS OpenRV support + cross-platform findRV() |
| `c355051` | Rebrand to Comfy Asset Manager v1.1.0 |
| `5881a61` | Qt asset picker dialog in RV plugin |
| `9e26d8a` | Copyright headers + JS obfuscation build step |
| `aa71e1b` | Fix RV plugin deployment — copy .py to PlugIns/Python |
| `690df7f` | Fix RV plugin registration — use rvpkg CLI (`rvpkg -install -force`) |
| `25bc482` | Database Transfer: export, import, pull-from-remote in Settings UI |
| `6168f18` | Safari filter dropdown fix (v1.2.1) — inline onchange → addEventListener |
| `db99519` | Remove card jiggle (v1.2.2) — removed translateY(-1px) from hover/selected |
| `dc03c69` | Eliminate grid flicker (v1.2.3) — updateSelectionClasses() instead of full DOM rebuild |
| `79ae23d` | RV image sequence support (v1.2.4) — frame-range notation for sequences |
| `e4aaad2` | RV plugin 127.0.0.1 fix + getAllPathVariants() cross-platform path lookup |
| `8912963` | Aggressive auto-audio stripping in RV plugin (_stripAutoAudio handles 3 vectors) |
| `2e05469` | Copy File Path in asset context menu + resolve file_path in listing API |
| `3069534` | Version bump to 1.2.5 + CHANGELOG entries |
| `ab7a1fe` | Load in ComfyUI — right-click to extract embedded workflow and send to ComfyUI |

---

*Built for VFX artists who need fast, local media management without cloud services.*
