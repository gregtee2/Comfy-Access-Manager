/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
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

const ROOT = path.join(__dirname, '..', '..');
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

        // Clear version cache
        delete require.cache[require.resolve('../../package.json')];
        lastCheck = null;
        lastCheckTime = 0;

        const newVersion = require('../../package.json').version;

        res.json({
            success: true,
            version: newVersion,
            message: `Updated to v${newVersion}. Restarting server...`
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

module.exports = router;
