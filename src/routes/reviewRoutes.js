/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * reviewRoutes — API for RV Sync Review Sessions
 *
 * Enables multi-user synchronized review via RV's built-in network sync.
 * One user "hosts" a review session (RV with -networkPort), and others
 * "join" (RV with -networkConnect). CAM orchestrates the discovery and
 * connection so users don't need to exchange IPs/ports manually.
 *
 * Flow:
 *   1. User clicks "Start Sync Review" on asset(s)
 *   2. CAM launches RV with `-networkPort <port>` locally
 *   3. Session is registered on hub DB, SSE broadcast to all spokes
 *   4. Other users see "Active Review" notification, click "Join"
 *   5. CAM launches their local RV with `-networkConnect <hostIp> <port>`
 *   6. When host closes session, hub DB updated, SSE broadcast sent
 *
 * RV handles all playback sync, annotations, scrubbing, etc. natively.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { getDb, getSetting, logActivity } = require('../database');
const { resolveFilePath } = require('../utils/pathResolver');

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════

/**
 * Get this machine's LAN IP address (for RV network sync).
 * Prefers en0/eth0 IPv4 addresses; falls back to first non-internal IPv4.
 */
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    // Prefer common interface names
    for (const name of ['en0', 'eth0', 'en1', 'Ethernet', 'Wi-Fi']) {
        const iface = interfaces[name];
        if (iface) {
            const v4 = iface.find(a => a.family === 'IPv4' && !a.internal);
            if (v4) return v4.address;
        }
    }
    // Fallback: first non-internal IPv4
    for (const iface of Object.values(interfaces)) {
        const v4 = iface.find(a => a.family === 'IPv4' && !a.internal);
        if (v4) return v4.address;
    }
    return '127.0.0.1';
}

/**
 * Find the RV executable (reuse logic from assetRoutes).
 * We import lazily to avoid circular dependency issues.
 */
function findRV() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // 1. User-configured path
    try {
        const customPath = getSetting('rv_path');
        if (customPath && fs.existsSync(customPath)) return customPath;
    } catch (e) { /* settings not ready */ }

    // 2. Bundled RV
    if (isMac) {
        const bundledMac = path.join(__dirname, '..', '..', 'tools', 'rv', 'RV.app', 'Contents', 'MacOS', 'RV');
        if (fs.existsSync(bundledMac)) return bundledMac;
    }
    const bundled = path.join(__dirname, '..', '..', 'tools', 'rv', 'bin', isWin ? 'rv.exe' : 'rv');
    if (fs.existsSync(bundled)) return bundled;

    // 3. Standard locations
    if (isWin) {
        const searchDirs = ['C:\\Program Files', 'C:\\Program Files (x86)'];
        const prefixes = ['Autodesk\\RV', 'Shotgun\\RV', 'ShotGrid\\RV', 'Shotgun RV', 'RV'];
        for (const base of searchDirs) {
            for (const prefix of prefixes) {
                const exe = path.join(base, prefix, 'bin', 'rv.exe');
                if (fs.existsSync(exe)) return exe;
            }
            try {
                const autodesk = path.join(base, 'Autodesk');
                if (fs.existsSync(autodesk)) {
                    for (const d of fs.readdirSync(autodesk).filter(d => d.startsWith('RV'))) {
                        const exe = path.join(autodesk, d, 'bin', 'rv.exe');
                        if (fs.existsSync(exe)) return exe;
                    }
                }
            } catch (e) { /* ignore */ }
        }
        // OpenRV local build
        const openrvBuild = 'C:\\OpenRV\\_build\\stage\\app\\bin\\rv.exe';
        if (fs.existsSync(openrvBuild)) return openrvBuild;
    } else if (isMac) {
        // Check OpenRV local builds FIRST (they tend to be newer/working)
        const homedir = os.homedir();
        const macBuilds = [
            path.join(homedir, 'OpenRV', '_build', 'stage', 'app', 'RV.app', 'Contents', 'MacOS', 'RV'),
            path.join(homedir, 'OpenRV', '_install', 'RV.app', 'Contents', 'MacOS', 'RV'),
        ];
        for (const p of macBuilds) { if (fs.existsSync(p)) return p; }
        // Standard install locations
        const candidates = [
            '/Applications/RV.app/Contents/MacOS/RV',
            '/Applications/Autodesk/RV.app/Contents/MacOS/RV',
        ];
        for (const c of candidates) { if (fs.existsSync(c)) return c; }
        try {
            for (const d of fs.readdirSync('/Applications').filter(d => d.startsWith('RV') && d.endsWith('.app'))) {
                const exe = path.join('/Applications', d, 'Contents', 'MacOS', 'RV');
                if (fs.existsSync(exe)) return exe;
            }
        } catch (e) { /* ignore */ }
    } else {
        const candidates = ['/usr/local/rv/bin/rv', '/opt/rv/bin/rv', '/usr/local/bin/rv', '/usr/bin/rv'];
        for (const c of candidates) { if (fs.existsSync(c)) return c; }
    }
    return null;
}

/**
 * Resolve asset IDs to file paths for RV.
 */
function resolveAssetPaths(assetIds) {
    const db = getDb();
    const filePaths = [];
    // Ensure assetIds is always an array (guard against JSON parse returning a scalar)
    const ids = Array.isArray(assetIds) ? assetIds : (assetIds ? [assetIds] : []);
    for (const id of ids) {
        const asset = db.prepare(
            'SELECT file_path, is_sequence, frame_pattern, frame_start, frame_end FROM assets WHERE id = ?'
        ).get(id);
        if (!asset || !asset.file_path) continue;

        const resolved = resolveFilePath(asset.file_path);
        if (!resolved) continue;

        if (asset.is_sequence && asset.frame_pattern && asset.frame_start != null && asset.frame_end != null) {
            // Build RV sequence notation: /path/render.1001-1100####.exr
            const dir = path.dirname(resolved);
            const padMatch = asset.frame_pattern.match(/%0(\d+)d/);
            const digits = padMatch ? parseInt(padMatch[1], 10) : 4;
            const hashes = '#'.repeat(digits);
            const rvPattern = asset.frame_pattern.replace(/%0\d+d/, `${asset.frame_start}-${asset.frame_end}${hashes}`);
            filePaths.push(path.join(dir, rvPattern));
        } else {
            if (fs.existsSync(resolved)) filePaths.push(resolved);
        }
    }
    return filePaths;
}


