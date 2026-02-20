# Changelog

All notable changes to Comfy Asset Manager (CAM) will be documented in this file.

## [1.4.1] - 2026-02-19

### Added
- **Video thumbnail scrubbing** — hover over any video asset card and move the mouse left/right to scrub through the clip's timeline directly on the thumbnail; no click required
- **Advanced selection sets** — professional multi-select with full keyboard modifier support
  - Shift+Click range selection — selects all assets between last-clicked and current
  - Ctrl/Cmd+Click toggle selection — add or remove individual assets without clearing others
  - Drag (marquee) selection — click and drag on empty space to draw a blue rubber-band rectangle; all intersecting cards are selected
  - Shift+drag adds to existing selection (additive mode)
  - 5px movement threshold prevents accidental marquee on normal clicks
  - Auto-scrolls when dragging near viewport edges
  - Works in both grid and list views
  - Cursor switches to crosshair during drag, text selection disabled

### Changed
- **UI professionalization & emoji purge** — removed all emoji characters from buttons, labels, headings, toasts, and documentation across the entire frontend (21 files); replaced with clean text labels (e.g., `[Settings]`, `Success:`, `Export`)
  - `index.html` — 298 lines updated; clean sidebar icons, tab labels, button text
  - `contextMenus.js` — all menu items use text-only labels
  - `import.js`, `export.js`, `settings.js`, `shotBuilder.js`, `player.js`, `projectView.js` — emoji-free UI throughout
  - `Getting Started.html` — installation guide cleaned up
  - `popout-player.html` — popout player controls updated
- **Database Engine Migration** — Replaced `sql.js` (WASM) with `better-sqlite3` (native C++) for massive performance gains
  - Enabled Write-Ahead Logging (WAL) mode for concurrent reads/writes without locking
  - Eliminated memory-locking issues during large imports or heavy API usage
  - Removed legacy `.export()` and `getRowsModified()` methods across all routes
  - Auto-updater seamlessly installs the new native driver for end-users

### Fixed
- **0 KB file sizes on existing assets** — server startup now scans for assets with `file_size = 0` and re-reads the actual size from disk, fixing assets imported before file-size tracking was added
- **FFmpeg thumbnail generation failures** — `ThumbnailService` now falls back to timestamp `00:00:00` when the calculated seek position exceeds the video duration (fixes blank/missing thumbnails for short clips)
- **Click-to-deselect after marquee** — the `click` event that fires after `mouseup` was clearing the selection made by the marquee; added `_suppressNextClick` flag to prevent this
- **Deselect on background click** — now correctly detects clicks on both `#assetContainer` and `#assetContainerWrap` as "empty space" clicks

## [1.4.0] - 2026-02-19

### Added
- **Crate system** — collect assets from any project/sequence/shot into named crates for review, export, or sharing
  - `public/js/crate.js` — full crate UI: create, rename, delete, view, export
  - `src/routes/crateRoutes.js` — REST API for crate CRUD, add/remove assets, export
  - `crates` + `crate_assets` database tables with ordered asset positions
  - Tree nav sidebar shows crate list with asset count badges
  - Context menu "Add to Crate" submenu with crate picker
  - Context menu "Remove from Crate" when viewing a crate
  - RV plugin: **Add to Crate** from right-click menu inside OpenRV (sends currently viewed clip)
- **Plugin architecture** — Resolve, Flow/ShotGrid, and ComfyUI refactored into self-contained plugins
  - `src/pluginLoader.js` — scans `plugins/` directory, auto-mounts routes and serves plugin frontend assets
  - `public/js/pluginRegistry.js` — frontend plugin registration and settings injection
  - Each plugin is a folder with `plugin.json` manifest, `routes.js`, optional `frontend/`, `services/`, `scripts/`
  - Plugins: `plugins/comfyui/`, `plugins/flow/`, `plugins/resolve/`
  - Old monolithic route files (`comfyuiRoutes.js`, `flowRoutes.js`, `resolveRoutes.js`, `FlowService.js`) removed from core
