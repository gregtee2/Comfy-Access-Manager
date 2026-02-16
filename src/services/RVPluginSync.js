/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * RV Plugin Sync Service
 *
 * Automatically deploys the MediaVault RV plugin from rv-package/ into every
 * detected RV installation's Packages directory on server startup.
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
            // PowerShell Compress-Archive
            const files = [packageFile, pyFile].map(f => `"${f}"`).join(',');
            execSync(
                `powershell -NoProfile -Command "Compress-Archive -Path ${files} -DestinationPath '${outPath}' -Force"`,
                { stdio: 'pipe', timeout: 10000 }
            );
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
 * Find all RV Packages directories on this system.
 * Returns array of absolute paths to Packages/ folders.
 */
function findRVPackageDirs() {
    const dirs = new Set();
    const appRoot = path.join(__dirname, '..', '..');

    // 1. Bundled RV (our own tools/rv/)
    if (process.platform === 'darwin') {
        // macOS: tools/rv/RV.app/Contents/PlugIns/Packages/
        const bundled = path.join(appRoot, 'tools', 'rv', 'RV.app', 'Contents', 'PlugIns', 'Packages');
        if (fs.existsSync(bundled)) dirs.add(bundled);

        // Also check for any RV.app variants
        const toolsRv = path.join(appRoot, 'tools', 'rv');
        if (fs.existsSync(toolsRv)) {
            try {
                for (const entry of fs.readdirSync(toolsRv)) {
                    if (entry.endsWith('.app')) {
                        const pkg = path.join(toolsRv, entry, 'Contents', 'PlugIns', 'Packages');
                        if (fs.existsSync(pkg)) dirs.add(pkg);
                    }
                }
            } catch {}
        }
    } else if (process.platform === 'win32') {
        // Windows: tools/rv/Packages/ or tools/rv/app/Packages/
        for (const sub of ['Packages', 'app/Packages', 'bin/../Packages']) {
            const bundled = path.join(appRoot, 'tools', 'rv', sub);
            if (fs.existsSync(bundled)) dirs.add(bundled);
        }
    } else {
        // Linux bundled
        const bundled = path.join(appRoot, 'tools', 'rv', 'Packages');
        if (fs.existsSync(bundled)) dirs.add(bundled);
    }

    // 2. User-level RV packages (~/.rv/Packages/)
    //    Works on all platforms — RV checks this automatically
    const userRv = path.join(os.homedir(), '.rv', 'Packages');
    // Always create this as a fallback target even if no bundled RV is found
    dirs.add(userRv);

    // 3. System-wide RV installations
    if (process.platform === 'darwin') {
        // /Applications/RV*.app
        try {
            const apps = fs.readdirSync('/Applications');
            for (const app of apps) {
                if (app.match(/^RV/i) && app.endsWith('.app')) {
                    const pkg = path.join('/Applications', app, 'Contents', 'PlugIns', 'Packages');
                    if (fs.existsSync(pkg)) dirs.add(pkg);
                }
            }
        } catch {}

        // Self-compiled OpenRV
        const selfBuilt = path.join(os.homedir(), 'OpenRV', '_build', 'stage', 'app', 'RV.app', 'Contents', 'PlugIns', 'Packages');
        if (fs.existsSync(selfBuilt)) dirs.add(selfBuilt);
        const selfInstalled = path.join(os.homedir(), 'OpenRV', '_install', 'RV.app', 'Contents', 'PlugIns', 'Packages');
        if (fs.existsSync(selfInstalled)) dirs.add(selfInstalled);

    } else if (process.platform === 'win32') {
        // Scan Program Files for Autodesk/ShotGrid/Shotgun RV
        const progDirs = [
            process.env['ProgramFiles'] || 'C:\\Program Files',
            process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        ];
        for (const progDir of progDirs) {
            try {
                for (const entry of fs.readdirSync(progDir)) {
                    if (entry.match(/^(RV|Autodesk.*RV|ShotGrid.*RV|Shotgun.*RV)/i)) {
                        // Check common sub-paths
                        for (const sub of ['Packages', 'app/Packages']) {
                            const pkg = path.join(progDir, entry, sub);
                            if (fs.existsSync(pkg)) dirs.add(pkg);
                        }
                    }
                }
            } catch {}
        }

        // Self-compiled OpenRV on Windows
        const selfBuilt = path.join('C:', 'OpenRV', '_build', 'stage', 'app', 'Packages');
        if (fs.existsSync(selfBuilt)) dirs.add(selfBuilt);

    } else {
        // Linux: /opt/rv, /usr/local/rv
        for (const base of ['/opt/rv', '/usr/local/rv']) {
            const pkg = path.join(base, 'Packages');
            if (fs.existsSync(pkg)) dirs.add(pkg);
        }
    }

    return [...dirs];
}

