# Comfy Asset Manager (CAM) — AI Agent Instructions

## Project Overview

**Comfy Asset Manager (CAM)** — formerly Digital Media Vault (DMV) — is a local media asset manager for creative production. Organize, browse, import, export, and play media files with a project-based hierarchy following ShotGrid/Flow Production Tracking naming conventions.

**Version**: 1.4.1
**Port**: 7700
**Repo**: `github.com/gregtee2/Comfy-Access-Manager` (branches: `main`, `stable`)
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
- **Database**: better-sqlite3 (Native SQLite — replaced sql.js for better performance)
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
│   ├── server.js                 # Express server entry (140 lines)
│   ├── database.js               # better-sqlite3 wrapper, config.json (615 lines)
│   ├── routes/
│   │   ├── assetRoutes.js        # Import, browse, stream, delete, RV launch, compare, overlay (1817 lines)
│   │   ├── projectRoutes.js      # Project + Sequence + Shot CRUD + access control (497 lines)
│   │   ├── userRoutes.js         # User CRUD, PIN auth, project hiding (blacklist) (220 lines)
│   │   ├── settingsRoutes.js     # Settings, vault setup, RV plugin sync, DB transfer, Smart Ingest (739 lines)
│   │   ├── exportRoutes.js       # FFmpeg transcode/export (488 lines)
│   │   ├── comfyuiRoutes.js      # ComfyUI integration endpoints + workflow extraction (515 lines)
│   │   ├── resolveRoutes.js       # DaVinci Resolve bridge — send to bins, status (229 lines)
│   │   ├── flowRoutes.js         # Flow/ShotGrid sync (188 lines)
│   │   ├── updateRoutes.js       # Auto-update from GitHub stable branch + PAT auth (226 lines)
│   │   ├── serverRoutes.js       # Network discovery, multi-machine (160 lines)
│   │   ├── transcodeRoutes.js    # Transcode queue management (109 lines)
│   │   └── roleRoutes.js        # Role CRUD (107 lines)
│   ├── services/
│   │   ├── TranscodeService.js   # FFmpeg transcode engine (496 lines)
│   │   ├── FileService.js        # File ops + cross-platform drive detection (474 lines)
│   │   ├── FlowService.js        # Flow/ShotGrid API client (394 lines)
│   │   ├── RVPluginSync.js       # Auto-deploy RV plugin via rvpkg CLI (347 lines)
│   │   ├── DiscoveryService.js   # UDP broadcast discovery on LAN (202 lines)
│   │   ├── ThumbnailService.js   # Thumbnail gen — Sharp + FFmpeg (194 lines)
│   │   ├── MediaInfoService.js   # Metadata extraction via FFprobe (164 lines)
│   │   └── WatcherService.js     # Chokidar folder watching (163 lines)
│   └── utils/
│       ├── naming.js             # ShotGrid naming engine (294 lines)
│       ├── pathResolver.js       # Cross-platform path mapping (149 lines)
│       ├── sequenceDetector.js   # EXR/DPX frame sequence grouping (140 lines)
│       └── mediaTypes.js         # File ext → media type mapping (114 lines)
├── public/
│   ├── index.html                # SPA shell (800 lines)
│   ├── popout-player.html        # Detachable media player (739 lines)
│   ├── css/styles.css            # Neutral gray VFX theme (3150 lines)
│   └── js/
│       ├── player.js             # Built-in media player modal (2082 lines)
│       ├── browser.js            # Asset browser, grid/list, tree nav, selection, context menu, hide-from-users, Send to Resolve (1995 lines)
│       ├── settings.js           # Settings tab + network discovery + Preferences + DB transfer + team/PIN (1420 lines)
│       ├── import.js             # File browser, import flow, Quick Access sidebar, SSE progress, Smart Ingest (1160 lines)
│       ├── export.js             # Export modal (357 lines)
│       ├── main.js               # Entry point, tab switching, PIN prompt, server discovery (290 lines)
│       ├── utils.js              # Shared utilities (82 lines)
│       ├── state.js              # Global state singleton (40 lines)
│       ├── api.js                # API client helper (26 lines)
│       └── lib/mp4box.all.js     # MP4 parsing library (player dependency)
├── public/js-dist/               # Obfuscated production build (generated by npm run build — DO NOT EDIT)
├── rv-package/                   # OpenRV plugin (auto-deployed by RVPluginSync)
│   ├── mediavault_mode.py        # Full Qt asset picker + menus + overlay system (1093 lines)
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
│   ├── resolve_bridge.py          # DaVinci Resolve Python bridge — 4 commands (266 lines)
│   ├── flow_bridge.py            # Flow/ShotGrid Python bridge (311 lines)
│   ├── launch_player.ps1         # Windows force-foreground helper (85 lines) — DEAD CODE
│   ├── fix_collision_names.js    # DB migration utility (126 lines)
│   └── fix_timestamps.js         # DB migration utility (85 lines)
├── docs/
│   └── BUILD_OPENRV_MACOS.md     # macOS OpenRV compile guide (341 lines)
├── tools/rv/                     # Bundled OpenRV (downloaded during install)
├── data/mediavault.db            # SQLite database (auto-created)
├── data/config.json              # Machine-local config: GitHub PAT, custom DB path (NOT in git)
├── thumbnails/                   # Generated thumbnails
├── logs/                         # Server logs (macOS .app)
├── install.sh                    # macOS/Linux installer (241 lines)
├── install.bat                   # Windows installer (299 lines)
├── install.command               # macOS Finder double-click wrapper
├── start.sh / start.command      # macOS/Linux launcher (79 lines)
├── start.bat                     # Windows launcher (69 lines)
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
| `assetRoutes.js` `findFontFile()` | `C:/Windows/Fonts/` (Win) vs `/System/Library/Fonts/` (Mac) | ~10 lines |
| `ThumbnailService.js` `findFFmpeg()` | `C:\ffmpeg\` (Win) vs `/opt/homebrew/bin/` (Mac) vs `/usr/bin/` (Linux) | ~25 lines |
| `MediaInfoService.js` `findFFprobe()` | Same pattern as FFmpeg | ~20 lines |
| `FlowService.js` `_executeCommand()` | `python` (Win) vs `python3` (Mac/Linux) | 1 line |
| `resolveRoutes.js` `_getResolveModulesPath/LibPath()` | `fusionscript.dll` paths (Win) vs `fusionscript.so` paths (Mac/Linux) | ~30 lines |
| `TranscodeService.js` `h264_mov.buildArgs()` | `h264_nvenc` (Win) vs `h264_videotoolbox` (Mac), both fall back to `libx264` | ~15 lines |
| `exportRoutes.js` `CODEC_PRESETS`, `CODEC_NAME_MAP` | `h264_nvenc`/`hevc_nvenc` (Win) vs `h264_videotoolbox`/`hevc_videotoolbox` (Mac), GPU→CPU fallback | ~30 lines |
| `updateRoutes.js` | Remote URL token injection (same logic, no OS branch needed) | — |
| `RVPluginSync.js` `findRVInstalls()` | `rv.exe` paths (Win) vs `RV.app` bundle paths (Mac), `tar`/`zip` for rvpkg | ~60 lines |
| `pathResolver.js` `resolveFilePath()` | Drive-letter↔`/Volumes` bidirectional path mapping | ~30 lines |

### Platform-Specific Files (not shared)

| macOS Only | Windows Only |
|------------|-------------|
| `install.sh` (241 lines) | `install.bat` (299 lines) |
| `start.sh` / `start.command` | `start.bat` (69 lines) |
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
4. Uses `tar -a -cf` on Windows, `zip -j` on Mac/Linux (avoids PowerShell path issues)
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
2. "Generate new token" → select repo `gregtee2/Comfy-Access-Manager`
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
2. `closeDb()` — flush and close current database instance
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

### Asset Context Menu — Show File Path
Right-click any asset → **"📂 Show File Path"** opens a modal dialog showing the resolved absolute path on disk. The path is displayed in a copyable input field with a "Copy" button. Useful for debugging which file an asset actually points to.

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

better-sqlite3 (Native SQLite). All queries go through `database.js` which wraps the better-sqlite3 API.

### database.js Exports

| Export | Purpose |
|--------|---------|
| `initDb()` | Initialize database, create tables, seed roles |
| `closeDb()` | Flush and close database (used before DB import/pull) |
| `getDb()` | Get the database wrapper instance |
| `getSetting(key)` / `setSetting(key, value)` | Read/write settings table |
| `logActivity(action, type, id, details)` | Write to activity_log table |
| `loadConfig()` / `saveConfig(cfg)` | Read/write `data/config.json` (machine-local, NOT in git) |
| `resolveDbPath()` | Get DB path from config.json or default `data/mediavault.db` |
| `reloadFromDisk()` | Hot-reload DB from disk (used after external writes) |

**`data/config.json`** stores machine-local configuration that should NOT be shared between machines or committed to git:
```json
{
  "github_pat": "ghp_xxxxx",     // GitHub Personal Access Token for auto-updates
  "db_path": null                 // Custom DB path (null = default data/mediavault.db)
}
```

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
| `users` | Team member profiles | id, name, role (admin/user), pin_hash (SHA-256, nullable) |
| `project_hidden` | Blacklist: hide projects from users | id, user_id, project_id, UNIQUE(user_id, project_id) |
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

### Shot Builder (Drag-and-Drop Convention Editor)

**Location**: `public/js/shotBuilder.js` (frontend module) + `src/utils/naming.js` (backend engine)

Projects can define a custom **naming convention** via a drag-and-drop tile interface in the Edit Project modal. Users drag token tiles (Project, Episode, Sequence, Shot, Role, Version, etc.) into an assembly row and configure separators between them.

**Convention Storage**: JSON array on `projects.naming_convention` column:
```json
[
  { "type": "project", "separator": "" },
  { "type": "episode", "separator": "" },
  { "type": "sequence", "separator": "_" },
  { "type": "shot", "separator": "_" }
]
```

**Episode Field**: Projects have a dedicated `episode` column (TEXT). Set in Edit Project modal. This is the value used for the `episode` token in naming conventions. It is NOT derived from sequences — it's its own field.

**How Convention is Applied**:
1. `generateFromConvention(convention, values, ext)` in `naming.js` resolves tokens to actual values
2. Values passed in: `{ project: code, episode: project.episode, sequence: seq.name, shot: shot.name, role: role.code, version: auto-detected }`
3. **Names (not codes)** are used for sequence/shot tokens — user sees `011` not `SQ010`
4. **Codes** are used for folder paths on disk — `RGU/SQ010/SH010/`
5. Role and Version tokens are only included if the user dragged them into the convention

**Preview**: Live preview in the Shot Builder shows the actual resolved filename with a legend showing `label:value` pairs so the user knows where each part comes from.

**ComfyUI Integration**: When the Save to MediaVault node saves, `comfyuiRoutes.js` reads the project's convention and calls `generateFromConvention()` with real names. The `overrideVaultName` is passed to `FileService.importFile()`.

**Key Files**:
| File | Purpose |
|------|---------|
| `public/js/shotBuilder.js` | Drag-and-drop UI module (ES6) |
| `src/utils/naming.js` | `generateFromConvention()` + `getNextVersion()` |
| `src/routes/projectRoutes.js` | CRUD for projects with `naming_convention` + `episode` columns |
| `src/routes/comfyuiRoutes.js` | Applies convention when saving from ComfyUI |
| `src/routes/assetRoutes.js` | Applies convention during normal import |
| `src/services/FileService.js` | `overrideVaultName` option in `importFile()` |

### Templates (naming.js) — Legacy Defaults
Used when no Shot Builder convention is defined on the project:
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

### Import Progress Bar (SSE Streaming)

For imports of 2+ files, the frontend uses **Server-Sent Events** for live progress:

**Backend** (`assetRoutes.js`): When POST `/api/assets/import?stream=1` is used, the endpoint sends SSE events as each file/sequence is processed:
```
data: {"current": 3, "total": 47, "file": "render_0003.exr"}
...
event: done
data: {"imported": 47, "errors": 0, ...}
```

**Frontend** (`import.js`): `importWithProgress(body, progressFill, progressText)` uses `fetch()` + `ReadableStream` reader to parse SSE events and update the progress bar in real-time. Falls back to normal JSON `api()` call for single-file imports.

**UI**: Progress bar is 22px tall with a text overlay showing `"3 / 47 — render_0003.exr"`. On completion shows `"✅ 47 imported"`.

### Sequence Detection (sequenceDetector.js)

`detectSequences(files)` groups files that look like frame sequences (e.g., `render.0001.exr`, `render.0002.exr` → one sequence).

**⚠️ CRITICAL: Video containers are excluded.** The `VIDEO_CONTAINER_EXTS` set (`.mov`, `.mp4`, `.avi`, `.mkv`, `.webm`, `.flv`, `.wmv`, `.m4v`, `.ts`, `.mts`, `.m2ts`, `.3gp`, `.mxf`) prevents files like `comfy_00001.mp4` from being detected as frame sequences. This was a **data-loss bug** — videos with numeric filenames were grouped as "sequences", causing one file to overwrite others during import.

**Sequence vault naming** uses an incrementing `seqCounter` (not hardcoded `1`) with collision detection to prevent multiple sequences getting identical base names.

---

## Smart Ingest System (v1.3.0)

### Overview
Smart Ingest adds an **Inbox** workflow to the Import tab. Watch folders are configured per-project — when files appear in a watch folder, they show up in the Inbox panel with a live preview of how they'll be renamed using the project's naming convention.

### Architecture
```
Watch Folder (Z:\Inbox\ProjectX\_inbox)
    ↓
