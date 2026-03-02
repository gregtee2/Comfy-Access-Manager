# Building OpenRV for macOS — MediaVault Companion Guide

> **Context**: MediaVault uses OpenRV as its media viewer for playback, A/B wipe comparison, EXR/HDR support, and persistent review sessions. On Windows we compiled it from source and bundle it as a 272 MB zip. This guide helps you do the same on macOS.
>
> **Our Windows build**: Took ~2 hours on a 24-core Xeon. macOS should be similar. Expect some head-banging — that's normal.

---

## TL;DR — What You're Building

OpenRV is a professional media viewer (the open-source version of Autodesk's ShotGrid RV). You're compiling:
- **rv** — the viewer app (plays video, EXR, images, side-by-side wipe comparison)
- **rvpush** — command-line tool to send files to a running RV session
- **rvio** — batch image/video converter (optional but nice)
- **All I/O plugins** — EXR, JPEG, PNG, TIFF, DPX, FFmpeg codecs

The final output is `RV.app` in `_build/stage/app/`.

---

## Prerequisites

### 1. Xcode (NOT Xcode 26!)

```bash
# Xcode 16.4 works. Xcode 26 breaks Qt 6.5.3 (QTBUG-137687).
xcode-select -p
# Should return: /Applications/Xcode.app/Contents/Developer
# If not:
sudo xcode-select -s /Applications/Xcode.app
```

### 2. CMake 3.31.x (NOT 4.x!)

**This is critical.** Homebrew now installs CMake 4.x which BREAKS OpenRV.

Download CMake 3.31.7 directly:
- https://github.com/Kitware/CMake/releases/download/v3.31.7/cmake-3.31.7-macos-universal.dmg

Install it, then add to PATH:
```bash
sudo "/Applications/CMake.app/Contents/bin/cmake-gui" --install=/usr/local/bin
cmake --version  # Should show 3.31.x
```

> **🚨 LESSON FROM WINDOWS**: CMake 4.x causes `CMAKE_POLICY` errors everywhere. OpenRV's CMakeLists.txt uses old policy syntax. On Windows we worked around it with `CMAKE_POLICY_VERSION_MINIMUM=3.5`, but it's cleaner to just use CMake 3.31.

### 3. Homebrew + Build Dependencies

```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install all build deps (VFX Platform CY2024)
brew install ninja readline sqlite3 xz zlib tcl-tk@8 autoconf automake libtool \
    python@3.11 yasm clang-format black meson nasm pkg-config glew rust
```

### 4. Qt 6.5.3

Download from the [Qt online installer](https://www.qt.io/download-open-source).

- Install Qt 6.5.3 for macOS
- Note the install path (typically `~/Qt/6.5.3/macos/` or `~/Qt/6.5.3/clang_64/`)
- **Do NOT use Homebrew's Qt** — it's known to not work with OpenRV

### 5. Allow Terminal App Management

macOS System Settings → Privacy & Security → App Management → allow Terminal to update/delete apps.

---

## Clone & Build

### Step 1: Clone

```bash
git clone --recursive https://github.com/AcademySoftwareFoundation/OpenRV.git
cd OpenRV
```

### Step 2: Source the build aliases

```bash
source rvcmds.sh
# When prompted, select: CY2024
```

This sets up environment variables, finds your Qt install, creates a Python venv, etc.

### Step 3: Bootstrap (first-time build)

```bash
rvbootstrap
```

This will:
1. Create the `_build` directory
2. Download and compile all C++ dependencies (Boost, OpenEXR, OCIO, FFmpeg, etc.)
3. Build RV itself
4. Takes 1-2 hours depending on your Mac

> **If rvbootstrap fails partway through**, just run `rvmk` to retry. The build system is incremental — it picks up where it left off.

### Step 4: Verify it works

```bash
# The executable on macOS is an .app bundle:
./_build/stage/app/RV.app/Contents/MacOS/RV --help

# Or launch it:
open _build/stage/app/RV.app
```

---

## Enable Extra Codecs (ProRes, DNxHD, AAC)

By default OpenRV disables some codecs for licensing reasons. For a VFX workflow you want them.

```bash
# Reconfigure with codec flags
rvcfg \
    -DRV_FFMPEG_NON_FREE_DECODERS_TO_ENABLE="dnxhd;prores;aac;aac_fixed;aac_latm;ac3;qtrle" \
    -DRV_FFMPEG_NON_FREE_ENCODERS_TO_ENABLE="dnxhd;prores;qtrle"

# Rebuild
rvmk
```

### Apple ProRes on Apple Silicon (M1/M2/M3/M4)

If you're on Apple Silicon, OpenRV can use **VideoToolbox hardware decoding**:

```bash
rvcfg \
    -DRV_FFMPEG_USE_VIDEOTOOLBOX=ON \
    -DRV_FFMPEG_NON_FREE_DECODERS_TO_ENABLE="prores;dnxhd;aac;aac_fixed;aac_latm;ac3;qtrle" \
    -DRV_FFMPEG_NON_FREE_ENCODERS_TO_ENABLE="dnxhd;prores;qtrle"

rvmk
```

> **Note**: Apple requires a ProRes license from ProRes@apple.com for distribution. For personal/studio use, this is fine.

---

## AJA Plugin — Disable It

The AJA professional video I/O plugin will fail to link unless you have AJA hardware + SDK. Just disable it:

```bash
# Move the AJA source out of the build tree
mv src/plugins/output/AJADevices ./AJADevices.disabled

# Also comment out AJA in cmake/dependencies/CMakeLists.txt:
# Find the line: INCLUDE(aja.cmake)
# Comment it out: # INCLUDE(aja.cmake)

# Reconfigure + rebuild
rvcfg
rvmk
```

> **🚨 LESSON FROM WINDOWS**: Just renaming the folder doesn't work — CMake's `FILE(GLOB)` still finds its CMakeLists.txt. You have to physically move it OUT of the source tree.

---

## Trimming for Distribution

Once built, the full `_build/` directory is ~6 GB. For distribution you only need the runtime files.

### What to Keep

| Directory | Size (approx) | Purpose |
|-----------|---------------|---------|
| `RV.app/` (inside `_build/stage/app/`) | ~500-700 MB | The complete app bundle |

On macOS, `RV.app` is self-contained (frameworks and dylibs are inside the bundle), so you mainly just need to copy the `.app`.

### What to Strip

| Item | Size | Safe to Remove |
|------|------|---------------|
| `*.dSYM` files | Huge | Yes — debug symbols, not needed for runtime |
| `_build/cmake/` | ~2 GB | Yes — build intermediates |
| `_build/lib/` | ~2 GB | Yes — static libs used during linking only |
| `.pdb` / `.o` / `.a` files | Varies | Yes — build artifacts |

### Create the Trimmed Distribution

```bash
# Use OpenRV's built-in install step (strips debug symbols automatically!)
cmake --install _build --prefix _install

# Or manually:
# The .app is at _build/stage/app/RV.app
# Just copy it:
cp -R _build/stage/app/RV.app ~/Desktop/OpenRV.app
```

### Zip It Up

```bash
cd _install  # or wherever you put RV.app
zip -r OpenRV-3.1.0-macos-mediavault.zip RV.app/
```

---

## Wiring Into MediaVault

Once you have the built `RV.app`, MediaVault needs to find it.

### Option A: Put it in Applications (simplest)

```bash
cp -R RV.app /Applications/RV.app
```

MediaVault's `findRV()` already scans `/Applications/RV*.app`.

### Option B: Put it in MediaVault's tools/ folder

```bash
# Inside your MediaVault directory:
mkdir -p tools/rv
cp -R RV.app tools/rv/RV.app
```

Then the `findRV()` function in `assetRoutes.js` will need the macOS path added. It currently checks:
```javascript
// tools/rv/bin/rv.exe (Windows)
const bundledRv = path.join(__dirname, '..', '..', 'tools', 'rv', 'bin', isWin ? 'rv.exe' : 'rv');
```

For macOS, you'd want to check:
```javascript
// tools/rv/RV.app/Contents/MacOS/RV (macOS)
const bundledRvMac = path.join(__dirname, '..', '..', 'tools', 'rv', 'RV.app', 'Contents', 'MacOS', 'RV');
```

### Option C: Set path in DMV Settings

Just open MediaVault → Settings → set "RV Path" to wherever your RV binary is:
- `/Applications/RV.app/Contents/MacOS/RV`
- Or `~/OpenRV/_build/stage/app/RV.app/Contents/MacOS/RV`

---

## 🚨 Gotchas & Hard-Won Lessons (From Our Windows Build)

These issues are platform-specific, but the PATTERNS will repeat on macOS:

### 1. CMake 4.x Breaks Everything
OpenRV uses old CMake policy syntax. CMake 4.x treats these as errors.
- **Fix**: Use CMake 3.31.x
- **Workaround if stuck**: `export CMAKE_POLICY_VERSION_MINIMUM=3.5`

### 2. FFmpeg's configure Is a Bash Script
On Windows we needed MSYS2 for this. On macOS this should "just work" since you have a real shell. But if something goes wrong with FFmpeg's build:
- Check `PKG_CONFIG_LIBDIR` — it must point to OpenRV's built deps, NOT your system's
- `unset PKG_CONFIG_PATH` to prevent system pkg-config from interfering

### 3. AJA Plugin Causes Link Errors
The AJA plugin tries to link against `ajantv2_*.lib` which you don't have.
- **Fix**: Move `src/plugins/output/AJADevices` OUT of source tree AND comment out `INCLUDE(aja.cmake)`

### 4. rvbootstrap May Fail Mid-Build
Some dependency builds are flaky. If it fails:
- Don't panic
- Run `rvmk` to retry (it's incremental)
- If a specific dep fails, you can rebuild just that dep: `rvbuildt RV_DEPS_FFMPEG` (or whatever)

### 5. FFmpeg Codec Rebuild Requires Deleting Stamp Files
If you change codec flags AFTER a successful build, FFmpeg won't rebuild because CMake thinks it's done.
- **Fix**: Delete the stamp files:
```bash
rm -f _build/cmake/dependencies/RV_DEPS_FFMPEG-prefix/src/RV_DEPS_FFMPEG-stamp/Release/RV_DEPS_FFMPEG-{configure,build,install}
```
Then `rvmk` again.

### 6. Qt from Homebrew Does NOT Work
OpenRV needs the official Qt distribution with specific features. Homebrew's Qt is built differently.
- **Fix**: Always use the Qt online installer

### 7. The Build Is HUGE — Don't Panic
The full `_build/` will be 5-6 GB. That's normal — it builds dozens of C++ libraries from source (Boost, OpenEXR, OCIO, FFmpeg, etc.). The trimmed runtime is only ~500-700 MB.

---

## Quick Reference — Build Commands

| Command | What It Does |
|---------|-------------|
| `source rvcmds.sh` | Load build aliases (must do first, every terminal session) |
| `rvbootstrap` | First-time full build (clone deps, build everything) |
| `rvmk` | Incremental rebuild (after first time) |
| `rvcfg` | Re-run CMake configure only |
| `rvbuild` | Build only (no configure) |
| `rvclean` | Delete build directory + start fresh |
| `rvtest` | Run automated tests |
| `rvinst` | Create install package (stripped for distribution) |
| `rvappdir` | cd to the directory containing the built RV binary |

---

## Expected Timeline

| Phase | Duration | Notes |
|-------|----------|-------|
| Install prerequisites | 30 min | Xcode, CMake, Homebrew, Qt |
| Clone repo | 5 min | ~500 MB with submodules |
| `rvbootstrap` (first build) | 1-2 hours | Downloads + compiles ~30 deps |
| Enable codecs + rebuild | 15-30 min | Incremental, only FFmpeg rebuilds |
| AJA disable + rebuild | 5 min | Quick reconfigure |
| Test + trim | 15 min | Verify, zip |
| **Total** | **~2-3 hours** | First time only. Rebuilds are 5-10 min. |

---

## What We Need Back

Once you have a working macOS build:

1. **The trimmed zip** — `OpenRV-3.1.0-macos-mediavault.zip` (just the .app or the `_install` output)
2. **Any additional gotchas** you hit that aren't in this guide
3. **Whether it's Intel or Apple Silicon (or universal)** — this affects the filename for the GitHub Release

We'll upload it as a GitHub Release asset alongside the Windows zip, and wire `install.sh` to auto-download it — same pattern we did for Windows.

---

## Links

- **Official macOS setup**: https://aswf-openrv.readthedocs.io/en/latest/build_system/config_macos.html
- **Common build instructions**: https://aswf-openrv.readthedocs.io/en/latest/build_system/config_common_build.html
- **Build errors reference**: https://aswf-openrv.readthedocs.io/en/latest/build_system/build_errors.html
- **OpenRV GitHub**: https://github.com/AcademySoftwareFoundation/OpenRV
- **Our MediaVault repo**: https://github.com/LatentPixelLLC/Comfy-Access-Manager
- **Our Windows RV zip (for reference)**: https://github.com/LatentPixelLLC/Comfy-Access-Manager/releases/tag/rv-3.1.0
