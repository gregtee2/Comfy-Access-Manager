/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * RV Plugin Sync Service
 *
 * Automatically deploys the MediaVault RV plugin from rv-package/ into every
 * detected RV installation on server startup.
 *
 * IMPORTANT: RV requires packages to be registered via the `rvpkg` CLI tool.
 * Simply dropping a .rvpkg file into the Packages/ directory is NOT enough —
 * the package won't be loaded. We must run `rvpkg -install -add -force`.
 *
 * Cross-platform: handles macOS .app bundles, Windows program dirs, Linux paths,
 * plus bundled tools/rv/ and user-level ~/.rv/Packages.
 *
 * This ensures that whenever you update mediavault_mode.py on ANY platform,
 * a server restart deploys the latest version everywhere.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PLUGIN_NAME = 'mediavault';
const PLUGIN_VERSION = '1.0';
const RVPKG_FILENAME = `${PLUGIN_NAME}-${PLUGIN_VERSION}.rvpkg`;

// Source directory containing PACKAGE + mediavault_mode.py
const PLUGIN_SRC = path.join(__dirname, '..', '..', 'rv-package');

/**
 * Build a .rvpkg (zip) from the source files using Node's built-in zlib.
 * Returns the buffer of the zip file, or null on error.
 */
function buildRvpkg() {
    const packageFile = path.join(PLUGIN_SRC, 'PACKAGE');
    const pyFile = path.join(PLUGIN_SRC, 'mediavault_mode.py');

    if (!fs.existsSync(packageFile) || !fs.existsSync(pyFile)) {
        console.log('[RVPlugin] Source files not found in rv-package/ — skipping');
        return null;
    }

    // Use command-line zip to create the rvpkg (available on all platforms)
    const tmpDir = os.tmpdir();
    const outPath = path.join(tmpDir, RVPKG_FILENAME);

    try {
        // Remove old temp file if exists
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

        if (process.platform === 'win32') {
            // Use tar (built into Windows 10+) instead of PowerShell to avoid
            // path escaping issues with spaces/parentheses and extension restrictions
            const tmpZip = path.join(tmpDir, 'mediavault-1.0.zip');
            if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
            execSync(
                `tar -a -cf "${tmpZip}" -C "${PLUGIN_SRC}" PACKAGE mediavault_mode.py`,
                { stdio: 'pipe', timeout: 10000 }
            );
            if (fs.existsSync(tmpZip)) {
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                fs.renameSync(tmpZip, outPath);
            }
        } else {
            // Unix zip command — build from within the source dir so paths are relative
            execSync(
                `cd "${PLUGIN_SRC}" && zip -j "${outPath}" PACKAGE mediavault_mode.py`,
                { stdio: 'pipe', timeout: 10000 }
            );
        }

        if (fs.existsSync(outPath)) {
            return fs.readFileSync(outPath);
        }
    } catch (err) {
        console.log('[RVPlugin] Failed to build rvpkg:', err.message);
    }

    return null;
}

/**
 * Compute a quick hash of the source files to detect changes.
 */
function sourceHash() {
    try {
        const crypto = require('crypto');
        const h = crypto.createHash('md5');
        const pyFile = path.join(PLUGIN_SRC, 'mediavault_mode.py');
        const pkgFile = path.join(PLUGIN_SRC, 'PACKAGE');
        if (fs.existsSync(pyFile)) h.update(fs.readFileSync(pyFile));
        if (fs.existsSync(pkgFile)) h.update(fs.readFileSync(pkgFile));
        return h.digest('hex');
    } catch {
        return Date.now().toString();
    }
}

/**
 * Find all RV installations on this system.
 * Returns array of objects: { packagesDir, rvpkgBin }
 *   packagesDir: absolute path to the PlugIns/Packages/ folder
 *   rvpkgBin:    absolute path to the rvpkg CLI tool (or null if not found)
 */
