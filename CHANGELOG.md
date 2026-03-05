# Changelog

All notable changes to Comfy Asset Manager (CAM) will be documented in this file.

## [1.9.44] - 2026-03-05

### Fixed — OCIO LUT File Not Found on Windows (Drive Letter ':' Split)
- **Root Cause** — The OCIO config's `search_path` uses `:` as a path separator. A Windows path like `X:/thechosen_cho-1157/reference/LUT` was split into `X` and `/thechosen_cho-1157/reference/LUT` — neither is a valid path. The cube file could not be found even though it existed on disk. The `SUCCESS` log was misleading (printed after property setup, before OCIO actually tried to load the file).
- **Fix** — Use the full absolute path (forward slashes) in `FileTransform.setSrc()` instead of basename + search_path. OCIO resolves absolute paths directly without search_path lookup, bypassing the `:` separator issue entirely.
- Added `v2:` salt to the OCIO config cache key so old broken configs are regenerated.

## [1.9.43] - 2026-03-05

### Fixed — RV Overlay Invisible After Frame 1 on EXR Sequences
- **Root Cause** — The OCIO color pipeline uses GL shader programs to apply color transforms (ACEScg -> ACEScct -> LUT -> display). After RV renders an EXR frame with OCIO, the shader stays bound. On frame 2+, the overlay's fixed-function GL calls (`glColor4f`, `glVertex2f`, `glBitmap`) went through the OCIO shader instead of the normal pipeline, making the overlay invisible. Frame 1 worked because the OCIO shader wasn't compiled/bound yet during that first render pass.
- **Fix** — `render()` now saves the active GL program, calls `glUseProgram(0)` to switch to the fixed-function pipeline before drawing overlays, then restores the original program afterward. This ensures overlay drawing is always independent of the OCIO color pipeline.
- MOV files were unaffected because they don't go through the OCIO LUT pipeline.
- Added `glUseProgram`, `glGetIntegerv`, `GL_CURRENT_PROGRAM` imports (with graceful fallback via `_HAS_GL_SHADERS` flag).

## [1.9.42] - 2026-03-04

### Fixed — RV OCIO: Correct Display Name for ACES Studio Config
- **Display name fix** — Changed `sRGB` to `sRGB - Display` to match the ACES Studio Config v2.1.0 naming convention. The previous name caused `Display 'sRGB' not found`, meaning no output transform was applied — resulting in oversaturated, un-tonemapped output.
- With the correct display name, RV now applies the full ACES RRT + sRGB ODT, matching Nuke's `ACES 1.0 - SDR Video (sRGB - Display)` monitor output.

## [1.9.41] - 2026-03-04