GET /api/settings/watches/inbox    ← scans all watch folders for files
    ↓
Import Tab → Inbox Panel           ← user selects files, previews names
    ↓
POST /api/assets/import             ← standard import with naming convention
    ↓
(if Move mode) POST /api/settings/watches/:id/cleanup  ← moves originals to _ingested/
```

### Watch Folder Configuration
- Configured in **Settings → Watch Folders** per project
- Each watch folder has: `path`, `project_id`, `sequence_id`, `shot_id`, `role_id`
- Files in the folder are scanned via `GET /api/settings/watches/inbox`
- Stored in `watch_folders` database table

### Import Mode Behavior (CRITICAL)
The Inbox respects the import mode radio button in the Import tab:

| Mode | What Happens to Originals | Cleanup Called? |
|------|--------------------------|----------------|
| **Move** | Moved to `_ingested/` subfolder after import | Yes (with confirmation prompt) |
| **Copy** | Kept in place, untouched | No |
| **Register** | Kept in place (DB reference only) | No |

### Cleanup Endpoint
`POST /api/settings/watches/:id/cleanup` moves ingested files from the watch folder into an `_ingested/` subfolder:
- Creates `_ingested/` directory if needed
- Handles filename collisions with counter suffix (`file_2.exr`)
- Only called for **Move** mode; intentionally skipped for Copy and Register

### Key Functions (import.js)
- `loadInboxes()` — scans all watch folders, renders inbox panel with file previews
- `executeIngest()` — imports selected inbox files, respects import mode, conditionally cleans up
- Rename preview shows how naming convention will transform the filename

### ⚠️ Copy Mode Must NOT Delete Originals
This was a real bug (commit `4ccf32b`): `executeIngest()` was hardcoded to always call the cleanup endpoint, which moved originals to `_ingested/`. For **Copy** mode, originals must remain untouched.

---

## Role Color Readability (v1.3.0)

`browser.js` includes an `ensureReadableColor(hex)` helper that auto-lightens role colors with low luminance to prevent invisible-on-dark-bg text in the tree navigation. Roles set inline `style="color:${role.color}"` which overrides any CSS rule — this helper ensures the color is always visible.

**Threshold**: Luminance < 90 (out of 255) → boost all RGB channels by 80.

---

## OpenRV Integration

### RV Plugin (rv-package/mediavault_mode.py)

A 1093-line Python plugin that adds a **MediaVault** menu and **OpenGL overlay system** to OpenRV:

| Menu Item | Hotkey | What It Does |
|-----------|--------|-------------|
| Compare to... | Alt+V | Opens Qt asset picker dialog, loads selected asset as A/B wipe source |
| Switch to... | Alt+Shift+V | Opens Qt asset picker dialog, replaces current source |
| Prev Version | Alt+Left | Steps to previous version within same role |
| Next Version | Alt+Right | Steps to next version within same role |
| Toggle Overlay | Shift+O | Show/hide metadata burn-in, status stamp, and watermark |

**AssetPickerDialog**: Full Qt dialog (PySide2/PySide6) with:
- Left: Project/Sequence/Shot hierarchy tree
- Center: Scrollable asset table (Name, Role, Version, Date) with sorting
- Right: Role filter checkboxes
- Dark theme with teal (#2ec4b6) accent matching CAM's style

**API endpoint**: `GET /api/assets/compare-targets-by-path?path=<filepath>` — returns related assets with hierarchical fallback (shot -> sequence -> project). Uses `getAllPathVariants()` to try all platform path variants (Mac ↔ Windows) when looking up the asset.

**Connection**: Plugin connects to `http://127.0.0.1:7700` (NOT `localhost` — macOS resolves `localhost` to IPv6 `::1` first, which fails since the server binds IPv4 only).