// ═══════════════════════════════════════════
//  GET /api/review/sessions — List active review sessions
// ═══════════════════════════════════════════
router.get('/sessions', (req, res) => {
    const db = getDb();
    const projectFilter = req.query.project_id ? parseInt(req.query.project_id, 10) : null;

    let sessions;
    if (projectFilter) {
        sessions = db.prepare(
            `SELECT * FROM review_sessions WHERE status = 'active' AND project_id = ? ORDER BY started_at DESC`
        ).all(projectFilter);
    } else {
        sessions = db.prepare(
            `SELECT * FROM review_sessions WHERE status = 'active' ORDER BY started_at DESC`
        ).all();
    }

    // Enrich sessions with project name and asset details
    const localIp = getLocalIP();
    for (const s of sessions) {
        // Parse asset_ids JSON (guard against scalars from malformed DB entries)
        try {
            const parsed = JSON.parse(s.asset_ids || '[]');
            s.asset_ids = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        } catch { s.asset_ids = []; }

        // Add project name
        if (s.project_id) {
            try {
                const proj = db.prepare('SELECT name, code FROM projects WHERE id = ?').get(s.project_id);
                s.project_name = proj ? proj.name : null;
                s.project_code = proj ? proj.code : null;
            } catch { /* non-critical */ }
        }

        // Add asset summaries (name + type) for display
        if (s.asset_ids.length > 0) {
            try {
                const placeholders = s.asset_ids.map(() => '?').join(',');
                s.assets = db.prepare(
                    `SELECT id, vault_name, media_type FROM assets WHERE id IN (${placeholders})`
                ).all(...s.asset_ids);
            } catch { s.assets = []; }
        } else {
            s.assets = [];
        }

        // Mark whether this machine is the session host (for End vs Leave UI)
        s.is_owner = (s.host_ip === localIp);
    }

    res.json({ sessions });
});

// ═══════════════════════════════════════════
//  GET /api/review/sessions/:id — Get a single session
// ═══════════════════════════════════════════
router.get('/sessions/:id', (req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    try { session.asset_ids = JSON.parse(session.asset_ids || '[]'); } catch { session.asset_ids = []; }

    // Include asset details for display
    if (session.asset_ids.length > 0) {
        const placeholders = session.asset_ids.map(() => '?').join(',');
        session.assets = db.prepare(
            `SELECT id, vault_name, file_path, media_type, thumbnail_path FROM assets WHERE id IN (${placeholders})`
        ).all(...session.asset_ids);
    } else {
        session.assets = [];
    }

    res.json(session);
});