### Fixed — RV OCIO: Set Global OCIO Env Var + Re-set After ocioUpdateConfig
- **Set `OCIO` environment variable** — `os.environ['OCIO']` is now set to the generated ACES config path before any node manipulation. This gives RV's global OCIO subsystem a valid config with ACEScg/ACEScct defined, eliminating the `OCIO environment variable not set` warning and ensuring Display nodes can resolve color spaces immediately.
- **Re-set `outColorSpace` after `ocioUpdateConfig`** — `ocioUpdateConfig()` may clear user-created properties like `ocio.outColorSpace` during its internal re-init (this property isn't part of the default OCIOLook node schema). We now read it back after the call and re-set to `ACEScg` if it was wiped, fixing `LookTransform: empty destination color space name`.
- Combined, these two fixes address the root cause: RV validates OCIO nodes at every pipeline swap, property change, and config reload — the global env var ensures color spaces are always resolvable.

## [1.9.4] - 2026-03-04

### Fixed — RV OCIO: Load Config Before Re-Enable
- **Root Cause** — Re-enabling a node (`active=1`) instantly triggers RV's render thread, which validates color space names against whatever config is loaded. Since `ocioUpdateConfig` hadn't run yet, the render thread validated against an empty/default config — producing `empty destination` and `Cannot find ACEScg` errors.
- **Fix** — `ocioUpdateConfig` is now called **while the node is still disabled** (all property values are already set, so validation passes), and the node is re-enabled **after** the config is loaded and the shader is built.
- Applied to both `OCIOLook` and `OCIODisplay` nodes.

## [1.9.3] - 2026-03-04

### Fixed — RV OCIO: Single ocioUpdateConfig After All Properties Set
- **Root Cause** — `ocioUpdateConfig()` validates ALL node properties regardless of `active` state. Calling it after setting only `ocio.config` (but before `outColorSpace`/`inColorSpace`) produced `empty destination color space` and `Cannot find source color space 'ACEScg'` errors.
- **Fix** — Removed intermediate `ocioUpdateConfig()` calls. All properties (`config`, `function`, `inColorSpace`, `outColorSpace`, `look`, `display`, `view`) are now set while the node is disabled, then `ocioUpdateConfig` is called exactly **once** at the end when everything is populated.
- Applied to both `OCIOLook` and `OCIODisplay` nodes.
- Note: `ERROR: OCIO environment variable not set` is a harmless RV startup warning that appears when no global `$OCIO` env var is set — it does not affect per-node configs.

## [1.9.2] - 2026-03-04

### Fixed — RV OCIO Setup Ordering (Eliminates Transient Errors)
- **Disable-Before-Create** — `ocio.active` is now set to `0` *before* creating any new OCIO properties on the node. Previously, creating properties like `ocio.outColorSpace` while the node was still active caused RV's render thread to validate empty strings — producing `LookTransform: empty destination color space name` errors.
- **Load Config Before Referencing Color Spaces** — `ocioUpdateConfig` is now called immediately after setting `ocio.config`, *before* setting `inColorSpace`/`outColorSpace` to `ACEScg`. This ensures the ACES studio config is loaded and `ACEScg` is resolvable when those properties are set, eliminating `Cannot find source color space named 'ACEScg'` errors.
- Same fix applied to both `OCIOLook` (grade pipeline) and `OCIODisplay` (output pipeline) nodes.

## [1.9.1] - 2026-03-04

### Fixed — RV OCIO Pipeline Stability
- **Fixed "Cannot find source color space" Crash** — The plugin now temporarily disables the `OCIODisplay` node (`ocio.active=0`) before setting its configuration and input color space. This prevents RV from validating `ACEScg` against the default (potentially empty) config before the new config is loaded.
- **Fixed Empty Destination Space Error** — Explicitly sets `ocio.outColorSpace` to `ACEScg` on `OCIOLook` nodes to ensure the color pipeline is fully defined.

## [1.9.0] - 2026-03-04

### Fixed — RV OCIO Node Initialization
- **Critical Crash Fix** — Fixed `invalid property name ...ocio.config` error by manually creating missing OCIO properties (`ocio.config`, `ocio.function`, etc.) on `OCIOLook` and `OCIODisplay` nodes if they don't exist after swapping pipelines.
- **Robustness** — Prevents crashes when standard RV OCIO packages are not fully initialized or when the environment variable `OCIO` is missing.

## [1.8.9] - 2026-03-04

### Fixed — RV Display Output Transform (ODT)
- **Enforced ACES 1.0 - SDR Video** — The RV plugin now actively configures the Display pipeline to use `OCIODisplay` with the correct ACES RRT+ODT, ensuring highlights are rolled off correctly instead of clipped. This fixes the "clipped whites" issue when viewing EXRs with the Nuke-matching LUT pipeline.
- Matches Nuke's `monitorOutLUT "ACES 1.0 - SDR Video (sRGB - Display)"` setting.

## [1.8.8] - 2026-03-04

### Fixed — OCIO LUT Pipeline (Windows Path Support)
- **Corrected OCIO Config Generation** — `_getOrCreateOCIOConfig` now adds the LUT directory to the OCIO `search_path` and uses `os.path.basename()` for the file reference. This prevents invalid backslashes in the generated XML on Windows, which was causing the LUT to fail silently or load incorrectly.
- **Nuke-Matching Color Pipeline** — Explicitly set `processSpace='ACEScct'` on the OCIO Look to match Nuke's `color_timing` working space. Validated against `nukeSecOutput.nk` (Linear -> ACEScct -> Cube -> ACEScct -> Linear).
- **Interpolation** — Added `INTERP_TETRAHEDRAL` for smoother LUT sampling.

## [1.7.1] - 2026-03-03

### Added — ShotGrid Bulk Sync, Thumbnails & Tree Enhancements

#### Flow/ShotGrid Media Import
- **Import Media from Flow** — New button in Flow sync panel fetches all Versions and PublishedFiles from ShotGrid, finds the files on disk (with cross-platform path resolution), and registers them in-place assigned to the correct project/sequence/shot/role. Source selector: Versions Only, Published Files Only, or both.
- **`sync_versions` bridge command** — Queries ShotGrid Versions with `sg_path_to_frames`, `sg_path_to_movie`, entity link (Shot), and task step. Handles path as dict (local_path, local_path_windows, etc.) or string.
- **`sync_published_files` bridge command** — Same pattern for PublishedFile entities with `path`, `path_cache`, and `published_file_type`.
- **`FlowService.syncVersions()`** — Fetches from bridge, builds shot/role lookup maps, skips duplicates by flow_version_id and file path, registers in transaction with proper metadata, queues thumbnail generation.

#### ShotGrid Thumbnail Sync (3 levels)
- **Pull Thumbnails from Flow** — Single button downloads all three levels of ShotGrid thumbnails:
  - **Shot thumbnails** (`shot_<shotId>.jpg`) — The Shot entity's `image` field. Displayed when browsing a shot with no assets.
  - **Role thumbnails** (`task_<shotId>_<roleId>.jpg`) — The latest Version's thumbnail per shot+pipeline step combo (e.g., the Paint thumbnail for shot 104_0100). Displayed when clicking a specific role under a shot.
  - **Asset thumbnails** — Version/PublishedFile thumbnails for already-imported assets.
- **Fallback chain in browser** — Role view tries `task_<shotId>_<roleId>.jpg`, falls back to `shot_<shotId>.jpg`, then shows empty state.
- **`fetch_shot_thumbnails` bridge command** — Queries Shot entities with `image` field.
- **`fetch_role_thumbnails` bridge command** — Queries Versions with `image`, groups by shot+step, keeps latest (newest `created_at` first).
- **`fetch_thumbnail_urls` bridge command** — Gets thumbnail URLs for Versions + PublishedFiles.

#### Tree Navigation Enhancements
- **Task-based roles in tree** — Shots now show pipeline step roles from `flow_tasks` table even when no assets exist yet. Roles appear with `asset_count: 0` and `from_task: true` flag.
- **ShotGrid status dots** — Replaced emoji icons with colored status dots (14 SG statuses mapped: ip, rev, pcr, rdy, wtg, hld, mn, cbb, fin, tfn, fdi, 4k, omt, if). Muted colors at 0.75 opacity.
- **Priority-based status aggregation** — When multiple tasks exist for the same shot+step, the most active status is shown (ip > rev > pcr > rdy > ...).
- **Removed bright role colors** — Role labels no longer use inline `style="color"` — they inherit the neutral gray tree text color for VFX-appropriate appearance.
- **Gray tree arrows** — `.tree-toggle svg` fill set to `#888` to match neutral theme.

### Fixed
- **SQL datetime bug** — `datetime("now")` with double quotes treated as column name in SQLite. Fixed to `datetime('now')` in FlowService.js (2 places) and PathMatchService.js (1 place). This was causing sync operations to hang.
- **Plugin settings button responsiveness** — `pluginRegistry.js` `injectSettingsSections()` was destroying event listeners on every settings reload via innerHTML re-injection. Added `_settingsInjected` guard to prevent re-injection.

### Infrastructure
- Extracted `rvFinder.js`, `ffmpegUtils.js`, `userAccess.js` as single-source-of-truth utility modules.

## [1.7.0] - 2026-03-01

### Added — Direct RV-to-ShotGrid Annotation Export
- **"Send Annotation to ShotGrid" RV menu item** — New `MediaVault → Send Annotation to ShotGrid` action (`Alt+Shift+N`) captures the current frame with all paint-overs and annotations, resolves the asset's project/shot/sequence Flow IDs automatically from the source path, and publishes a ShotGrid Note with the annotated PNG attached — all in one step, no manual export needed.
- **`POST /api/flow/publish/annotated-frame`** — New server route receives the rendered frame from RV, resolves Flow mappings from the asset's source path, saves the PNG locally for review history, creates a local review note, and publishes to ShotGrid in a single call.
- **Auto-resolved Flow context** — The route queries the asset's linked project, shot, and sequence `flow_id` columns so the artist doesn't need to manually pick a ShotGrid project or shot. If the asset is already synced with Flow, everything is automatic.

## [1.6.9] - 2026-03-01

### Added — Export Annotated Frames to ShotGrid/Flow
- **`create_note` bridge command** — New Python bridge command creates a Note entity in ShotGrid, optionally linked to a Shot and/or Version, with the annotated frame PNG uploaded as an attachment. Supports addressee lists for notification routing.
- **`POST /api/flow/publish/note`** — New API route takes a `reviewNoteId` + `flowProjectId`, resolves the annotation image from disk, and exports everything to Flow as a Note with attachment.
- **`FlowService.createNote()`** — New service method orchestrates the bridge call and writes `flow_note_id` back to the local `review_notes` row to track export state.
- **Export to Flow button on note cards** — Each review note card now has a 🔀 button that opens a modal to pick the Flow project + optional subject/comments, then publishes the note. Button disables after successful export to prevent duplicates.
- **`flow_note_id` column** — Auto-migration adds `flow_note_id INTEGER` to `review_notes` table, storing the ShotGrid Note ID for exported notes.

## [1.6.8] - 2026-03-01

### Changed — Safety Guardrails for Facility Deployment
- **Default import mode is now "Register in Place"** — Files stay exactly where they are by default. Move and Copy are still available but require explicit selection. Register is now the first option in the import panel.
- **Delete defaults to DB-only** — `DELETE /api/assets/:id` and `POST /api/assets/bulk-delete` now default to removing database records only. Physical file deletion requires an explicit `delete_file=true` parameter. Previously both defaulted to deleting files from disk.
- **Rename-to-hierarchy skips linked assets** — The bulk rename operation now automatically skips any asset with `is_linked = 1` (registered in place). Externally managed files are never renamed.
- **Context menu reordered** — "Remove from DB" is now the top (non-destructive) action. "Delete files from disk" is the secondary red/danger action, making accidental file deletion less likely.
- **Selection toolbar reordered** — The safe "Remove from DB" button now appears before the destructive "Delete from Disk" button, with clearer labels on both.

## [1.6.7] - 2026-03-01

### Added — Path Matching & Bulk Scan-and-Register
- **PathMatchService** — New service that parses file paths against configurable token patterns (`{project}/{sequence}/{shot}`) to auto-assign assets to the correct project/sequence/shot. Matches by code or name (case-insensitive) against records synced from Flow.
- **Configurable show root + path pattern** — Settings → Flow now has a "Path Matching & Bulk Scan" section. Set your show root (e.g., `/shows`) and a token pattern describing your directory structure. Saved as `flow_show_root` and `flow_path_pattern` settings.
- **Scan & Register Tree** — New `POST /api/flow/scan-tree` endpoint recursively walks an entire show directory, registers all media files in-place (nothing moves), and auto-matches each file to project/sequence/shot using the path pattern. Includes dry-run preview mode.
- **Auto-Match Existing** — New `POST /api/flow/auto-match` endpoint runs path matching on all unassigned assets in the database. Useful after a Flow sync populates the project/shot structure.
- **Preview Match** — `POST /api/flow/preview-match` tests a single file path against the pattern without registering anything.
- **Watcher auto-match hook** — When watched folders detect new files, the watcher now auto-matches them to project/sequence/shot if path matching is configured.
- **Settings UI** — Show root, path pattern, Save Path Config, Auto-Match Existing, Preview scan, and Scan & Register buttons all in the Flow settings panel.

## [1.6.6] - 2026-03-01

### Added — Flow Production Tracking v2.0 (ShotGrid Integration)
- **Task sync** — New `sync_tasks` bridge command + `flow_tasks` database table. Full sync now pulls Tasks from Flow including assignments, statuses, dates, and pipeline step links. "Sync Tasks Only" button added to settings.
- **Task status writeback** — `update_task_status` bridge command + `/api/flow/tasks/:id/status` route. Publishing a Version can auto-update the linked Task status to "Pending Review" in Flow.
- **Media upload for Screening Room** — `upload_media` bridge command + `/api/flow/publish/media` route. Upload MOV/MP4 review media directly to Flow Versions for remote review in Screening Room.
- **Publish to Flow context menu** — Right-click any asset(s) → "🔀 Publish to Flow" opens a modal to select the Flow project, add a description, and publish. Auto-uploads thumbnails. Works with single or multi-select.
- **Flow status indicator in topbar** — 🔀 icon appears when Flow is configured. Green dot = connected, amber = configured but can't reach server, hidden = not configured. Clicking opens Settings.
- **Enhanced publish pipeline** — `publishVersion` now supports auto-thumbnail upload, media upload for Screening Room, task linking, and task status writeback in a single publish action.
- **Plugin context menu system** — `contextMenus.js` now queries `pluginRegistry.getContextMenuItems()` for plugin-contributed right-click menu items. Other plugins can now add context menu actions via `plugin.json` declarations.

## [1.6.5] - 2026-03-01

### Fixed
- **Voice chat hub routing** — In spoke mode, voice signaling (SSE + WebRTC signals) now routes directly to the hub server so all participants share the same voice room. Previously each machine had its own isolated in-memory room, resulting in 0 peers visible.

## [1.6.4] - 2026-03-01

### Fixed
- **Spoke auto-update forwarding to hub** — `POST /api/update/apply` was being intercepted by the spoke proxy and forwarded to the hub. The hub would update itself while the spoke stayed on the old version. Added `/api/update/*` to the `LOCAL_ONLY` proxy bypass list so updates always execute on the local machine.

## [1.6.3] - 2026-03-01

### Added
- **WebRTC Voice Chat** for review sessions — real-time peer-to-peer audio during synchronized reviews.
  - Server-side SSE signaling endpoint (`GET /api/voice/signal/:sessionId`) with per-session voice rooms and automatic cleanup.
  - Signal relay (`POST /api/voice/signal/:sessionId`) routes WebRTC offers, answers, and ICE candidates between peers.
  - Peer list endpoint (`GET /api/voice/peers/:sessionId`).
  - Frontend WebRTC module (`voiceChat.js`) with `getUserMedia`, echo cancellation, noise suppression, and auto gain control.
  - Mesh topology peer connections — each peer connects directly to every other peer (supports 2–6 participants).
  - Google STUN servers for NAT traversal (LAN works without STUN too).
  - Mute/unmute toggle with visual feedback.
  - Floating voice control bar at bottom of screen when connected (shows peer count, names, mute button, leave button).
  - 🎙️ Voice button added to every active review session card (both host and participant views).

## [1.6.2] - 2026-02-28

### Fixed
- Corrected version numbering (patch bumps only going forward).

## [1.6.1] - 2026-02-28

### Fixed
- Version correction from erroneous 1.7.0 jump back to proper patch sequence.

## [1.6.0] - 2026-02-28

### Added
- **HTTP Hub Discovery fallback** — When UDP broadcast (port 7701) is blocked by Windows Firewall, hub scan now probes all 254 IPs on the local /24 subnet via HTTP as a fallback.
- **Auto-updater non-git bootstrap** — `updateRoutes.js` now initializes a `.git` directory on non-git installs (zip/copy) so `git pull` works for future updates.
- **install.bat git init** — Windows installer now runs `git init` + `git remote add` + `git fetch` + `git reset --mixed` after extracting, giving zip installs a proper git repo for auto-updates.

## [1.5.9] - 2026-02-28

### Added
- **Hub-spoke bidirectional sync** — Hub now broadcasts SSE `db-change` events to all connected spokes after every database write. Previously `HubService.broadcast()` existed but was never called from any route handler, so changes made on the hub (PC) never pushed to spokes (Mac). Now all INSERT/UPDATE/DELETE operations in `assetRoutes.js`, `projectRoutes.js`, and `roleRoutes.js` call `req.app.locals.broadcastChange?.()` which triggers SSE broadcast in hub mode and is a safe no-op in standalone/spoke modes.

### Fixed
- **Hub→spoke sync was completely non-functional** — The SSE infrastructure was fully wired (hub has broadcast function, spoke subscribes and applies changes), but nothing ever triggered the broadcast. Imports, publishes, renames, deletes, and all other writes on the hub were invisible to spokes. Root cause: architectural gap where `HubService.broadcast()` was implemented but never integrated into route handlers.

## [1.5.8] - 2026-02-28

### Added
- **Hub-spoke thumbnail sync** — Spokes now download all thumbnails from the hub alongside the SQLite database on startup. New assets added on the hub trigger real-time single-thumbnail downloads on connected spokes via SSE. Custom binary bundle format streams ~34 MB of thumbnails efficiently.
  - Hub endpoints: `GET /api/sync/thumbnails` (bulk binary bundle), `GET /api/sync/thumbnail/:id` (single)
  - Spoke: `syncThumbnails()` bulk download, `fetchSingleThumbnail()` incremental SSE-triggered download
  - New `_downloadBuffer()` helper for in-memory HTTP response parsing

## [1.5.7] - 2026-02-28

### Added
- **File extension badge on thumbnails** — Asset thumbnails in grid view now show the file extension (EXR, PNG, JPG, MOV, etc.) as a subtle label in the bottom-right corner. Videos with a duration badge are skipped to avoid overlap. Applied to both asset grid and crate views.

## [1.5.6] - 2026-02-28

### Added
- **Rename to Hierarchy** — New right-click context menu action for bulk-renaming assets based on their current project/sequence/shot/role position. Select assets → right-click → "Rename to Hierarchy" shows a preview modal with old vs new names, then executes renames on disk and in the database. Handles both Shot Builder naming conventions and legacy template fallbacks.
  - New endpoint: `POST /api/assets/rename-to-hierarchy` with preview/execute modes
  - Frontend: Preview modal with confirmation in `contextMenus.js`

### Fixed
- **Rename-to-Hierarchy sequential versioning** — Fixed all assets getting the same version (`_0001`) with ugly collision suffixes (`_2`, `_3`). Root cause: `getNextVersion()` returned 1 for every asset because empty `basePattern` hit an early return, and no batch tracking existed between assets. Rewrote the versioning loop with a `usedPaths` Set to track names within the batch and incremental version attempts (1, 2, 3...) until finding a name unique both within the batch and on disk.
- **Overlay editor blank canvas** — Fixed the WYSIWYG overlay editor rendering nothing. Root cause: `bmpScale` variable on line 356 of `overlayEditor.js` was undefined (leftover from a prior refactor), causing a ReferenceError that silently killed the entire `drawElement()` render loop.

## [1.5.5] - 2026-02-28

### Added
- **Overlay Burn-in System** — Full WYSIWYG overlay editor for creating text burn-in presets. Place elements (shot name, frame number, timecode, date, sequence, role, custom text) anywhere on a live canvas preview with configurable font size, color, and opacity. Presets are saved to the database and reusable across exports.
  - New files: `overlayEditor.js` (673 lines), `overlayRoutes.js` (473 lines)
  - New `overlay_presets` table in database
  - Overlay preset management section in Edit Project modal
- **Export with overlay burn-in** — Export modal now has a "Text Overlay (Burn-in)" checkbox. Select a saved preset or launch the editor to create one. Backend generates FFmpeg drawtext filter chains and combines them with scale filters for both video and image sequence outputs. GPU and CPU codec paths both support overlays.
- **RV plugin: CAM Overlay rendering** — The OpenRV plugin can now fetch and render overlay presets from the CAM server directly in the RV viewport using OpenGL. New menu items: "CAM Overlay Preset" (toggle) and "Refresh CAM Overlay". Matches export burn-in appearance during live review.
- **RV plugin: Qt TrueType text rendering** — Replaced the old 5x7 bitmap font with anti-aliased TrueType text via QPainter for overlay rendering. Supports configurable font family, size, color, and opacity. Falls back to scaled bitmap glyphs when Qt is unavailable.
- **EXR thumbnail support** — `.exr` files now generate thumbnails via sharp with automatic FFmpeg fallback for unsupported formats.
- **Retroactive shot name migration** — New `scripts/fix_shot_names.js` utility renames existing assets from shot-code-based names (e.g., `SH010_comfyui_v001.mp4`) to shot-name-based names (e.g., `Risque_comfyui_v001.mp4`). Updates vault_name, file_path, and relative_path in the database and renames files on disk. Supports dry-run mode.

### Fixed
- **Shot names in vault filenames** — `generateVaultName()` now uses the user-given shot name (e.g., "Risque", "2003_Photo_Shoot") instead of the auto-generated code (e.g., "SH010", "2003PHOT") when building asset filenames. Same fix applied to sequence names. Affects all import paths: normal import, ComfyUI save, and copy operations.
  - Files changed: `naming.js`, `FileService.js`, `assetRoutes.js`, `import.js`
- **Import preview names** — The rename preview in the Import tab now correctly shows shot/sequence names (not codes) by reading `data-name` attributes on dropdown options instead of parsing text content.
- **Cross-platform path lookups** — `getAllPathVariants()` now generates backslash (`\`) versions of every path variant, fixing DB lookups on Windows where assets may be stored with either separator style.
- **Sharp thumbnail fallback** — Image thumbnail generation now catches sharp errors (e.g., unsupported BMP/EXR variants) and silently falls back to FFmpeg instead of failing.

## [1.5.4] - 2026-02-27

### Added
- **Create folder during export** — The folder picker (used by Crate Export and vault setup) now has a "+ New Folder" button. Create a destination folder without leaving CAM. Backend endpoint `POST /api/assets/create-folder` sanitizes names and prevents duplicates.

### Fixed
- **Shot code auto-increment** — "Add Shot" no longer defaults to SH010 every time. All three Add Shot flows (right-click context menu, Edit Project modal, Import tab) now parse existing shot codes in the sequence, find the highest number, and auto-fill the next available code (e.g., SH010 exists -> defaults to SH020). Previously the context menu hardcoded SH010 and the other flows used a count-based calculation that broke when shots were deleted or renumbered.

## [1.5.3] - 2026-02-27

### Fixed
- **RV overlay intermittent failure** — ComfyUI metadata overlay now works reliably on first toggle. Previously, the overlay only worked sometimes because `_syncCurrentSource()` gated pointer updates behind `_show_comfyui`, which is `False` at startup when `_onSourceLoaded` fires. Pointers are now set unconditionally; the toggle only controls rendering.
- **Multi-clip metadata switching** — When multiple clips are loaded in RV (sequence mode), the ComfyUI metadata overlay now updates automatically when switching between clips. Previously it always showed metadata for the first loaded clip.
  - Root cause: `graph-state-change` fires on graph structure changes, NOT on frame changes. In sequence mode, switching clips is just a frame change.
  - Fix 1: Added `frame-changed` event handler (`_onFrameChanged`) — gated behind `len(cache) > 1` so single-clip viewing has zero overhead.
  - Fix 2: Added `RVSequenceGroup` handler to Strategy 1 — uses `sourcesAtFrame(frame)` to find which source owns the current frame.
  - Fix 3: Made Strategy 2.5 frame-aware — when multiple sources exist, matches current frame to correct source group via `sourcesAtFrame` instead of blindly returning the first source.

### Added
- **`_setComfyUIPointersFromCache(hint_path)`** — New centralized method for setting ComfyUI overlay pointers. Priority: hint_path > `_getCurrentSourcePath()` > single-entry cache fallback. NOT gated behind `_show_comfyui` so pointers are ready before the user toggles the overlay on.
- **Source-switch diagnostic** — Console prints `[MediaVault] source switched -> filename (cached=True/False)` when the viewed clip changes, aiding multi-clip debugging.

## [1.5.2] - 2026-02-26

### Fixed
- **ComfyUI node serialization** — MediaVault nodes (Load/Save) now correctly persist dropdown selections (project, sequence, shot, role, asset) when saving and loading ComfyUI workflows. Previously, values were lost on workflow load or randomly reset.
  - **Root cause**: Custom widgets (preview thumbnail, refresh button, video info) only had `options.serialize = false` but LiteGraph checks the top-level `widget.serialize` property. This caused extra entries in `widgets_values`, inflating the array from 8 to 10+ entries and breaking index alignment during deserialization.
  - **Fix 1**: Added `serialize: false` at the top level of all 4 custom widgets (preview, refresh button, video info, Copy from Load button) so LiteGraph truly excludes them from serialization.
  - **Fix 2**: `onConfigure` now uses `w.serialize !== false` filter (matching LiteGraph's own logic) instead of type-name heuristics, ensuring correct index mapping between `widgets_values` and actual widgets.
  - **Fix 3**: `updateComboWidget()` now injects saved values that aren't in the current live list instead of silently resetting to the first option. This prevents value loss when server data changes between save and load.
  - **Fix 4**: `restoreLiveDropdowns()` now guards against empty server responses — if MediaVault is unreachable when ComfyUI starts, saved values are preserved instead of being wiped.
  - Backwards compatible: old workflows with inflated `widgets_values` arrays still load correctly.

## [1.5.1] - 2026-02-26

### Fixed
- **RV plugin frame mapping** — Alt+C (Add to Crate) now correctly identifies which file is being viewed when scrubbing through versioned image sequences. Previously always sent the first file (e.g., v025) regardless of current frame.
  - Root cause: `nodeRangeInfo()` returns file-native numbers (46-62), not global playback frames (1-27). The mapping formula was comparing incompatible coordinate systems.
  - Fix: `file_num = file_start + (frame - globalFrameStart)` — maps global playback frame to correct file number.
- **RV plugin deployment** — `RVPluginSync` now copies the `.py` file directly to `~/.rv/Python/` on every server startup. Previously only deployed `.rvpkg` files to `Packages/` directories, but RV loads from the `Python/` directory — causing stale plugin code to persist for days.
- **RV plugin hash check** — The deploy hash-check now refreshes the loose `.py` copy even when the `.rvpkg` hash is current, preventing stale code when the `.py` was manually overwritten.

### Added
- **Crate auto-refresh** — Crate panel in the browser now polls every 3 seconds for changes, so assets added from RV appear automatically without manual refresh.
- **RV plugin diagnostics** — Added `[MV-DIAG]` logging for frame resolution debugging. Quiet by default; enable with `MV_DEBUG=1` environment variable. Always fires on errors.

## [1.5.0] - 2026-02-23

### Added
- **Send to ComfyUI** — Right-click any asset(s) in CAM → "Send to ComfyUI" creates LoadFromMediaVault nodes pre-populated with the correct project/sequence/shot/role/asset. Works with multi-select. Nodes appear in the most recently focused ComfyUI tab within 3 seconds (polling-based, no page reload).
- **Active tab tracking** — When multiple ComfyUI tabs are open, "Send to ComfyUI" delivers nodes only to the most recently clicked/focused tab (not a random race condition)
- **Workflow metadata embedding** — SaveToMediaVault now embeds ComfyUI workflow + prompt metadata in saved files:
  - PNG: Embedded in tEXt chunks (same format as ComfyUI's built-in save)
  - Video (MP4/WebM/MKV): Embedded as FFmpeg `-metadata comment=` (same format as VHS Video Combine)
- **Metadata-aware "Load in ComfyUI"** — Right-click menu now checks if the file actually contains an embedded ComfyUI workflow before showing the option (replaces old extension-based filtering)
- **TIFF workflow extraction** — `.tif`/`.tiff` files with embedded ComfyUI workflows can now be detected and loaded back into ComfyUI
- **Pipeline debug logging** — Console logging at every step of the Send to ComfyUI pipeline (CAM browser, CAM server, ComfyUI browser) for easy troubleshooting

## [1.4.6] - 2026-02-22

### Added
- **Status tagging from OpenRV** — Set asset status (WIP, Review, Approved, Final, Reject) directly from the RV MediaVault menu without leaving the viewer
- **RV overlay status stamp** — Color-coded status badge rendered in the RV viewport (top-right corner) via OpenGL overlay
- **Reject status** — New "Reject" option for tagging unwanted content (red badge, Alt+R hotkey in RV)
- **Status badges in list view** — Color-coded status pills displayed in the browser list view (WIP=orange, Review=blue, Approved=green, Final=cyan, Reject=red)
- **Status badges in grid view** — Same color-coded badges on asset card thumbnails
- **List view column sorting** — Click any column header (ID, Show, Shot, Vault Name, Role, Status, Resolution, Size, Created) to sort ascending/descending with arrow indicators

### Fixed
- **Auto-refresh on status change** — Browser now auto-refreshes within 5 seconds when status is changed from RV (no hard refresh needed)
- **RV source resolution** — Setting status on one clip no longer tags all loaded clips; correctly identifies the selected source via viewNode
- **New assets no longer auto-tagged WIP** — Status starts as NULL until manually assigned (previously every import got WIP automatically)
- **Overlay-info 500 error** — Fixed SQL query referencing non-existent `resolution` column

## [1.4.5] - 2026-02-20

### Added
- **Image sequence export** — Export context menu now includes image sequence formats alongside video codecs:
  - EXR Sequence (zip1 compression)
  - PNG Sequence (lossless)
  - TIFF Sequence (16-bit)
  - DPX Sequence (10-bit)
  - JPEG Sequence
- **Grouped codec dropdown** — Export codec selector now groups options into "Video Formats" and "Image Sequences" with `<optgroup>` labels
- **Sequence preview** — Export preview shows folder path and frame naming pattern (e.g. `name.0001.exr`) when a sequence format is selected
- **Automatic subfolder creation** — Sequence exports create a named subfolder containing all frames, preserving the project hierarchy structure
## [1.4.4] - 2026-02-20

### Fixed
- **DNxHD / MXF container scrub support** — added `-analyzeduration` and `-probesize` flags to FFmpeg transcode so MXF-wrapped DNxHD files are properly detected and transcoded
- **Audio stripped for scrub preview** — scrub transcodes (480px) now skip audio encoding entirely (`-an`), cutting transcode time roughly in half
- **Lower quality scrub preview** — CRF bumped from 23 to 28 for 480px scrub previews to further reduce transcode latency
- **Transcoded stream duration handling** — fragmented MP4 streams that report `Infinity` duration no longer block scrub; buffered-range scrubbing works regardless of duration metadata
## [1.4.3] - 2026-02-20

### Fixed
- **ProRes video scrub black frames** — Safari on macOS now plays ProRes files natively via hardware decoder instead of transcoding, enabling full scrub support
- **Slow transcode on hover** — non-browser codecs (ProRes, DNxHR, etc.) now transcode at 480px wide for scrub preview instead of full 4K resolution, dramatically reducing load time
- **Black flash on hover** — thumbnail stays visible until a real video frame is painted (uses requestAnimationFrame), preventing the black flash before first frame
- **Transcoded stream scrubbing** — transcoded videos now allow scrubbing within the buffered range instead of completely disabling seek
- **Transcode error resilience** — if transcode fails or times out, the thumbnail stays visible instead of showing a black frame
## [1.4.3] - 2026-02-20

### Fixed
- **ProRes video scrub black frames** — Safari on macOS now plays ProRes files natively via hardware decoder instead of transcoding, enabling full scrub support
- **Slow transcode on hover** — non-browser codecs (ProRes, DNxHR, etc.) now transcode at 480px wide for scrub preview instead of full 4K resolution, dramatically reducing load time
- **Black flash on hover** — thumbnail stays visible until a real video frame is painted (uses requestAnimationFrame), preventing the black flash before first frame
- **Transcoded stream scrubbing** — transcoded videos now allow scrubbing within the buffered range instead of completely disabling seek
- **Transcode error resilience** — if transcode fails or times out, the thumbnail stays visible instead of showing a black frame
## [1.4.2] - 2026-02-20

### Performance
- **Lazy-loaded thumbnails** — asset grid now uses `IntersectionObserver` so thumbnails only load when scrolled into view; eliminates thousands of simultaneous HTTP requests on large projects
- **Static thumbnail serving** — thumbnails served directly from `/thumbnails/` via Express static middleware instead of per-asset API route + DB query; dramatically reduces server load
- **24-hour Cache-Control headers** — thumbnail responses include `Cache-Control: public, max-age=86400` so browsers cache them and skip repeat downloads
- **FFmpeg path caching** — `ThumbnailService.findFFmpeg()` now resolves once and caches the result instead of re-discovering on every thumbnail generation

### Added
- **Auto-repair missing thumbnails on startup** — server automatically detects thumbnail files missing from disk (e.g., after moving the database to a different machine) and regenerates them in the background with controlled concurrency; no manual intervention required

### Fixed
- **Cross-platform thumbnail availability** — when sharing a database between Windows and Mac, thumbnails that were generated on one platform are now automatically regenerated on the other at startup, rather than triggering slow on-demand FFmpeg calls during browsing

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