**Auto-audio stripping**: `_stripAutoAudio()` runs after every Compare/Switch load. RV's built-in `source_setup` package scans nearby directories for audio files; on a NAS with multiple projects, this grabs unrelated audio from other project trees. The stripper handles all three vectors: (a) extra entries in `.media.movie`, (b) `.media.audio` property, (c) separate RVFileSource/RVSoundTrack nodes. Also clears `.request.audioFile`. Does NOT strip audio that's muxed inside the video container itself.

**Deployment**: Auto-deployed by `RVPluginSync.sync()` on server startup. No manual install needed.

### OpenGL Overlay System

The plugin renders metadata overlays directly in the RV viewport using pure OpenGL 1.0 (`glBitmap`). **No GLUT/freeglut dependency** — text is rendered with an embedded 5×7 pixel font (95 ASCII glyphs, hardcoded bitmap data).

**Three overlay layers** (each independently togglable):
| Layer | Position | Content |
|-------|----------|--------|
| Metadata Burn-in | Bottom-right (above timeline) | `ShotName  0001` — shot name + 4-digit zero-padded frame number |
| Status Stamp | Top-right | Colored badge: WIP (orange), Review (blue), Approved (green), Final (gold) |
| Watermark | Center | Faint text: "CONFIDENTIAL" or "INTERNAL USE ONLY" |