- **macOS VideoToolbox GPU encoding** — Mac exports now use hardware-accelerated `h264_videotoolbox` / `hevc_videotoolbox` instead of slow CPU `libx264`
  - `TranscodeService.js` — platform-aware GPU encoder selection (VideoToolbox on Mac, NVENC on Windows)
  - `exportRoutes.js` — `CODEC_PRESETS` and `CODEC_NAME_MAP` are now platform-aware; codec dropdown shows correct GPU label per OS
  - Export execution now auto-retries with CPU fallback (`libx264`/`libx265`) if GPU encoder fails
- **install.sh Python3 check** — installer now verifies Python3 is available (needed for Resolve bridge, Flow sync)

### Fixed
- **RV plugin `_QWidgets` undefined** — `QListWidget` and `QListWidgetItem` were never imported; replaced all `_QWidgets.ClassName` references with direct class imports for both PySide2 and PySide6
- **RV plugin multi-clip source detection** — "Add to Crate" always exported the first clip regardless of which was viewed; now uses `rvc.sourcesAtFrame(rvc.frame())` to detect the currently displayed source
- **Crate sidebar count badge showing 0** — `addToCrate()` was not calling `loadCrates()` after successful add; sidebar now refreshes immediately
- **Context menu "Delete" visible in crate view** — hidden when viewing a crate (assets should be removed, not deleted)
- **Tree nav not clearing crate state** — navigating away from a crate in the tree now properly clears `activeCrateId`

### Changed
- Updated copilot-instructions platform-branching files table from 8 to 13 entries
- Cache-bust CSS and JS links updated to `?v=1.4.0`

## [1.3.2] - 2026-02-18

### Added
- **OpenRV overlay system** — metadata burn-in, status stamp, and watermark rendered directly in the RV viewport
  - Embedded 5×7 pixel font via pure `glBitmap` — no GLUT/freeglut dependency (works on all platforms)
  - **Metadata burn-in** (bottom-right, above timeline) — single-line `ShotName  0001` format with 4-digit zero-padded frame number
  - **Status stamp** (top-right) — colored badge: WIP (orange), Review (blue), Approved (green), Final (gold)
  - **Watermark** (center) — faint "CONFIDENTIAL" or "INTERNAL USE ONLY" text
  - **Shift+O** hotkey + MediaVault menu checkboxes to toggle each overlay layer independently
  - `GET /api/assets/overlay-info` endpoint provides asset metadata (shot name, role, version, status) for overlay display
  - `_refreshOverlayMeta()` fetches metadata from CAM server when file changes in RV

## [1.3.1] - 2026-02-17

### Added
- **DaVinci Resolve integration (Phase 1)** — Right-click assets → "🎬 Send to Resolve" to push media into Resolve's Media Pool
  - `scripts/resolve_bridge.py` — Python bridge with 4 commands: `status`, `list_bins`, `send_to_bin`, `get_projects`
  - `src/routes/resolveRoutes.js` — REST API: `GET /status`, `POST /send`, `GET /bins`, `GET /projects`
  - Auto-bin-by-hierarchy creates Project/Sequence/Shot folder structure in Resolve Media Pool
  - Cross-platform: Windows (fusionscript.dll) + macOS (fusionscript.so)
  - Resolve must be running; status check shows connection state

### Fixed
- **Naming convention used codes instead of names** — `generateFromConvention()` was receiving `sequence.code` (SQ050) and `shot.code` (SH010) instead of `sequence.name` (BPT) and `shot.name` (0010). Fixed all 3 call sites in `assetRoutes.js` to use `?.name || ?.code` fallback.
- **Copy mode was deleting originals** — `executeIngest()` in `import.js` was hardcoded to always call the cleanup endpoint, which moved originals to `_ingested/`. Now respects the import mode radio: Copy mode keeps originals, Move mode runs cleanup (with confirmation), Register mode keeps originals.
- **Tree navigation text invisible on dark background** — Role colors like `#121212` (nearly black) were applied as inline styles in the tree nav, making shot labels invisible. Added `ensureReadableColor()` helper in `browser.js` that auto-lightens dark colors. Updated Grok_Imagine role color to `#80cbc4`.
- **Tree label CSS reinforcement** — Added explicit `color: #aaa` to `.tree-node` and `.tree-label` classes as baseline.
- **CSS cache-busting** — Added `?v=1.3.1` parameter to CSS link in `index.html`.