function findRVInstalls() {
    const installs = [];
    const seen = new Set();
    const appRoot = path.join(__dirname, '..', '..');

    function addMac(appBundle) {
        const pkg = path.join(appBundle, 'Contents', 'PlugIns', 'Packages');
        const bin = path.join(appBundle, 'Contents', 'MacOS', 'rvpkg');
        if (fs.existsSync(pkg) && !seen.has(pkg)) {
            seen.add(pkg);
            installs.push({ packagesDir: pkg, rvpkgBin: fs.existsSync(bin) ? bin : null });
        }
    }

    function addFlat(packagesDir, rvpkgBin) {
        if (fs.existsSync(packagesDir) && !seen.has(packagesDir)) {
            seen.add(packagesDir);
            installs.push({ packagesDir, rvpkgBin: (rvpkgBin && fs.existsSync(rvpkgBin)) ? rvpkgBin : null });
        }
    }

    // 1. Bundled RV (our own tools/rv/)
    if (process.platform === 'darwin') {
        // macOS: tools/rv/RV.app bundle(s)
        const toolsRv = path.join(appRoot, 'tools', 'rv');
        if (fs.existsSync(toolsRv)) {
            try {
                for (const entry of fs.readdirSync(toolsRv)) {
                    if (entry.endsWith('.app')) {
                        addMac(path.join(toolsRv, entry));
                    }
                }
            } catch {}
        }
    } else if (process.platform === 'win32') {
        // Windows: tools/rv/Packages/ or tools/rv/app/Packages/
        for (const sub of ['Packages', 'app/Packages', 'PlugIns/Packages']) {
            const pkg = path.join(appRoot, 'tools', 'rv', sub);
            const bin = path.join(appRoot, 'tools', 'rv', 'bin', 'rvpkg.exe');
            addFlat(pkg, bin);
        }
    } else {
        const pkg = path.join(appRoot, 'tools', 'rv', 'Packages');
        const bin = path.join(appRoot, 'tools', 'rv', 'bin', 'rvpkg');
        addFlat(pkg, bin);
    }

    // 2. User-level RV packages (~/.rv/Packages/)
    //    For this we need an rvpkg binary from ANY detected install
    const userPkg = path.join(os.homedir(), '.rv', 'Packages');
    if (!seen.has(userPkg)) {
        seen.add(userPkg);
        installs.push({ packagesDir: userPkg, rvpkgBin: null }); // rvpkgBin filled later
    }

    // 3. System-wide RV installations
    if (process.platform === 'darwin') {
        // /Applications/RV*.app
        try {
            const apps = fs.readdirSync('/Applications');
            for (const app of apps) {
                if (app.match(/^RV/i) && app.endsWith('.app')) {
                    addMac(path.join('/Applications', app));
                }
            }
        } catch {}

        // Self-compiled OpenRV
        for (const sub of ['_build/stage/app', '_install']) {
            const appBundle = path.join(os.homedir(), 'OpenRV', sub, 'RV.app');
            if (fs.existsSync(appBundle)) addMac(appBundle);
        }

    } else if (process.platform === 'win32') {
        const progDirs = [
            process.env['ProgramFiles'] || 'C:\\Program Files',
            process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        ];
        for (const progDir of progDirs) {
            try {
                for (const entry of fs.readdirSync(progDir)) {
                    if (entry.match(/^(RV|Autodesk.*RV|ShotGrid.*RV|Shotgun.*RV)/i)) {
                        for (const sub of ['Packages', 'app/Packages', 'PlugIns/Packages']) {
                            const pkg = path.join(progDir, entry, sub);
                            const bin = path.join(progDir, entry, 'bin', 'rvpkg.exe');
                            addFlat(pkg, bin);
                        }
                    }
                }
            } catch {}
        }
        addFlat(path.join('C:', 'OpenRV', '_build', 'stage', 'app', 'Packages'),
                path.join('C:', 'OpenRV', '_build', 'stage', 'app', 'bin', 'rvpkg.exe'));
        addFlat(path.join('C:', 'OpenRV', '_build', 'stage', 'app', 'PlugIns', 'Packages'),
                path.join('C:', 'OpenRV', '_build', 'stage', 'app', 'bin', 'rvpkg.exe'));

    } else {
        for (const base of ['/opt/rv', '/usr/local/rv']) {
            addFlat(path.join(base, 'Packages'), path.join(base, 'bin', 'rvpkg'));
        }
    }

    // Fill in rvpkgBin for user-level (~/.rv) by borrowing from any found install
    const anyBin = installs.find(i => i.rvpkgBin)?.rvpkgBin;
    for (const inst of installs) {
        if (!inst.rvpkgBin && anyBin) inst.rvpkgBin = anyBin;
    }

    return installs;
}

/**
 * Deploy the plugin to a target RV installation.
 *
 * Uses the `rvpkg` CLI tool to properly register the package so RV loads it.
 * Just dropping a .rvpkg file into Packages/ is NOT sufficient — RV maintains
 * an internal registry and ignores unregistered packages.
 *
 * Steps:
 *   1. Write .rvpkg to Packages/ directory
 *   2. Run `rvpkg -install -add -force` to register + extract the .py
 *   3. If no rvpkg CLI is available, fall back to manual file placement
 *
 * Returns true if deployed, false if skipped/failed.
 */