**Key implementation details:**
- `_FONT_DATA` dict + `_def_glyphs()`: 95 glyphs (ASCII 32-126), 7 bytes each stored bottom-row-first for `glBitmap`
- `_glText(x, y, text)`: Sets `GL_UNPACK_ALIGNMENT=1`, uses `glRasterPos2f` + `glBitmap(8, 7, ...)` per character
- `_drawMetadataBurnIn(w, h)`: `bx = w - bw - 10`, `by = 55` (sits above RV's ~40-60px transport bar)
- `render(self, event)`: MinorMode auto-callback, sets up 2D ortho projection
- `_refreshOverlayMeta()`: Fetches shot/frame info from `GET /api/assets/overlay-info`
- Toggle: Shift+O hotkey or MediaVault menu checkboxes

**⚠️ CRITICAL**: Do NOT use GLUT bitmap fonts — `freeglut.dll` does not exist in the RV build. The embedded `glBitmap` approach works on all platforms (Windows, macOS, Linux) with zero external dependencies.

**API endpoint**: `GET /api/assets/overlay-info?path=<filepath>` — returns asset metadata (vault_name, shot_name, role, version, status) for the currently-loaded file. Uses `getAllPathVariants()` for cross-platform path matching.

### findRV() Path Priority (assetRoutes.js)
1. User-configured `rv_path` setting
2. Bundled: `tools/rv/RV.app/Contents/MacOS/RV` (Mac) or `tools/rv/bin/rv.exe` (Win)
3. Self-compiled: `~/OpenRV/_build/...` (Mac) or `C:\OpenRV\_build\...` (Win)
4. System installs: `/Applications/RV*.app` (Mac) or `C:\Program Files\*RV*` (Win) or `/opt/rv` (Linux)

### OpenRV Build Status
| Platform | Status | Binary Location |
|----------|--------|----------------|
| **macOS arm64** | Compiled from source, bundled as zip on GitHub Release `rv-3.1.0` | `tools/rv/RV.app` (642 MB zip) |
| **Windows x64** | Compiled from source, bundled as zip on GitHub Release `rv-3.1.0` | `tools/rv/bin/rv.exe` (418 MB zip) |
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
| `/api/assets/overlay-info` | GET | Asset metadata for RV overlay burn-in (shot name, frame, status) |

### Settings & Smart Ingest
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
| `/api/settings/watches/inbox` | GET | Scan all watch folders for new files (Smart Ingest) |
| `/api/settings/watches/:id/cleanup` | POST | Move ingested files to `_ingested/` subfolder (Move mode only) |

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

### Users & Access Control
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users` | GET | List all users (returns has_pin boolean, never pin_hash) |
| `/api/users` | POST | Create user (name, role, optional pin) |
| `/api/users/:id` | GET | Get user + hiddenProjectIds |
| `/api/users/:id` | PUT | Update user name/role |
| `/api/users/:id` | DELETE | Delete user + cleanup project_hidden |
| `/api/users/:id/pin` | PUT | Set/change/remove PIN (SHA-256 hashed) |
| `/api/users/verify-pin` | POST | Verify PIN for login (userId + pin) |
| `/api/users/project/:id/hidden` | GET | Get user IDs hidden from this project |
| `/api/users/project/:id/hidden` | PUT | Set which users are hidden from project |
| `/api/users/:id/hidden-projects` | GET/PUT | Get/set hidden project IDs for a user |

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

### DaVinci Resolve
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/resolve/status` | GET | Check if Resolve is running, get current project info |
| `/api/resolve/send` | POST | Send assets to Resolve bin (`{assetIds, binPath, autoBinByHierarchy}`) |
| `/api/resolve/bins` | GET | List all Media Pool bins (recursive tree) |
| `/api/resolve/projects` | GET | List all Resolve projects |

---

## Frontend Architecture

### Module Structure
All frontend code uses ES6 modules loaded from `/js/main.js`. **No React, no build step, no JSX.** Use `document.createElement()` or template literals.

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `main.js` | Entry point, tab switching, vault setup | `switchTab()` |
| `state.js` | Global state singleton | `state` object |
| `api.js` | Fetch wrapper with error handling | `api(url, opts)` |
| `browser.js` | Projects grid, tree nav, asset grid/list, selection, context menu | `loadProjects()`, `loadTree()` |
| `import.js` | File browser, import flow, Quick Access sidebar, rename preview | `loadImportTab()` |
| `export.js` | Export modal with codec/resolution selection | `showExportModal()` |
| `player.js` | Built-in media player modal + popout | `openPlayer()` |
| `settings.js` | Settings tab, roles, watch folders, network, Preferences, update banner | `loadSettings()`, `loadRoles()` |
| `utils.js` | Shared utilities | `esc()`, `formatSize()`, `showToast()` |

### Quick Access Sidebar (Import Tab)

The Import tab has a **Quick Access** panel on the left for saving frequently-visited folders:

- **Add folder**: Drag a folder from the file browser onto the Quick Access drop zone, or right-click a folder → "Add to Quick Access"
- **Navigate**: Click any saved folder to jump the file browser to that path
- **Remove**: Right-click a Quick Access item → "Remove"
- **Storage**: Saved server-side via `quick_access` settings key (JSON array of `{path, name}`)
- **Functions**: `loadQuickAccess()`, `saveQuickAccess()`, `renderQuickAccess()`, `addQuickAccess()`, `removeQuickAccess()`, `initQuickAccessDropZone()`

### Preferences (Settings Tab)

Settings → Preferences section provides user-configurable defaults:

| Preference | Settings Key | Options | Default |
|-----------|-------------|---------|---------|
| Start Tab | `start_tab` | Projects, Browser, Import, Settings | Projects |
| Default View | `default_view` | Grid, List | Grid |
| Confirm Deletes | `confirm_delete` | true/false | true |
| Auto-Check Updates | `auto_check_updates` | true/false | true |

Functions: `loadPrefs()`, `savePref(key, value)` — each preference is a regular settings key.

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

1. `initDb()` — Initialize better-sqlite3 Native SQLite
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
2. **Database is better-sqlite3 (Native)** — Replaced sql.js in v1.4.1. The wrapper in database.js provides the connection.
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
18. **`data/config.json` is machine-local** — Stores GitHub PAT and custom DB path. Never committed to git. Use `loadConfig()`/`saveConfig()` from `database.js`.
19. **Quick Access uses `quick_access` settings key** — JSON array of `{path, name}`. Functions in `import.js`.
20. **Preferences are regular settings keys** — `start_tab`, `default_view`, `confirm_delete`, `auto_check_updates`. Saved via `savePref()` in `settings.js`.
21. **"Show File Path" is a modal, not clipboard** — `showFilePathModal()` in `browser.js`. Changed from clipboard copy in v1.2.7.
22. **`public/js-dist/` is generated** — Obfuscated production build from `npm run build` (`scripts/build.js`). Never edit `js-dist/` files directly.
23. **`install.bat` has safety guards** — ZIP-path detection, Program Files elevation warning, `tar` extraction (avoids 260-char path limit). Don't remove these.
24. **Video containers are excluded from sequence detection** — `sequenceDetector.js` has a `VIDEO_CONTAINER_EXTS` set. Never remove this — it prevents `.mp4`/`.mov` files from being grouped as frame sequences (caused data loss).
25. **Import progress uses SSE streaming** — `POST /api/assets/import?stream=1` sends SSE events. `importWithProgress()` in `import.js` reads the stream. Don't break the `?stream=1` query param check in assetRoutes.js.
26. **Sequence counter must increment** — `seqCounter` in the import endpoint's Step 2 loop increments per sequence. Never hardcode it to `1` — that was a bug that caused vault name collisions and file overwrites.
27. **Episode is a project-level field** — `projects.episode` column (TEXT). Set in Edit Project modal. Do NOT derive episode from sequence name — that was a bug.
28. **Naming convention uses names, not codes** — `sequence.name` and `shot.name` go into filenames. Codes (`SQ010`, `SH010`) are for folder paths only.
29. **List view shows names, not codes** — `shot_name || shot_code` priority in browser.js list rows. Users see `320` not `SH010`.
30. **Shot Builder convention is optional** — If `projects.naming_convention` is NULL, the legacy `generateVaultName()` function is used instead.
31. **Access control uses blacklist model** — Users see ALL projects by default. Admin hides specific projects from specific users via `project_hidden` table. Never invert this to whitelist.
32. **PIN hashes never sent to client** — API returns `has_pin: boolean`, never `pin_hash`. Hashing is SHA-256 via Node.js `crypto`.
33. **X-CAM-User header** — Every frontend request includes `X-CAM-User: <userId>` (set in `api.js`). Backend `resolveUserAccess()` reads it for access filtering.
34. **Admin sees everything** — `resolveUserAccess()` returns `hiddenIds: 'all'` for admin role, meaning no projects are hidden.
35. **Setup overlay auto-discovers servers** — `scanForRemoteServers()` in `main.js` runs UDP discovery when vault is unconfigured, showing found servers as clickable cards.
36. **userRoutes.js route order matters** — `/project/:projectId/*` routes are placed BEFORE `/:id` routes to prevent Express matching "project" as an `:id` parameter.
37. **Smart Ingest cleanup is mode-dependent** — `executeIngest()` only calls `/watches/:id/cleanup` for Move mode. Copy mode and Register mode must NOT call cleanup — originals must remain untouched.
38. **`ensureReadableColor(hex)` prevents invisible text** — Role colors with luminance < 90 are auto-boosted by +80 RGB. Applied in tree nav rendering (`browser.js`). If a role color looks bad on dark bg, the DB color itself should be updated.
39. **Naming convention uses `?.name || ?.code` fallback** — When calling `generateFromConvention()`, always pass `sequence?.name || sequence?.code` and `shot?.name || shot?.code`. Three call sites in `assetRoutes.js` were fixed for this.
40. **DaVinci Resolve bridge uses Python subprocess** — Resolve's scripting API is Python-only. Use `scripts/resolve_bridge.py` called via `child_process.execFile()` from Node.js routes.
41. **No Emojis in UI** — The frontend is 100% ASCII-compliant. Do not use emojis (✅, 📁, ⚙️) in the UI; use text labels (Success:, [Folder], [Settings]) or SVG icons to maintain a professional VFX aesthetic.

---

## User Access Control System (v1.3.0)

### Architecture
- **Model**: Blacklist — users see ALL projects by default; admin explicitly hides specific projects from specific users
- **PIN Auth**: Optional 4-8 char PIN, SHA-256 hashed, stored in `users.pin_hash`
- **Admin**: First user seeded as Admin; admins always see all projects, can manage team and visibility
- **Header**: `X-CAM-User` sent with every API request (injected by `api.js` and `import.js`)

### Key Files
| File | Purpose |
|------|--------|
| `src/routes/userRoutes.js` | User CRUD, PIN verify, project hiding endpoints |
| `src/routes/projectRoutes.js` | `resolveUserAccess()` — returns hiddenIds for filtering |
| `src/database.js` | `users` + `project_hidden` tables, migration for existing DBs |
| `public/js/main.js` | User picker overlay, PIN prompt flow, server discovery |
| `public/js/settings.js` | Team management UI, PIN set/remove modal |
| `public/js/browser.js` | "Hide from Users" checkboxes in Edit Project modal |
| `public/js/api.js` | `X-CAM-User` header injection |
| `public/index.html` | User picker HTML, PIN input row |

### Access Resolution Flow
```
Request arrives with X-CAM-User header
    → resolveUserAccess(req) in projectRoutes.js
    → Looks up user in DB
    → If admin: hiddenIds = 'all' (see everything)
    → If no user/header: hiddenIds = null (see everything, no restrictions)
    → If regular user: query project_hidden → Set of project IDs to exclude
    → GET /projects filters with NOT IN (hiddenIds)
    → GET /projects/:id returns 403 if project is in hiddenIds
```

### Multi-Machine Usage
Other team members connect by opening your server URL in their browser:
1. Fresh CAM install → setup overlay → auto-discovers your server via UDP → one-click connect
2. Or just bookmark `http://your-ip:7700` directly
3. User picker appears → pick profile → enter PIN → browse assets filtered by their visibility

---

## Known Issues & Pinned Features

### FFmpeg Burn-In Bug (Pinned)
FFmpeg's drawtext fails when chaining 3+ filters with expressions (`y=ih-26`). Fix: pre-calculate dimensions with ffprobe, use static pixel values.

### Flow/ShotGrid Integration (Pinned — awaiting credentials)
UI in Settings tab ready. `flowRoutes.js` + `FlowService.js` + `flow_bridge.py` implemented. Needs ShotGrid API credentials.

### DaVinci Resolve Integration (Phase 1 Complete ✅)
**Goal**: Two-way bridge between CAM and DaVinci Resolve for shot ingestion and editorial context.

**Phases:**
- **Phase 1 (DONE)**: Push to Resolve — right-click assets → send media to Resolve bins via Python Scripting API
- **Phase 2 (future)**: Pull from Resolve — read timeline edit contexts for "minicut" playback in RV
- **Phase 2.5 (future)**: OTIO/EDL file import (Resolve-independent format)

**Architecture:**
```
CAM (Node.js) → POST /api/resolve/send → scripts/resolve_bridge.py → DaVinci Resolve (Python API)
CAM (Node.js) ← GET /api/resolve/timeline ← scripts/resolve_bridge.py ← DaVinci Resolve timeline
```

**Phase 1 Implementation:**
| File | Purpose | Lines |
|------|---------|-------|
| `scripts/resolve_bridge.py` | Python bridge: `status`, `list_bins`, `send_to_bin`, `get_projects` commands | 266 |
| `src/routes/resolveRoutes.js` | REST API: 4 endpoints, spawns Python bridge, DB asset lookup | 229 |
| `src/server.js` | Mounts at `/api/resolve` | — |
| `public/js/browser.js` | Right-click → "🎬 Send to Resolve" modal with auto-hierarchy checkbox | +109 |

**How it works:**
1. Right-click asset(s) → "🎬 Send to Resolve"
2. Modal offers: auto-bin-by-hierarchy (Project/Sequence/Shot) or manual bin path
3. Backend queries DB for file paths, resolves cross-platform paths via `pathResolver`
4. Spawns Python bridge with `PYTHONPATH` and `RESOLVE_SCRIPT_LIB` env vars set
5. Bridge connects to running Resolve via `DaVinciResolveScript`, navigates/creates bins, imports media
6. Toast notification shows success/failure count

**Resolve must be running** — the Python Scripting API connects to a running Resolve instance. If Resolve is not open, the status check will show "Not connected".

**Minicut Concept (Phase 2)**: When viewing a shot in RV, optionally play it in context with neighboring shots from the edit timeline, using editorial in/out points. Inspired by Flow/ShotGrid's minicut feature. Will require `edit_contexts` and `edit_entries` DB tables.

**Resolve Scripting API** lives at:
- Windows: `C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll`
- Mac: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/`
- Docs: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\`

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
| `bd8833d` | Show File Path modal (replaced clipboard copy with modal + copy button) |
| `1521ca7` | Preferences section in Settings (start tab, default view, confirm deletes, auto-update) |
| `a1edd3d` | GitHub PAT auth for private repo auto-updates |
| `e06c3d8` | Quick Access sidebar in Import tab — save favorite folders with drag-and-drop |
| `618c2fb` | Rebrand DMV → CAM across all 44 source files |
| `6f76fa7` | Rebrand install.bat, start.bat, package.json to CAM |
| `c17cd64` | Use tar instead of Expand-Archive for RV install (avoids 260-char limit) |
| `3a3cf6a` | install.bat ZIP guard — detect running from inside ZIP, warn to extract |
| `157c7f9` | install.bat Program Files guard — detect protected path, warn/elevate |
| `2a4e450` | RV launch: spawn with detached + windowsHide:false + verbose error logging |
| `2fc5820` | Rebuild RV release ZIP with Python stdlib (lib/ + DLLs/) — fixes 'No module named encodings' |
| `05f24a2` | Show resolution under thumbnail in ComfyUI loader node |
| `e125074` | Show asset count in filter bar + return filteredTotal from API |
| `bf1fc1e` | Fix: Prevent video/image files from being detected as frame sequences (data-loss bug) |
| `af5ed98` | Live import progress bar with SSE streaming |
| — | **v1.2.9 — Shot Builder & Naming Convention (February 2026)** |
| — | feat: Shot Builder drag-and-drop naming convention editor (`shotBuilder.js`) |
| — | feat: `generateFromConvention()` in naming.js — resolves convention tokens to filenames |
| — | feat: Episode field on projects (`projects.episode` column) — separate from sequences |
| — | feat: Edit Project modal with Sequences & Shots CRUD (inline chips + "+ Shot" button) |
| — | feat: ComfyUI Save node applies naming convention with real names (not codes) |
| — | feat: `overrideVaultName` in FileService.importFile() for convention-based naming |
| — | fix: List view shows shot name (320) not code (SH010) |
| — | **v1.3.0 — User Access Control + Network Discovery Setup + Smart Ingest (February 2026)** |
| — | feat: Multi-user profiles with user picker overlay on launch |
| — | feat: PIN protection (SHA-256 hashed) to prevent profile impersonation |
| — | feat: Blacklist project hiding — admin hides specific projects from specific users |
| — | feat: `userRoutes.js` — full user CRUD + PIN auth + project visibility endpoints |
| — | feat: `X-CAM-User` header injected on all API requests for access filtering |
| — | feat: "Hide from Users" checkboxes in Edit Project modal (inverted from whitelist) |
| — | feat: Team management in Settings — add/edit/remove users, set/change/remove PINs |
| — | feat: Auto-discovery on setup overlay — fresh installs scan LAN for existing servers |
| — | feat: One-click connect cards with green dot, server name, asset count |
| — | feat: `project_hidden` + `users` tables with migration for existing databases |
| `2e2a31a` | feat: Smart Ingest — inbox watch folders with naming convention auto-rename |
| `4196134` | fix: Naming convention uses sequence/shot names instead of codes |
| `4ccf32b` | fix: Ingest copy mode now respects radio selection and keeps originals |
| `0fac917` | fix: Tree nav labels use medium gray (#aaa) for readability on dark bg |
| `cbe1108` | fix: Force tree-node text color + cache-bust CSS link |
| `795cde7` | fix: Ensure tree role labels are readable on dark bg (ensureReadableColor) |
| `de03c9e` | docs: Update copilot-instructions, CHANGELOG, bump to v1.3.1 |
| `e9d263d` | feat: DaVinci Resolve integration Phase 1 — Send to Resolve |
| — | **v1.3.2 — OpenRV Overlay System (February 2026)** |
| — | feat: OpenGL overlay system in RV — metadata burn-in, status stamp, watermark |
| — | feat: Embedded 5×7 pixel font via `glBitmap` — no GLUT/freeglut dependency |
| — | feat: Single-line metadata: shot name + 4-digit zero-padded frame, bottom-right above timeline |
| — | feat: Status stamp badge (WIP/Review/Approved/Final) with color coding, top-right |
| — | feat: Centered watermark text (CONFIDENTIAL / INTERNAL USE ONLY) |
| — | feat: Shift+O toggle + MediaVault menu checkboxes for overlay layers |
| — | feat: `GET /api/assets/overlay-info` endpoint — returns asset metadata for overlay display |
| — | **v1.4.1 — SQLite Migration & UI Professionalization (February 2026)** |
| — | refactor: Migrated from sql.js (WASM) to better-sqlite3 (Native) for improved performance and concurrency |
| — | refactor: Purged all emojis and non-ASCII characters from frontend UI and docs for a professional aesthetic |

---

*Built for VFX artists who need fast, local media management without cloud services.*