## [1.3.0] - 2026-02-17

### Added
- **Smart Ingest system** — Inbox workflow in Import tab with watch folders per project
  - Files in watch folders appear in Inbox panel with live rename preview using naming convention
  - Import mode respected: Move (cleanup originals), Copy (keep originals), Register (link only)
  - `GET /api/settings/watches/inbox` scans all watch folders for new files
  - `POST /api/settings/watches/:id/cleanup` moves originals to `_ingested/` subfolder (Move mode only)
- **Multi-user profiles** with user picker overlay on launch
- **PIN protection** (SHA-256 hashed) to prevent profile impersonation
- **Blacklist project hiding** — admin hides specific projects from specific users via `project_hidden` table
- **User CRUD** — `userRoutes.js` with full user management + PIN auth + project visibility endpoints
- **`X-CAM-User` header** injected on all API requests for access filtering
- **"Hide from Users"** checkboxes in Edit Project modal
- **Team management** in Settings — add/edit/remove users, set/change/remove PINs
- **Auto-discovery on setup overlay** — fresh installs scan LAN for existing servers via UDP
- **One-click connect cards** with green dot, server name, asset count
- **`project_hidden` + `users` tables** with migration for existing databases

## [1.2.9] - 2026-02-17

### Added
- **Shot Builder** — drag-and-drop naming convention editor (`shotBuilder.js`)
- **`generateFromConvention()`** in `naming.js` — resolves convention tokens to filenames
- **Episode field** on projects (`projects.episode` column) — separate from sequences
- **Edit Project modal** with Sequences & Shots CRUD (inline chips + "+ Shot" button)
- **ComfyUI Save node** applies naming convention with real names (not codes)
- **`overrideVaultName`** in `FileService.importFile()` for convention-based naming

### Fixed
- **List view shows shot name** (320) not code (SH010)

## [1.2.8] - 2026-02-16

### Added
- **Live import progress bar** — imports of 2+ files now show a real-time progress bar with file count and current filename via SSE streaming (`3 / 47 — render_0003.exr`)
- **Asset count in filter bar** — shows total matching assets when filtering by sequence/shot/role
- **ComfyUI loader resolution** — shows image resolution under thumbnails in the ComfyUI Load node

### Fixed
- **Sequence detector data-loss bug** — video containers (`.mp4`, `.mov`, `.avi`, etc.) with numeric filenames (e.g., `comfy_00001.mp4`) were incorrectly grouped as frame sequences, causing files to overwrite each other during import. Added `VIDEO_CONTAINER_EXTS` exclusion set.
- **Sequence vault name collisions** — multiple detected sequences all got `_0001` suffix (hardcoded counter), causing later sequences to overwrite earlier ones on disk. Now uses incrementing `seqCounter` with collision detection.

## [1.2.5] - 2026-02-16

### Added
- **Copy File Path** — right-click context menu now includes "Copy File Path" to copy the resolved absolute path of an asset to the clipboard
- Asset listing API now resolves `file_path` per platform so paths display correctly on both Mac and Windows

### Fixed
- **RV auto-audio stripping** — aggressively strips phantom audio that RV's `source_setup` auto-discovers from nearby directories on a NAS, handling separate RVFileSource nodes, `.media.audio`, `.request.audioFile`, and RVSoundTrack nodes
- **RV plugin connection** — changed `localhost` to `127.0.0.1` to avoid IPv6 resolution failures on macOS
- **Cross-platform Compare To** — `compare-targets-by-path` endpoint now tries all platform path variants (Mac ↔ Windows) via `getAllPathVariants()`