function deployTo(rvpkgBuffer, install, hash) {
    const { packagesDir, rvpkgBin } = install;
    try {
        // Ensure Packages directory exists
        if (!fs.existsSync(packagesDir)) {
            fs.mkdirSync(packagesDir, { recursive: true });
        }

        const targetFile = path.join(packagesDir, RVPKG_FILENAME);
        const hashFile = path.join(packagesDir, `.${PLUGIN_NAME}.hash`);
        const pythonDir = path.join(packagesDir, '..', 'Python');
        const loosePy = path.join(pythonDir, 'mediavault_mode.py');

        // Check if already up to date (rvpkg + hash match)
        if (fs.existsSync(targetFile) && fs.existsSync(hashFile)) {
            const existingHash = fs.readFileSync(hashFile, 'utf8').trim();
            if (existingHash === hash) {
                // Even if hash matches, ensure the loose .py copy is current
                const pySrc = path.join(PLUGIN_SRC, 'mediavault_mode.py');
                if (fs.existsSync(pySrc) && fs.existsSync(pythonDir)) {
                    try { fs.copyFileSync(pySrc, loosePy); } catch {}
                }
                return false; // rvpkg already current
            }
        }

        // Remove any old versions of our plugin rvpkg
        try {
            for (const f of fs.readdirSync(packagesDir)) {
                if (f.startsWith(PLUGIN_NAME) && f.endsWith('.rvpkg')) {
                    fs.unlinkSync(path.join(packagesDir, f));
                }
            }
        } catch {}

        // Write the new rvpkg file
        fs.writeFileSync(targetFile, rvpkgBuffer);

        // Try to use rvpkg CLI to properly register + install the package.
        // The rvpkg file is already in the Packages/ dir, so we just need
        // to run `rvpkg -install -force <filename>` to register it.
        // rvpkg finds the file by name within its RV_SUPPORT_PATH.
        let installedViaCLI = false;
        if (rvpkgBin) {
            try {
                execSync(
                    `"${rvpkgBin}" -install -force "${RVPKG_FILENAME}"`,
                    { stdio: 'pipe', timeout: 15000 }
                );
                installedViaCLI = true;
            } catch (cliErr) {
                // rvpkg may fail on some installs (permissions, etc.) — fall back to manual
                console.log(`[RVPlugin] rvpkg CLI failed for ${packagesDir}: ${cliErr.message.split('\n')[0]}`);
            }
        }

        // If CLI didn't work, manually place the .py in Python/ as fallback
        if (!installedViaCLI) {
            const pySrc = path.join(PLUGIN_SRC, 'mediavault_mode.py');
            if (fs.existsSync(pySrc)) {
                if (!fs.existsSync(pythonDir)) {
                    fs.mkdirSync(pythonDir, { recursive: true });
                }
                fs.copyFileSync(pySrc, loosePy);
            }
        }

        // Write hash marker
        fs.writeFileSync(hashFile, hash);

        return true;
    } catch (err) {
        // Permission denied on system dirs is expected — just skip
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            return false;
        }
        console.log(`[RVPlugin] Deploy to ${packagesDir} failed:`, err.message);
        return false;
    }
}

/**
 * Main sync entry point. Called at server startup.
 * Builds the rvpkg from source, scans for RV installations, deploys.
 */
function sync() {
    if (!fs.existsSync(PLUGIN_SRC)) {
        // No rv-package directory — nothing to sync (e.g. production install without it)
        return;
    }

    const hash = sourceHash();
    const rvpkgBuffer = buildRvpkg();
    if (!rvpkgBuffer) return;

    const installs = findRVInstalls();
    let deployed = 0;
    let skipped = 0;

    for (const install of installs) {
        const result = deployTo(rvpkgBuffer, install, hash);
        if (result) {
            deployed++;
            console.log(`[RVPlugin] ✓ Deployed to ${install.packagesDir}${install.rvpkgBin ? ' (via rvpkg CLI)' : ' (manual)'}`);
        } else {
            skipped++;
        }
    }

    // Always copy to user-level ~/.rv/Python/ — this is the primary
    // directory RV searches for Python plugins.  The rvpkg registry
    // may or may not extract the .py there, so we ensure it manually.
    try {
        const userRvPython = path.join(os.homedir(), '.rv', 'Python');
        const pySrc = path.join(PLUGIN_SRC, 'mediavault_mode.py');
        if (fs.existsSync(pySrc)) {
            if (!fs.existsSync(userRvPython)) {
                fs.mkdirSync(userRvPython, { recursive: true });
            }
            fs.copyFileSync(pySrc, path.join(userRvPython, 'mediavault_mode.py'));
            console.log(`[RVPlugin] ✓ Copied .py to ${userRvPython}`);
        }
    } catch (err) {
        console.log(`[RVPlugin] Warning: Could not copy to ~/.rv/Python: ${err.message}`);
    }

    // Also copy to any PlugIns/Python/ directories found alongside
    // PlugIns/Packages/ (self-compiled OpenRV loads from here).
    try {
        const pySrc = path.join(PLUGIN_SRC, 'mediavault_mode.py');
        if (fs.existsSync(pySrc)) {
            for (const install of installs) {
                const pluginsPython = path.join(
                    path.dirname(install.packagesDir), 'Python'
                );
                if (fs.existsSync(pluginsPython)) {
                    fs.copyFileSync(pySrc, path.join(pluginsPython, 'mediavault_mode.py'));
                    console.log(`[RVPlugin] ✓ Copied .py to ${pluginsPython}`);
                }
            }
        }
    } catch (err) {
        console.log(`[RVPlugin] Warning: Could not copy to PlugIns/Python: ${err.message}`);
    }

    if (deployed > 0) {
        console.log(`[RVPlugin] Synced MediaVault plugin to ${deployed} RV installation(s)`);
    } else if (installs.length > 0) {
        console.log('[RVPlugin] MediaVault plugin already up to date');
    } else {
        console.log('[RVPlugin] No RV installations found — plugin will deploy when RV is installed');
    }
}

module.exports = { sync, findRVInstalls, buildRvpkg };
