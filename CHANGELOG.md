# Changelog

All notable changes to Digital Media Vault will be documented in this file.

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