## [1.2.4] - 2026-02-16

### Added
- **RV image sequence support** — RV now receives full frame-range notation (`render.1001-1100####.exr`) instead of just the first frame, enabling proper sequence playback in RV/OpenRV
- `resolveAssetRvPath()` helper builds RV-compatible paths for sequences across rv-push, open-external, and open-review endpoints

## [1.2.3] - 2026-02-16

### Fixed
- **Eliminated grid flicker on selection** — clicking assets no longer rebuilds the entire DOM; selection now toggles CSS classes on existing elements via `updateSelectionClasses()`
- Applies to all selection modes: click, Ctrl/Cmd+click, Shift+click, Select All, Clear Selection, right-click, and drag-start

## [1.2.2] - 2026-02-16

### Fixed
- **Removed card jiggle on click/hover** — removed `translateY(-1px)` transform from `.asset-card:hover` and `.asset-card.asset-selected` that caused a visual pushdown artifact

## [1.2.1] - 2026-02-16

### Fixed
- **Safari filter dropdown fix** — media type and sequence filter dropdowns now work in Safari; replaced inline `onchange` handlers with `addEventListener` (Safari doesn't reliably fire inline handlers inside `position: sticky` containers)

## [1.2.0] - 2026-02-15

### Added
- **Database Transfer system** — export, import, and pull database between machines via Settings tab for cross-platform sync (PC ↔ Mac)
- **Cross-platform path resolver** — NAS path mappings applied to all file-serving endpoints (Windows `Z:\MediaVault` ↔ Mac `/Volumes/home/...`)
- **Standard asset selection UX** — blue border highlight, click/Ctrl+click/Shift+click multi-select, double-click opens in RV
- **Native macOS .app bundle** — Cocoa launcher with proper app icon, build script, and installer integration
- **Network discovery** — UDP broadcast for multi-machine server switching
- **Smart network drive detection** — Synology NAS, SMB, AFP, NFS mounted volumes
- **Auto-deploy RV plugin** — server syncs MediaVault RV plugin to RV's Packages directory on startup
- **One-line Mac installer** — paste a single command into Terminal to install everything
- **Getting Started visual guide** — HTML install guide for non-technical users

### Fixed
- **macOS RV window activation** — uses `open -a` to properly bring RV to front on Mac
- **Ctrl+click multi-select on macOS** — intercepts `contextmenu` event for Ctrl+click so it behaves as toggle-select
- **Path resolver format** — now handles `{windows,mac,linux}` mapping format from UI
- **RV plugin registration** — uses `rvpkg` CLI to properly register the plugin
- **RV plugin deployment** — copies `.py` files to the correct `Python/` directory
- **Intel RV detection** — detects old Intel RV build and offers native arm64 download

## [1.1.0] - 2026-02-14

### Changed
- **Rebranded to Comfy Asset Manager (CAM)** — UI header, page titles, setup overlay, and popout player now show "CAM" branding

### Added
- **RV / OpenRV integration** — professional media review tool as the default external player
  - A/B wipe comparison: select 2 assets → "Compare in RV" for side-by-side
  - Persistent RV sessions via rvpush — send assets to a running RV instance
  - MediaVault RV plugin with Compare To submenu, role-based version switching, Prev/Next Version navigation
  - Qt AssetPickerDialog — full tree/table picker replaces monolithic context menus
  - Hierarchical fallback: Compare/Switch searches shot → sequence → project for related assets
  - Bundled OpenRV auto-download in install.bat
  - macOS OpenRV build guide
- **Inline Sequence/Shot creation in Import** — "+" buttons next to Sequence and Shot dropdowns let you create new sequences/shots without leaving the Import tab
  - Auto-suggested codes (SQ010, SH010)
  - Auto-create on import: pending inline forms are created automatically when you click Import
- **Custom video transport** — real-time scrubbing, frame stepping (arrow keys), J/K/L shuttle control
- **Frame cache engine** — RV-style sequential decode + cached playback for instant scrubbing
  - WebCodecs frame cache via VideoDecoder + mp4box.js for 100% frame-accurate decode
  - Multi-clip cache pool with adjacent clip pre-caching
- **Pop-out player** — open media in a separate window with presentation mode
- **Play All** — play all assets in current view as a playlist
- **ComfyUI generation metadata capture** — Tab-key side panel in player shows ComfyUI workflow info
- **Keep original filenames** option in import settings
- **App version display** in top bar with update notification system (T2-style banner + modal)
- **Move-mode confirmation gate** — warning dialog before moving files (prevents accidental data loss)
- **Right-click context menus** for shots, sequences, and projects in Browser tree
- **Mac/Linux support** — .command wrappers for double-click launch, auto-install via Homebrew, execute permissions
- **Network drive browsing** — mounted volumes and network drives visible in Import file browser (Mac/Linux)
- **Copyright headers** on all source files + frontend JS obfuscation build step
- **Proprietary LICENSE** file

### Fixed
- **Inline shot creation silently failing** — "+" button no longer toggles (always opens form), Cancel button closes it; import auto-creates pending forms
- **RV -wipe flag treated as filename** — moved flag before file paths in command args
- **RV session management** — don't kill RV for compare, push files to running instance
- **WebCodecs mp4box async race condition** — rewritten decoder pipeline
- **Frame stepping skips** — fixed gap-fill duplicates causing stutter
- **Canvas hidden by CSS** — use visibility:hidden instead of display:none for cached video
- **ComfyUI save timeout** — increased to 120s for large video files (was 3s)
- **Mac/Linux launcher permissions** — .sh and .command files now have execute permission
- **Line endings** — forced LF on all .sh/.command files for macOS compatibility

### Removed
- **mrViewer2** — fully removed in favor of RV/OpenRV as the sole external player
- **Web UI compare features** — RV handles compare natively via its plugin

## [1.0.0] - 2026-02-12

### Added
- **ComfyUI thumbnail preview** on Load nodes — shows 320px JPEG thumbnail of selected asset directly in the node graph
- **ShotGrid-style list view** in Browser tab — 11-column table with sticky header, role color tags, audio/media indicators
- **Version-aware collision handler** — `resolveCollision()` increments version (v002→v003) instead of appending `_02` suffixes
- **Register-in-Place import mode** — files stay at original location, only a database reference is created (`is_linked = 1`)
- **Three import modes**: Move, Copy, Register in Place
- **ShotGrid naming convention** — auto-rename files following industry-standard patterns (`{shot}_{step}_v{version}`)
- **ComfyUI integration** — 3 custom nodes (Load, LoadVideo, Save) with cascading dropdown filters and proxy routes
- **Export system** — FFmpeg transcode with NVENC GPU acceleration, ProRes, resolution presets
- **Built-in media player** — images, video, audio with on-the-fly transcoding for pro codecs
- **Tree navigation** — left panel with Project → Sequence → Shot → Role hierarchy
- **Drag-and-drop import** — drop files onto browser for quick import
- **Thumbnail generation** — Sharp (images) + FFmpeg (video frame grab at ~1s)
- **Role management** — customizable pipeline steps with colors and icons

### Fixed
- **Version detection basePattern mismatch** — `FileService.importFile()` now matches actual ShotGrid template output, preventing `v002_13` collision suffixes
- **`getNextVersion()` regex** — handles collision-suffixed filenames (`v002_14`) without breaking version detection
- **UTC timestamp display** — `formatDateTime()` appends `'Z'` to SQLite datetime strings for proper browser timezone conversion
- **`generateVaultName()` destructuring** — returns `{ vaultName, ext }` object, callers now destructure properly (was causing `[object Object]` in DB)
- **Register-in-Place** — fixed undefined `imported` variable, missing `generateVaultName()` call, wrong variable references for thumbnails
- **Shot dropdown empty** — shots table has both `sequence_id` AND `project_id`; both must be updated when migrating hierarchy
