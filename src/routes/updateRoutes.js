/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault — Update Routes
 * Check for updates from GitHub stable branch, apply via git pull.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { loadConfig } = require('../database');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const TOOLS_RV = path.join(ROOT, 'tools', 'rv');
const RV_BUILD_FILE = path.join(TOOLS_RV, '.rv_build');
const GITHUB_REPO = 'gregtee2/Comfy-Access-Manager';
const GITHUB_RAW = `https://raw.githubusercontent.com/${GITHUB_REPO}/stable`;
const CHECK_CACHE_MS = 5 * 60 * 1000; // 5-minute cache

let lastCheck = null;
let lastCheckTime = 0;

/**
 * Get GitHub PAT from config.json (for private repo access)
 */
function getGitHubToken() {
    try {
        const config = loadConfig();
        return config.github_pat || '';
    } catch {
        return '';
    }
}

/**
 * Build fetch headers — adds Authorization if PAT is configured
 */
function githubHeaders() {
    const token = getGitHubToken();
    if (token) {
        return { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3.raw' };
    }
    return {};
}

/**
 * Fetch remote package.json version from GitHub stable branch
 */
async function fetchRemoteVersion() {
    const now = Date.now();
    if (lastCheck && (now - lastCheckTime) < CHECK_CACHE_MS) {
        return lastCheck;
    }

    try {
        const headers = githubHeaders();
        const res = await fetch(`${GITHUB_RAW}/package.json?_=${now}`, { headers });
        if (!res.ok) {
            if (res.status === 404 || res.status === 401 || res.status === 403) {
                throw new Error(`GitHub responded ${res.status} — repo may be private. Configure a GitHub PAT in Settings.`);
            }
            throw new Error(`GitHub responded ${res.status}`);
        }
        const remote = await res.json();

        // Also try to fetch CHANGELOG
        let changelog = '';
        try {
            const clRes = await fetch(`${GITHUB_RAW}/CHANGELOG.md?_=${now}`, { headers });
            if (clRes.ok) changelog = await clRes.text();
        } catch { /* changelog is optional */ }

        const localVersion = require('../../package.json').version;
        const hasUpdate = compareVersions(remote.version, localVersion) > 0;

        lastCheck = {
            currentVersion: localVersion,
            remoteVersion: remote.version,
            hasUpdate,
            changelog: hasUpdate ? extractChangelog(changelog, localVersion, remote.version) : '',
            checkedAt: new Date().toISOString()
        };
        lastCheckTime = now;
        return lastCheck;
    } catch (err) {
        console.error('[Update] Check failed:', err.message);
        const localVersion = require('../../package.json').version;
        return {
            currentVersion: localVersion,
            remoteVersion: null,
            hasUpdate: false,
            error: err.message,
            checkedAt: new Date().toISOString()
        };
    }
}

/**
 * Compare semver strings: returns >0 if a > b, 0 if equal, <0 if a < b
 */
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Extract changelog entries between two versions
 */
function extractChangelog(fullChangelog, fromVersion, toVersion) {
    if (!fullChangelog) return '';
    const lines = fullChangelog.split('\n');
    const result = [];
    let capturing = false;

    for (const line of lines) {
        // Match markdown headers like ## [1.2.0] or ## 1.2.0
        const versionMatch = line.match(/^##\s+\[?(\d+\.\d+\.\d+)/);
        if (versionMatch) {
            const v = versionMatch[1];
            if (compareVersions(v, fromVersion) <= 0) break; // stop at current version
            capturing = true;
        }
        if (capturing) result.push(line);
    }
    return result.join('\n').trim();
}

// ─── RV Binary Update ───

/**
 * RV download URLs by platform.
 * Tag is rv-3.1.0; filenames match install.sh / install.bat.
 */
const RV_RELEASE_TAG = 'rv-3.1.0';
const RV_URLS = {
    darwin_arm64: `https://github.com/${GITHUB_REPO}/releases/download/${RV_RELEASE_TAG}/OpenRV-3.1.0-macos-arm64-mediavault.zip`,
    win32_x64:   `https://github.com/${GITHUB_REPO}/releases/download/${RV_RELEASE_TAG}/OpenRV-3.1.0-win64-mediavault.zip`
};

/**
 * Get the locally installed RV build stamp, or null if none.
 */
function getLocalRvBuild() {
    try { return fs.readFileSync(RV_BUILD_FILE, 'utf8').trim(); } catch { return null; }
}

/**
 * Check whether the RV binary needs updating after a code pull.
 * Compares package.json rv_build vs tools/rv/.rv_build.
 * Returns the new rv_build string if an update is needed, else null.
 */
function rvNeedsUpdate() {
    try {
        // Re-read package.json fresh (cache already cleared by caller)
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const wanted = pkg.rv_build;
        if (!wanted) return null;                // rv_build not in package.json — skip
        const local = getLocalRvBuild();
        if (local === wanted) return null;       // already current
        return wanted;
    } catch { return null; }
}

/**
 * Download and extract the RV binary for the current platform.
 * Uses the user's GitHub PAT if configured (for private repos).
 * Returns { success, message }.
 */
async function updateRvBinary(newBuild) {
    const platform = process.platform;           // 'darwin' or 'win32'
    const arch = process.arch;                   // 'arm64' or 'x64'
    const key = `${platform}_${arch}`;
    const url = RV_URLS[key];

    if (!url) {
        console.log(`[RV-Update] No pre-built RV for ${key} — skipping.`);
        return { success: false, message: `No RV binary available for ${key}` };
    }

    console.log(`[RV-Update] Updating RV binary (${getLocalRvBuild() || 'none'} → ${newBuild})...`);

    const zipPath = path.join(ROOT, 'tools', 'rv.zip');
    try {
        // Build auth header for the GitHub release asset
        const token = getGitHubToken();
        const headers = token
            ? { 'Authorization': `token ${token}`, 'Accept': 'application/octet-stream' }
            : {};

        // Download
        console.log(`[RV-Update] Downloading from ${url} ...`);
        const res = await fetch(url, { headers, redirect: 'follow' });
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

        const arrayBuf = await res.arrayBuffer();
        fs.writeFileSync(zipPath, Buffer.from(arrayBuf));
        console.log(`[RV-Update] Downloaded ${(arrayBuf.byteLength / 1048576).toFixed(1)} MB`);

        // Remove old RV directory
        if (fs.existsSync(TOOLS_RV)) {
            fs.rmSync(TOOLS_RV, { recursive: true, force: true });
        }
        fs.mkdirSync(TOOLS_RV, { recursive: true });

        // Extract — platform-specific
        if (platform === 'darwin') {
            execSync(`ditto -x -k "${zipPath}" "${TOOLS_RV}"`, { stdio: 'pipe', timeout: 120000 });
            // Remove macOS quarantine
            try { execSync(`xattr -cr "${TOOLS_RV}/RV.app"`, { stdio: 'pipe' }); } catch {}
        } else {
            // Windows: use tar (handles long paths better than Expand-Archive)
            execSync(`tar -xf "${zipPath}" -C "${TOOLS_RV}"`, { stdio: 'pipe', timeout: 120000 });
        }

        // Clean up zip
        try { fs.unlinkSync(zipPath); } catch {}

        // Write build stamp
        fs.writeFileSync(RV_BUILD_FILE, newBuild, 'utf8');

        console.log(`[RV-Update] RV binary updated to build ${newBuild}`);
        return { success: true, message: `RV updated to build ${newBuild}` };

    } catch (err) {
        console.error('[RV-Update] Failed:', err.message);
        try { fs.unlinkSync(zipPath); } catch {}
        return { success: false, message: err.message };
    }
}

// ─── GET /api/update/check ───
router.get('/check', async (req, res) => {
    if (req.query.force) {
        lastCheck = null;
        lastCheckTime = 0;
    }
    const result = await fetchRemoteVersion();
    res.json(result);
});

// ─── GET /api/update/version ───
router.get('/version', (req, res) => {
    res.json({
        version: require('../../package.json').version
    });
});

// ─── POST /api/update/apply ───
router.post('/apply', async (req, res) => {
    try {
        // 1. Stash any local changes
        try {
            execSync('git stash', { cwd: ROOT, stdio: 'pipe' });
        } catch { /* no changes to stash */ }

        // 2. Configure git remote with PAT if available (for private repos)
        const token = getGitHubToken();
        if (token) {
            const authUrl = `https://${token}@github.com/${GITHUB_REPO}.git`;
            try {
                execSync(`git remote set-url origin ${authUrl}`, { cwd: ROOT, stdio: 'pipe' });
            } catch (e) {
                console.warn('[Update] Could not set authenticated remote:', e.message);
            }
        }

        // 3. Fetch + reset to stable
        execSync('git fetch origin stable', { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
        execSync('git reset --hard origin/stable', { cwd: ROOT, stdio: 'pipe' });

        // 4. Restore remote URL to HTTPS (strip token from persisted git config)
        try {
            execSync(`git remote set-url origin https://github.com/${GITHUB_REPO}.git`, { cwd: ROOT, stdio: 'pipe' });
        } catch { /* non-critical */ }

        // 5. Install any new dependencies
        execSync('npm install --omit=dev', { cwd: ROOT, stdio: 'pipe', timeout: 120000 });

        // 6. Rebuild obfuscated frontend bundle for production users
        try {
            execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
            console.log('[Update] ✅ Frontend build complete');
        } catch (buildErr) {
            console.warn('[Update] ⚠️ Frontend build skipped:', buildErr.message);
        }

        // Clear version cache
        delete require.cache[require.resolve('../../package.json')];
        lastCheck = null;
        lastCheckTime = 0;

        const newVersion = require('../../package.json').version;

        // 6. Check if RV binary needs updating (rv_build changed)
        let rvMessage = '';
        const newRvBuild = rvNeedsUpdate();
        if (newRvBuild) {
            const rvResult = await updateRvBinary(newRvBuild);
            rvMessage = rvResult.success
                ? ` RV viewer also updated.`
                : ` (RV update skipped: ${rvResult.message})`;
        }

        res.json({
            success: true,
            version: newVersion,
            message: `Updated to v${newVersion}.${rvMessage} Restarting server...`
        });

        // 4. Restart the server after response is sent
        setTimeout(() => {
            console.log('[Update] Restarting server after update...');
            // Spawn a new process and exit this one
            const child = spawn(process.argv[0], process.argv.slice(1), {
                cwd: ROOT,
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            process.exit(0);
        }, 1500);

    } catch (err) {
        console.error('[Update] Apply failed:', err.message);
        // Try to pop stash on failure
        try { execSync('git stash pop', { cwd: ROOT, stdio: 'pipe' }); } catch {}
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/update/health ───
// Used by frontend to detect when server has restarted after update
router.get('/health', (req, res) => {
    res.json({ ok: true, version: require('../../package.json').version });
});

// ─── Startup: ensure .rv_build stamp exists if RV is already installed ───
(function ensureRvBuildStamp() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const wanted = pkg.rv_build;
        if (!wanted) return;

        // Check if RV binary exists
        const rvBinMac = path.join(TOOLS_RV, 'RV.app', 'Contents', 'MacOS', 'RV');
        const rvBinWin = path.join(TOOLS_RV, 'bin', 'rv.exe');
        const rvExists = fs.existsSync(rvBinMac) || fs.existsSync(rvBinWin);
        if (!rvExists) return;

        // If stamp is missing or outdated, write it (assumes current install matches)
        const local = getLocalRvBuild();
        if (!local) {
            fs.mkdirSync(TOOLS_RV, { recursive: true });
            fs.writeFileSync(RV_BUILD_FILE, wanted, 'utf8');
            console.log(`[RV-Update] Wrote initial .rv_build stamp: ${wanted}`);
        }
    } catch {}
})();

module.exports = router;