// ═══════════════════════════════════════════
//  POST /api/review/start — Start a sync review (host side)
//  Body: { assetIds: [1,2,...], title?: string, port?: number }
//
//  This endpoint:
//    1. Launches RV locally with -networkPort <port>
//    2. Registers the session in the DB
//    3. Broadcasts SSE event so other users see it
// ═══════════════════════════════════════════
router.post('/start', (req, res) => {
    const { assetIds, title, port } = req.body || {};

    if (!assetIds || !Array.isArray(assetIds) || assetIds.length === 0) {
        return res.status(400).json({ error: 'Provide an array of assetIds' });
    }

    const rvExe = findRV();
    if (!rvExe) {
        return res.status(404).json({ error: 'RV not found on this machine' });
    }

    const networkPort = port || 45128;
    const hostIp = getLocalIP();
    const sessionKey = crypto.randomUUID();
    const hostName = os.hostname();
    const db = getDb();

    // Auto-end any existing active sessions from this host (prevents duplicates)
    // First, find them so we can broadcast the status change to spokes
    const staleSessions = db.prepare(`SELECT * FROM review_sessions WHERE status = 'active' AND host_ip = ?`).all(hostIp);
    if (staleSessions.length > 0) {
        db.prepare(`UPDATE review_sessions SET status = 'ended', ended_at = datetime('now') WHERE status = 'active' AND host_ip = ?`)
            .run(hostIp);
        for (const s of staleSessions) {
            const ended = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(s.id);
            req.app.locals.broadcastChange?.('review_sessions', 'update', { record: ended });
        }
        console.log(`[SyncReview] Auto-ended ${staleSessions.length} stale session(s) from ${hostIp}`);
    }

    // Resolve asset file paths for RV
    const filePaths = resolveAssetPaths(assetIds);
    if (filePaths.length === 0) {
        return res.status(400).json({ error: 'No resolvable files found for the given assets' });
    }

    // Get user info
    const userName = req.headers['x-cam-user'] || 'Unknown';

    // Determine project context from the assets being reviewed
    let projectId = null;
    let projectName = null;
    try {
        const firstAsset = db.prepare('SELECT project_id FROM assets WHERE id = ?').get(assetIds[0]);
        if (firstAsset && firstAsset.project_id) {
            projectId = firstAsset.project_id;
            const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
            if (proj) projectName = proj.name;
        }
    } catch (e) { /* non-critical */ }

    // Launch RV with network sync enabled (as host)
    try {
        launchRVAsHost(rvExe, filePaths, networkPort);
    } catch (err) {
        return res.status(500).json({ error: `Failed to launch RV: ${err.message}` });
    }

    // Register session in DB
    const sessionTitle = title || `Review by ${userName}`;
    const result = db.prepare(`
        INSERT INTO review_sessions (session_key, host_name, host_ip, host_port, status, asset_ids, title, started_by, project_id)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(sessionKey, hostName, hostIp, networkPort, JSON.stringify(assetIds), sessionTitle, userName, projectId);

    const sessionId = Number(result.lastInsertRowid);

    logActivity('review_start', 'review_session', sessionId,
        `Sync review started: ${sessionTitle} (${assetIds.length} assets)`);

    // Broadcast to spokes via SSE (hub mode)
    // Keep asset_ids as a JSON string so spoke's _applyChange stores it correctly in SQLite
    const session = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(sessionId);

    req.app.locals.broadcastChange?.('review_sessions', 'insert', { record: session });

    // In spoke mode, also register the session on the hub DB so other spokes can see it
    const spokeService = req.app.locals.spokeService;
    if (spokeService) {
        spokeService.forwardRequest('POST', '/api/sync/write', {
            method: 'POST',
            path: '/api/review/hub-register',
            body: {
                session_key: sessionKey,
                host_name: hostName,
                host_ip: hostIp,
                host_port: networkPort,
                asset_ids: assetIds,
                title: sessionTitle,
                started_by: userName,
                project_id: projectId,
            },
            spokeName: spokeService.localName,
        }).then(() => {
            console.log(`[SyncReview] Session registered on hub: ${sessionTitle}`);
        }).catch(err => {
            console.error(`[SyncReview] Failed to register session on hub:`, err.message);
        });
    }

    res.json({
        success: true,
        session: {
            id: sessionId,
            sessionKey,
            hostIp,
            hostPort: networkPort,
            title: sessionTitle,
            assetCount: filePaths.length,
        }
    });
});


// ═══════════════════════════════════════════
//  POST /api/review/join — Join an existing review (client side)
//  Body: { sessionId: number }
//
//  Launches local RV with -networkConnect <hostIp> <port>
// ═══════════════════════════════════════════
router.post('/join', (req, res) => {
    const { sessionId } = req.body || {};

    if (!sessionId) {
        return res.status(400).json({ error: 'Provide a sessionId' });
    }

    const db = getDb();
    const session = db.prepare(
        `SELECT * FROM review_sessions WHERE id = ? AND status = 'active'`
    ).get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found or no longer active' });
    }

    const rvExe = findRV();
    if (!rvExe) {
        return res.status(404).json({ error: 'RV not found on this machine' });
    }

    // Resolve files locally (may differ from host due to path mappings)
    let assetIds = [];
    try {
        const parsed = JSON.parse(session.asset_ids || '[]');
        assetIds = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch { /* empty */ }
    const filePaths = resolveAssetPaths(assetIds);

    // Launch RV as sync client — it will connect to the host's session
    try {
        launchRVAsClient(rvExe, session.host_ip, session.host_port, filePaths);
    } catch (err) {
        return res.status(500).json({ error: `Failed to launch RV: ${err.message}` });
    }

    const userName = req.headers['x-cam-user'] || 'Unknown';
    logActivity('review_join', 'review_session', session.id,
        `${userName} joined sync review: ${session.title}`);

    res.json({
        success: true,
        message: `Joined review "${session.title}" — connecting to ${session.host_ip}:${session.host_port}`,
    });
});


// ═══════════════════════════════════════════
//  POST /api/review/leave — Leave a review session (client side)
//  Kills the local RV sync process without ending the session.
//  Body: { sessionId: number }
// ═══════════════════════════════════════════
router.post('/leave', (req, res) => {
    const { sessionId } = req.body || {};

    if (!sessionId) {
        return res.status(400).json({ error: 'Provide a sessionId' });
    }

    const db = getDb();
    const session = db.prepare(
        `SELECT * FROM review_sessions WHERE id = ? AND status = 'active'`
    ).get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found or no longer active' });
    }

    // Kill local RV process (client mode) — the session stays active for others
    killExistingRVSync();

    const userName = req.headers['x-cam-user'] || 'Unknown';
    logActivity('review_leave', 'review_session', session.id,
        `${userName} left sync review: ${session.title}`);

    res.json({
        success: true,
        message: `Left review "${session.title}" — your RV has been disconnected`,
    });
});


// ═══════════════════════════════════════════
//  POST /api/review/end — End a review session (host only)
//  Body: { sessionId: number }
//  Only the machine that started the session can end it.
// ═══════════════════════════════════════════
router.post('/end', (req, res) => {
    const { sessionId } = req.body || {};

    if (!sessionId) {
        return res.status(400).json({ error: 'Provide a sessionId' });
    }

    const db = getDb();
    const session = db.prepare(
        `SELECT * FROM review_sessions WHERE id = ? AND status = 'active'`
    ).get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found or already ended' });
    }

    // Only the originating machine can end the session
    const localIp = getLocalIP();
    if (session.host_ip !== localIp) {
        return res.status(403).json({
            error: 'Only the session host can end this review. Use "Leave" to disconnect.',
        });
    }

    db.prepare(`UPDATE review_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`)
        .run(sessionId);

    logActivity('review_end', 'review_session', sessionId,
        `Sync review ended: ${session.title}`);

    // Broadcast session end to all spokes
    // Keep asset_ids as a JSON string so spoke's _applyChange stores it correctly in SQLite
    const updated = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(sessionId);

    req.app.locals.broadcastChange?.('review_sessions', 'update', { record: updated });

    // In spoke mode, also update the hub DB
    const spokeService = req.app.locals.spokeService;
    if (spokeService) {
        spokeService.forwardRequest('POST', '/api/sync/write', {
            method: 'POST',
            path: '/api/review/hub-end',
            body: { session_key: session.session_key },
            spokeName: spokeService.localName,
        }).then(() => {
            console.log(`[SyncReview] Session end forwarded to hub`);
        }).catch(err => {
            console.error(`[SyncReview] Failed to end session on hub:`, err.message);
        });
    }

    res.json({ success: true, message: 'Review session ended' });
});


// ═══════════════════════════════════════════
//  RV LAUNCH HELPERS
// ═══════════════════════════════════════════

/**
 * Build environment variables for RV cross-platform path remapping.
 * Uses RV's built-in RV_OS_PATH_WINDOWS_<N> / RV_OS_PATH_OSX_<N> mechanism.
 * When RV receives a synced session from another OS, it swaps the path prefix
 * from the sender's OS to the local OS automatically.
 *
 * Reads CAM's path_mappings setting: [{"windows":"Z:\\","mac":"/Volumes/home/AI Projects"}]
 */
function buildRVPathSwapEnv() {
    const envVars = {};   // Only the RV_OS_PATH vars (for --env flags)
    const fullEnv = { ...process.env };  // Full env (for spawn on Win/Linux)
    try {
        const raw = getSetting('path_mappings');
        if (!raw) return { envVars, fullEnv };
        const mappings = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(mappings)) return { envVars, fullEnv };

        mappings.forEach((m, i) => {
            const winPath = m.windows || m.win;
            const macPath = m.mac || m.osx;
            if (!winPath || !macPath) return;

            // RV uses forward slashes internally; strip trailing separators
            const winClean = winPath.replace(/\\/g, '/').replace(/\/$/, '');
            const macClean = macPath.replace(/\/$/, '');

            // --- RV_OS_PATH: used by mapFromVar (receiving side) ---
            const winKey = `RV_OS_PATH_WINDOWS_${i}`;
            const osxKey = `RV_OS_PATH_OSX_${i}`;
            envVars[winKey] = winClean;
            envVars[osxKey] = macClean;
            fullEnv[winKey] = winClean;
            fullEnv[osxKey] = macClean;

            // --- RV_PATHSWAP: used by mapToVar (sending side) ---
            // Each machine sets the PATHSWAP var to its OWN local path.
            // When sending: mapToVar("Z:/foo") → "${RV_PATHSWAP_CAM_0}/foo"
            // When receiving: mapFromVar("${RV_PATHSWAP_CAM_0}/foo") → "/Volumes/.../foo"
            const swapKey = `RV_PATHSWAP_CAM_${i}`;
            const localRoot = process.platform === 'win32' ? winClean : macClean;
            envVars[swapKey] = localRoot;
            fullEnv[swapKey] = localRoot;

            console.log(`[RV Sync] Path swap env: ${winKey}=${winClean} ↔ ${osxKey}=${macClean} | ${swapKey}=${localRoot}`);
        });
    } catch (err) {
        console.error('[RV Sync] Failed to build path swap env:', err.message);
    }
    return { envVars, fullEnv };
}

/**
 * Kill any existing RV sync processes before launching a new one.
 * Prevents "already connected" errors when the remote host still has
 * a stale connection from a previously killed RV instance.
 * Sends SIGTERM so RV can gracefully close TCP sockets (sends FIN to peers).
 */
function killExistingRVSync() {
    const { execSync } = require('child_process');
    try {
        if (process.platform === 'darwin') {
            // Kill RV processes launched with -network args (sync sessions only)
            execSync("pkill -f 'MacOS/RV.*-network' 2>/dev/null || true", { timeout: 5000 });
        } else if (process.platform === 'win32') {
            // On Windows, kill rv.exe instances with -network in command line
            execSync('wmic process where "name=\'rv.exe\' and commandline like \'%-network%\'" call terminate 2>NUL || exit /b 0', { timeout: 5000 });
        } else {
            execSync("pkill -f 'rv.*-network' 2>/dev/null || true", { timeout: 5000 });
        }
        // Brief pause to let TCP FIN propagate to peers and ports release
        const waitUntil = Date.now() + 1500;
        while (Date.now() < waitUntil) { /* sync wait */ }
        console.log('[RV Sync] Killed existing RV sync process(es)');
    } catch (err) {
        // Non-fatal: no existing RV to kill, or kill failed
        console.log('[RV Sync] No existing RV sync processes to kill');
    }
}

/**
 * Launch RV as the sync host (other RVs will connect to this one).
 * Uses `-networkPort` to open a sync server.
 */
function launchRVAsHost(rvExe, filePaths, networkPort) {
    killExistingRVSync();
    const { execFile, spawn } = require('child_process');
    const rvArgs = ['-network', '-networkPort', String(networkPort), ...filePaths];
    const { envVars, fullEnv } = buildRVPathSwapEnv();

    if (process.platform === 'darwin') {
        // macOS: RV needs app-bundle context to run properly.
        // Use `open -n -a <bundle> --args ...` — the -n flag forces a new instance
        // and reliably passes all arguments (unlike plain `open -a`).
        // IMPORTANT: macOS `open` uses LaunchServices which does NOT inherit
        // the caller's env vars. Use `open --env KEY=VALUE` to inject them.
        let appBundle = null;
        let dir = rvExe;
        for (let i = 0; i < 5; i++) {
            dir = path.dirname(dir);
            if (dir.endsWith('.app')) { appBundle = dir; break; }
        }
        if (appBundle) {
            // Build: open --env K1=V1 --env K2=V2 -n -a <bundle> --args ...
            const args = [];
            for (const [k, v] of Object.entries(envVars)) {
                args.push('--env', `${k}=${v}`);
            }
            args.push('-n', '-a', appBundle, '--args', ...rvArgs);
            execFile('/usr/bin/open', args, (err) => {
                if (err) console.error(`[RV Sync Host] open error:`, err.message);
            });
            console.log(`[RV Sync] Host launched via 'open -n -a' (macOS), port ${networkPort}, ${filePaths.length} file(s), ${Object.keys(envVars).length} path swap vars`);
            return;
        }
    }

    // Windows / Linux or fallback
    const child = spawn(rvExe, rvArgs, {
        cwd: path.dirname(rvExe),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        env: fullEnv,
    });

    child.stdout.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.log(`[RV Sync Host] stdout: ${msg.substring(0, 300)}`);
    });
    child.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.error(`[RV Sync Host] stderr: ${msg.substring(0, 300)}`);
    });
    child.on('error', err => console.error(`[RV Sync Host] Error: ${err.message}`));
    child.on('exit', (code) => console.log(`[RV Sync Host] Exited (code=${code})`));
    child.unref();

    console.log(`[RV Sync] Host launched, port ${networkPort}, PID=${child.pid}, ${filePaths.length} file(s)`);
}

/**
 * Launch RV as a sync client (connects to an existing host session).
 * Uses `-networkConnect <ip> <port>` to join the host.
 * Also loads the same media files locally (RV sync shares state, not pixels).
 */
function launchRVAsClient(rvExe, hostIp, hostPort, filePaths) {
    killExistingRVSync();
    const { execFile, spawn } = require('child_process');
    const rvArgs = ['-network', '-networkConnect', hostIp, String(hostPort), ...filePaths];
    const { envVars, fullEnv } = buildRVPathSwapEnv();

    if (process.platform === 'darwin') {
        // macOS: RV needs app-bundle context to run properly.
        // Use `open -n -a <bundle> --args ...` — the -n flag forces a new instance
        // and reliably passes all arguments (unlike plain `open -a`).
        // IMPORTANT: macOS `open` uses LaunchServices which does NOT inherit
        // the caller's env vars. Use `open --env KEY=VALUE` to inject them.
        let appBundle = null;
        let dir = rvExe;
        for (let i = 0; i < 5; i++) {
            dir = path.dirname(dir);
            if (dir.endsWith('.app')) { appBundle = dir; break; }
        }
        if (appBundle) {
            // Build: open --env K1=V1 --env K2=V2 -n -a <bundle> --args ...
            const args = [];
            for (const [k, v] of Object.entries(envVars)) {
                args.push('--env', `${k}=${v}`);
            }
            args.push('-n', '-a', appBundle, '--args', ...rvArgs);
            execFile('/usr/bin/open', args, (err) => {
                if (err) console.error(`[RV Sync Client] open error:`, err.message);
            });
            console.log(`[RV Sync] Client launched via 'open -n -a' (macOS), connecting to ${hostIp}:${hostPort}, ${Object.keys(envVars).length} path swap vars`);
            return;
        }
    }

    // Windows / Linux or fallback
    const child = spawn(rvExe, rvArgs, {
        cwd: path.dirname(rvExe),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        env: fullEnv,
    });

    child.stdout.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.log(`[RV Sync Client] stdout: ${msg.substring(0, 300)}`);
    });
    child.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.error(`[RV Sync Client] stderr: ${msg.substring(0, 300)}`);
    });
    child.on('error', err => console.error(`[RV Sync Client] Error: ${err.message}`));
    child.on('exit', (code) => console.log(`[RV Sync Client] Exited (code=${code})`));
    child.unref();

    console.log(`[RV Sync] Client launched, connecting to ${hostIp}:${hostPort}, PID=${child.pid}`);
}


// ═══════════════════════════════════════════
//  REVIEW NOTES — Frame-accurate annotations
// ═══════════════════════════════════════════

/**
 * GET /api/review/notes/:sessionId — Get all notes for a review session.
 * Works for both active and ended sessions (enables later review).
 * Query params: ?asset_id=N (optional filter to specific asset)
 */
router.get('/notes/:sessionId', (req, res) => {
    const db = getDb();
    const sessionId = parseInt(req.params.sessionId, 10);

    const session = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const assetFilter = req.query.asset_id ? parseInt(req.query.asset_id, 10) : null;

    let notes;
    if (assetFilter) {
        notes = db.prepare(
            `SELECT * FROM review_notes WHERE session_id = ? AND asset_id = ? ORDER BY frame_number ASC, created_at ASC`
        ).all(sessionId, assetFilter);
    } else {
        notes = db.prepare(
            `SELECT * FROM review_notes WHERE session_id = ? ORDER BY asset_id, frame_number ASC, created_at ASC`
        ).all(sessionId);
    }

    // Enrich notes with asset name
    for (const note of notes) {
        if (note.asset_id) {
            try {
                const asset = db.prepare('SELECT vault_name, media_type FROM assets WHERE id = ?').get(note.asset_id);
                note.asset_name = asset ? asset.vault_name : null;
                note.media_type = asset ? asset.media_type : null;
            } catch { /* non-critical */ }
        }
    }

    res.json({ notes, session_title: session.title, session_status: session.status });
});

/**
 * POST /api/review/notes — Add a note to a review session.
 * Body: { sessionId, assetId?, frameNumber?, timecode?, noteText }
 */
router.post('/notes', (req, res) => {
    const { sessionId, assetId, frameNumber, timecode, noteText } = req.body || {};

    if (!sessionId || !noteText || !noteText.trim()) {
        return res.status(400).json({ error: 'Provide sessionId and noteText' });
    }

    const db = getDb();
    const session = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const author = req.headers['x-cam-user'] || 'Unknown';

    const result = db.prepare(`
        INSERT INTO review_notes (session_id, asset_id, frame_number, timecode, note_text, author)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, assetId || null, frameNumber || null, timecode || null, noteText.trim(), author);

    const noteId = Number(result.lastInsertRowid);
    const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(noteId);

    // Enrich with asset name
    if (note.asset_id) {
        try {
            const asset = db.prepare('SELECT vault_name FROM assets WHERE id = ?').get(note.asset_id);
            note.asset_name = asset ? asset.vault_name : null;
        } catch { /* non-critical */ }
    }

    logActivity('review_note_add', 'review_note', noteId,
        `Note added to review "${session.title}": ${noteText.trim().substring(0, 80)}`);

    // Broadcast note to other participants via SSE
    req.app.locals.broadcastChange?.('review_notes', 'insert', { record: note });

    // In spoke mode, also forward to hub
    const spokeService = req.app.locals.spokeService;
    if (spokeService) {
        spokeService.forwardRequest('POST', '/api/sync/write', {
            method: 'POST',
            path: '/api/review/hub-note',
            body: {
                session_key: session.session_key,
                asset_id: assetId || null,
                frame_number: frameNumber || null,
                timecode: timecode || null,
                note_text: noteText.trim(),
                author,
            },
            spokeName: spokeService.localName,
        }).catch(err => {
            console.error('[SyncReview] Failed to forward note to hub:', err.message);
        });
    }

    res.json({ success: true, note });
});