/**
 * Deploy the plugin rvpkg to a target Packages directory AND
 * extract the loose .py to the sibling Python/ directory.
 *
 * RV requires BOTH:
 *   PlugIns/Packages/mediavault-1.0.rvpkg   (package archive)
 *   PlugIns/Python/mediavault_mode.py        (loose file RV actually imports)
 *
 * For ~/.rv/Packages the Python dir is ~/.rv/Python.
 *
 * Returns true if deployed, false if skipped/failed.
 */
function deployTo(rvpkgBuffer, targetDir, hash) {
    try {
        // Ensure Packages directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const targetFile = path.join(targetDir, RVPKG_FILENAME);
        const hashFile = path.join(targetDir, `.${PLUGIN_NAME}.hash`);

        // Check if already up to date (both rvpkg AND loose .py must exist)
        const pythonDir = path.join(targetDir, '..', 'Python');
        const loosePy = path.join(pythonDir, 'mediavault_mode.py');

        if (fs.existsSync(targetFile) && fs.existsSync(hashFile) && fs.existsSync(loosePy)) {
            const existingHash = fs.readFileSync(hashFile, 'utf8').trim();
            if (existingHash === hash) {
                return false; // Already current
            }
        }

        // Remove any old versions of our plugin rvpkg
        try {
            for (const f of fs.readdirSync(targetDir)) {
                if (f.startsWith(PLUGIN_NAME) && f.endsWith('.rvpkg')) {
                    fs.unlinkSync(path.join(targetDir, f));
                }
            }
        } catch {}

        // Write the new rvpkg and hash marker
        fs.writeFileSync(targetFile, rvpkgBuffer);
        fs.writeFileSync(hashFile, hash);

        // Also deploy the loose .py into sibling Python/ directory
        // This is what RV actually imports at startup
        const pySrc = path.join(PLUGIN_SRC, 'mediavault_mode.py');
        if (fs.existsSync(pySrc)) {
            if (!fs.existsSync(pythonDir)) {
                fs.mkdirSync(pythonDir, { recursive: true });
            }
            fs.copyFileSync(pySrc, loosePy);
        }

        return true;
    } catch (err) {
        // Permission denied on system dirs is expected — just skip
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            return false;
        }
        console.log(`[RVPlugin] Deploy to ${targetDir} failed:`, err.message);
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

    const targets = findRVPackageDirs();
    let deployed = 0;
    let skipped = 0;

    for (const dir of targets) {
        const result = deployTo(rvpkgBuffer, dir, hash);
        if (result) {
            deployed++;
            const pyDir = path.join(dir, '..', 'Python');
            console.log(`[RVPlugin] ✓ Deployed to ${dir} + ${pyDir}`);
        } else {
            skipped++;
        }
    }

    if (deployed > 0) {
        console.log(`[RVPlugin] Synced MediaVault plugin to ${deployed} RV installation(s)`);
    } else if (targets.length > 0) {
        console.log('[RVPlugin] MediaVault plugin already up to date');
    } else {
        console.log('[RVPlugin] No RV installations found — plugin will deploy when RV is installed');
    }
}

module.exports = { sync, findRVPackageDirs, buildRvpkg };