/**
 * POST /api/review/notes/annotated-frame — Save an annotated frame snapshot from RV.
 *
 * Called by the RV plugin when a user captures a frame with annotations/paint-overs.
 * RV uses exportCurrentFrame() to render the composited frame to a temp file,
 * then sends it here. We copy it into data/review-snapshots/ and create a note.
 *
 * Body: { sessionId?, sourcePath?, frameNumber, noteText?, renderedFramePath }
 * - renderedFramePath: absolute path to the temp PNG exported by RV
 * - sourcePath: original media path (used to find the asset_id)
 * - sessionId: if omitted, attaches to the most recent active session
 */
router.post('/notes/annotated-frame', (req, res) => {
    const { sessionId, sourcePath, frameNumber, noteText, renderedFramePath } = req.body || {};

    if (!renderedFramePath) {
        return res.status(400).json({ error: 'renderedFramePath is required' });
    }
    if (frameNumber == null) {
        return res.status(400).json({ error: 'frameNumber is required' });
    }

    // Verify the rendered file exists
    if (!fs.existsSync(renderedFramePath)) {
        return res.status(400).json({ error: 'Rendered frame file not found: ' + renderedFramePath });
    }

    const db = getDb();
    const author = req.headers['x-cam-user'] || 'Unknown';

    // Find the session (explicit or most recent active)
    let session;
    if (sessionId) {
        session = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(sessionId);
    } else {
        // Find the most recent active session on this machine
        const localIp = getLocalIP();
        session = db.prepare(
            `SELECT * FROM review_sessions WHERE status = 'active' AND host_ip = ? ORDER BY started_at DESC LIMIT 1`
        ).get(localIp);
        if (!session) {
            // Try any active session (user might be a client, not the host)
            session = db.prepare(
                `SELECT * FROM review_sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`
            ).get();
        }
    }

    if (!session) {
        return res.status(404).json({ error: 'No active review session found. Start a review first.' });
    }

    // Try to find the asset from sourcePath
    let assetId = null;
    if (sourcePath) {
        try {
            // Normalize paths for cross-platform matching
            const normalizedPath = sourcePath.replace(/\\/g, '/');
            const asset = db.prepare(
                `SELECT id FROM assets WHERE replace(file_path, '\\', '/') = ? LIMIT 1`
            ).get(normalizedPath);
            if (asset) assetId = asset.id;
        } catch { /* non-critical */ }
    }

    // ─── Organize by project code + date ───
    const DATA_DIR = process.env.CAM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
    const snapshotsBase = path.join(DATA_DIR, 'review-snapshots');

    // Determine project code for folder structure
    let projectCode = 'GENERAL';
    if (session.project_id) {
        try {
            const proj = db.prepare('SELECT code, name FROM projects WHERE id = ?').get(session.project_id);
            if (proj) projectCode = (proj.code || proj.name || 'GENERAL').replace(/[^a-zA-Z0-9_-]/g, '_');
        } catch { /* use default */ }
    }

    // Date-based subdirectory (YYYY-MM-DD)
    const today = new Date();
    const dateFolder = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const snapshotsDir = path.join(snapshotsBase, projectCode, dateFolder);
    if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `review_${session.id}_f${frameNumber}_${timestamp}.png`;
    // Relative path includes project/date folders (e.g. COMFYUIT/2026-03-01/review_26_f1042_123.png)
    const relativePath = path.join(projectCode, dateFolder, filename).replace(/\\/g, '/');
    const destPath = path.join(snapshotsDir, filename);

    try {
        fs.copyFileSync(renderedFramePath, destPath);
    } catch (err) {
        console.error('[SyncReview] Failed to copy annotated frame:', err.message);
        return res.status(500).json({ error: 'Failed to save annotated frame' });
    }

    // Create the note with the organized annotation image path
    const text = (noteText && noteText.trim()) || `Annotated frame ${frameNumber}`;
    const annotationImage = relativePath; // e.g. COMFYUIT/2026-03-01/review_26_f1042_123.png

    const result = db.prepare(`
        INSERT INTO review_notes (session_id, asset_id, frame_number, note_text, author, annotation_image)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.id, assetId, frameNumber, text, author, annotationImage);

    const noteId = Number(result.lastInsertRowid);
    const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(noteId);

    // Enrich with asset name
    if (note.asset_id) {
        try {
            const asset = db.prepare('SELECT vault_name FROM assets WHERE id = ?').get(note.asset_id);
            note.asset_name = asset ? asset.vault_name : null;
        } catch { /* non-critical */ }
    }

    logActivity('review_note_annotated', 'review_note', noteId,
        `Annotated frame ${frameNumber} saved to review "${session.title}"`);

    // Broadcast to participants
    req.app.locals.broadcastChange?.('review_notes', 'insert', { record: note });

    // Clean up temp file (RV created it in a temp dir)
    try { fs.unlinkSync(renderedFramePath); } catch { /* already cleaned or still needed */ }

    // In spoke mode, upload the annotation image + note to the hub
    const spokeService = req.app.locals.spokeService;
    if (spokeService) {
        // Read the saved file and base64-encode it for hub upload
        try {
            const imageBuffer = fs.readFileSync(destPath);
            const imageBase64 = imageBuffer.toString('base64');

            spokeService.forwardRequest('POST', '/api/sync/write', {
                method: 'POST',
                path: '/api/review/hub-annotation',
                body: {
                    session_key: session.session_key,
                    asset_id: assetId,
                    frame_number: frameNumber,
                    note_text: text,
                    author,
                    image_base64: imageBase64,
                    project_code: projectCode,
                    filename,
                },
                spokeName: spokeService.localName,
            }).then(() => {
                console.log(`[SyncReview] Annotation image uploaded to hub: ${relativePath}`);
            }).catch(err => {
                console.error('[SyncReview] Failed to upload annotation to hub:', err.message);
            });
        } catch (readErr) {
            console.error('[SyncReview] Failed to read annotation for hub upload:', readErr.message);
            // Still forward just the note text as fallback
            spokeService.forwardRequest('POST', '/api/sync/write', {
                method: 'POST',
                path: '/api/review/hub-note',
                body: {
                    session_key: session.session_key,
                    asset_id: assetId,
                    frame_number: frameNumber,
                    note_text: text + ' [annotation image failed to upload]',
                    author,
                },
                spokeName: spokeService.localName,
            }).catch(() => {});
        }
    }

    console.log(`[SyncReview] Annotated frame saved: ${relativePath} (session ${session.id}, frame ${frameNumber})`);

    res.json({
        success: true,
        note,
        snapshotUrl: `/review-snapshots/${relativePath}`,
    });
});

/**
 * PUT /api/review/notes/:noteId — Update a note (edit text or change status).
 * Body: { noteText?, status? }  (status: 'open', 'resolved', 'wontfix')
 */
router.put('/notes/:noteId', (req, res) => {
    const db = getDb();
    const noteId = parseInt(req.params.noteId, 10);
    const { noteText, status } = req.body || {};

    const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(noteId);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    const updates = [];
    const params = [];

    if (noteText && noteText.trim()) {
        updates.push('note_text = ?');
        params.push(noteText.trim());
    }
    if (status && ['open', 'resolved', 'wontfix'].includes(status)) {
        updates.push('status = ?');
        params.push(status);
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'Provide noteText and/or status to update' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(noteId);

    db.prepare(`UPDATE review_notes SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(noteId);
    req.app.locals.broadcastChange?.('review_notes', 'update', { record: updated });

    res.json({ success: true, note: updated });
});

/**
 * DELETE /api/review/notes/:noteId — Delete a note.
 */
router.delete('/notes/:noteId', (req, res) => {
    const db = getDb();
    const noteId = parseInt(req.params.noteId, 10);

    const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(noteId);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    db.prepare('DELETE FROM review_notes WHERE id = ?').run(noteId);

    logActivity('review_note_delete', 'review_note', noteId,
        `Note deleted from review session ${note.session_id}`);

    req.app.locals.broadcastChange?.('review_notes', 'delete', { record: note });

    res.json({ success: true });
});

/**
 * GET /api/review/history — List past (ended) review sessions with note counts.
 * Query: ?project_id=N (optional), ?limit=20 (default 20)
 */
router.get('/history', (req, res) => {
    const db = getDb();
    const projectFilter = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    let sessions;
    if (projectFilter) {
        sessions = db.prepare(`
            SELECT rs.*, COUNT(rn.id) as note_count
            FROM review_sessions rs
            LEFT JOIN review_notes rn ON rn.session_id = rs.id
            WHERE rs.status = 'ended' AND rs.project_id = ?
            GROUP BY rs.id
            ORDER BY rs.ended_at DESC
            LIMIT ?
        `).all(projectFilter, limit);
    } else {
        sessions = db.prepare(`
            SELECT rs.*, COUNT(rn.id) as note_count
            FROM review_sessions rs
            LEFT JOIN review_notes rn ON rn.session_id = rs.id
            WHERE rs.status = 'ended'
            GROUP BY rs.id
            ORDER BY rs.ended_at DESC
            LIMIT ?
        `).all(limit);
    }

    // Enrich with project info
    for (const s of sessions) {
        try { s.asset_ids = JSON.parse(s.asset_ids || '[]'); } catch { s.asset_ids = []; }
        if (s.project_id) {
            try {
                const proj = db.prepare('SELECT name, code FROM projects WHERE id = ?').get(s.project_id);
                s.project_name = proj ? proj.name : null;
                s.project_code = proj ? proj.code : null;
            } catch { /* non-critical */ }
        }
    }

    res.json({ sessions });
});


// ═══════════════════════════════════════════
//  HUB-SIDE ENDPOINTS (called via spoke write-proxy)
//  These run ONLY on the hub to persist review sessions in the hub DB.
// ═══════════════════════════════════════════

/**
 * POST /api/review/hub-register — Register a spoke's review session on the hub DB.
 * Called by the spoke's /start handler via forwardRequest.
 */
router.post('/hub-register', (req, res) => {
    const { session_key, host_name, host_ip, host_port, asset_ids, title, started_by, project_id } = req.body || {};

    if (!session_key || !host_ip) {
        return res.status(400).json({ error: 'Missing session_key or host_ip' });
    }

    const db = getDb();

    // Auto-end any existing active sessions from this host (prevents duplicates)
    // First, find them so we can broadcast the status change to spokes
    const staleSessions = db.prepare(`SELECT * FROM review_sessions WHERE status = 'active' AND host_ip = ?`).all(host_ip);
    if (staleSessions.length > 0) {
        db.prepare(`UPDATE review_sessions SET status = 'ended', ended_at = datetime('now') WHERE status = 'active' AND host_ip = ?`)
            .run(host_ip);
        for (const s of staleSessions) {
            const ended = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(s.id);
            req.app.locals.broadcastChange?.('review_sessions', 'update', { record: ended });
        }
        console.log(`[SyncReview] Hub auto-ended ${staleSessions.length} stale session(s) from ${host_ip}`);
    }

    const result = db.prepare(`
        INSERT OR REPLACE INTO review_sessions (session_key, host_name, host_ip, host_port, status, asset_ids, title, started_by, project_id)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(session_key, host_name || 'unknown', host_ip, host_port || 45128,
           JSON.stringify(asset_ids || []), title || 'Sync Review', started_by || 'Unknown', project_id || null);

    const sessionId = Number(result.lastInsertRowid);

    logActivity('review_start', 'review_session', sessionId,
        `Spoke review registered: ${title} from ${host_name}`);

    // Broadcast to all connected spokes so they see the review
    // Keep asset_ids as a JSON string so spoke's _applyChange stores it correctly in SQLite
    const session = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(sessionId);
    req.app.locals.broadcastChange?.('review_sessions', 'insert', { record: session });

    console.log(`[SyncReview] Hub registered spoke review: "${title}" at ${host_ip}:${host_port}`);
    res.json({ success: true, id: sessionId });
});

/**
 * POST /api/review/hub-end — End a review session on the hub DB.
 * Called by the spoke's /end handler via forwardRequest.
 */
router.post('/hub-end', (req, res) => {
    const { session_key } = req.body || {};

    if (!session_key) {
        return res.status(400).json({ error: 'Missing session_key' });
    }

    const db = getDb();
    const session = db.prepare(
        `SELECT * FROM review_sessions WHERE session_key = ? AND status = 'active'`
    ).get(session_key);

    if (!session) {
        return res.status(404).json({ error: 'Session not found or already ended' });
    }

    db.prepare(`UPDATE review_sessions SET status = 'ended', ended_at = datetime('now') WHERE session_key = ?`)
        .run(session_key);

    logActivity('review_end', 'review_session', session.id,
        `Spoke review ended on hub: ${session.title}`);

    // Broadcast to all spokes
    const updated = db.prepare('SELECT * FROM review_sessions WHERE id = ?').get(session.id);
    try { updated.asset_ids = JSON.parse(updated.asset_ids || '[]'); } catch { updated.asset_ids = []; }
    req.app.locals.broadcastChange?.('review_sessions', 'update', { record: updated });

    console.log(`[SyncReview] Hub ended spoke review: "${session.title}"`);
    res.json({ success: true });
});

/**
 * POST /api/review/hub-note — Register a spoke's review note on the hub DB.
 * Called by the spoke's /notes handler via forwardRequest.
 */
router.post('/hub-note', (req, res) => {
    const { session_key, asset_id, frame_number, timecode, note_text, author, annotation_image } = req.body || {};

    if (!session_key || !note_text) {
        return res.status(400).json({ error: 'Missing session_key or note_text' });
    }

    const db = getDb();
    const session = db.prepare(
        `SELECT * FROM review_sessions WHERE session_key = ?`
    ).get(session_key);

    if (!session) {
        return res.status(404).json({ error: 'Session not found on hub' });
    }

    const result = db.prepare(`
        INSERT INTO review_notes (session_id, asset_id, frame_number, timecode, note_text, author, annotation_image)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, asset_id || null, frame_number || null, timecode || null, note_text, author || 'Unknown', annotation_image || null);

    const noteId = Number(result.lastInsertRowid);
    const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(noteId);

    // Broadcast to all spokes
    req.app.locals.broadcastChange?.('review_notes', 'insert', { record: note });

    console.log(`[SyncReview] Hub stored spoke note for "${session.title}" by ${author}`);
    res.json({ success: true, id: noteId });
});

/**
 * POST /api/review/hub-annotation — Receive annotated frame image from spoke.
 *
 * The spoke captures a frame with RV annotations, saves it locally, then
 * base64-encodes the PNG and sends it here so the hub has a copy too.
 * Images are stored in: data/review-snapshots/{PROJECT_CODE}/{YYYY-MM-DD}/
 *
 * Body: { session_key, asset_id?, frame_number, note_text, author,
 *         image_base64, project_code, filename }
 */
router.post('/hub-annotation', (req, res) => {
    const { session_key, asset_id, frame_number, note_text, author,
            image_base64, project_code, filename } = req.body || {};

    if (!session_key || !image_base64 || !filename) {
        return res.status(400).json({ error: 'Missing session_key, image_base64, or filename' });
    }

    const db = getDb();
    const session = db.prepare(
        `SELECT * FROM review_sessions WHERE session_key = ?`
    ).get(session_key);

    if (!session) {
        return res.status(404).json({ error: 'Session not found on hub' });
    }

    // ─── Save image to organized directory structure ───
    const DATA_DIR = process.env.CAM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
    const projFolder = (project_code || 'GENERAL').replace(/[^a-zA-Z0-9_-]/g, '_');
    const today = new Date();
    const dateFolder = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const snapshotsDir = path.join(DATA_DIR, 'review-snapshots', projFolder, dateFolder);
    if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

    const destPath = path.join(snapshotsDir, filename);
    const relativePath = `${projFolder}/${dateFolder}/${filename}`;

    try {
        const imageBuffer = Buffer.from(image_base64, 'base64');
        fs.writeFileSync(destPath, imageBuffer);
    } catch (err) {
        console.error('[SyncReview] Hub failed to save annotation image:', err.message);
        return res.status(500).json({ error: 'Failed to save annotation image' });
    }

    // Create the note with annotation_image reference
    const text = (note_text && note_text.trim()) || `Annotated frame ${frame_number}`;

    const result = db.prepare(`
        INSERT INTO review_notes (session_id, asset_id, frame_number, note_text, author, annotation_image)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.id, asset_id || null, frame_number || null, text, author || 'Unknown', relativePath);

    const noteId = Number(result.lastInsertRowid);
    const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(noteId);

    // Broadcast to all spokes
    req.app.locals.broadcastChange?.('review_notes', 'insert', { record: note });

    console.log(`[SyncReview] Hub saved annotation: ${relativePath} (session ${session.id}, frame ${frame_number})`);
    res.json({ success: true, id: noteId, annotation_image: relativePath });
});


module.exports = router;
