/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Comfy Asset Manager (CAM) - Main Server
 * Local media asset manager for creative production
 * Port: 7700
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDb, closeDb, loadConfig } = require('./database');
const WatcherService = require('./services/WatcherService');
const RVPluginSync = require('./services/RVPluginSync');
const pluginLoader = require('./pluginLoader');

// ─── Hub/Spoke Mode (from config.json) ───
// "standalone" (default) = current behaviour, no sync
// "hub"        = central server, broadcasts changes to spokes via SSE
// "spoke"      = local replica, proxies writes to hub, receives SSE updates
const _config = loadConfig();
const APP_MODE = _config.mode || 'standalone';

const app = express();
const PORT = process.env.PORT || 7700;

// ─── Middleware (must be before spoke proxy so req.body is parsed) ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Spoke write-proxy (if spoke mode) ───
// Must be registered before API routes so it can intercept writes
let _spokeService = null;
if (APP_MODE === 'spoke') {
    const SpokeService = require('./services/SpokeService');
    const { createSpokeProxy } = require('./middleware/spokeProxy');
    _spokeService = new SpokeService(
        _config.hub_url || 'http://localhost:7700',
        _config.hub_secret || '',
        _config.spoke_name || require('os').hostname()
    );
    app.use(createSpokeProxy(_spokeService));
    app.locals.spokeService = _spokeService;
    console.log(`[Mode] SPOKE — writes forwarded to ${_config.hub_url}`);
} else if (APP_MODE === 'hub') {
    const HubService = require('./services/HubService');
    HubService.init(_config.hub_secret || '');
    app.locals.broadcastChange = HubService.broadcast;
    console.log('[Mode] HUB — broadcasting changes to spokes');
} else {
    console.log('[Mode] STANDALONE');
}

// ─── Static Files ───
// Prevent aggressive caching of JS modules during development
app.use('/js', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    next();
});

// In production, serve obfuscated JS from js-dist/ instead of js/
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && fs.existsSync(path.join(__dirname, '..', 'public', 'js-dist'))) {
    // Rewrite /js/* requests to /js-dist/* (HTML stays the same)
    app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js-dist')));
    console.log('  🔒 Serving obfuscated frontend (production mode)');
}
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve thumbnails directory (with caching — thumbnails rarely change)
app.use('/thumbnails', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
    next();
}, express.static(path.join(__dirname, '..', 'thumbnails')));

// Serve review annotation snapshots (supports project/date subdirectories)
const REVIEW_SNAPSHOTS_DIR = path.join(
    process.env.CAM_DATA_DIR || path.join(__dirname, '..', 'data'),
    'review-snapshots'
);
app.use('/review-snapshots', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    next();
}, express.static(REVIEW_SNAPSHOTS_DIR));

// Ensure key folders exist on startup
const { getSetting } = require('./database');
['data', 'thumbnails', path.join('data', 'review-snapshots')].forEach(dir => {
    const p = path.join(__dirname, '..', dir);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
// Exports folder — inside vault if configured, otherwise top-level
setTimeout(() => {
    try {
        const vaultRoot = getSetting('vault_root');
        const exportsDir = vaultRoot ? path.join(vaultRoot, 'exports') : path.join(__dirname, '..', 'exports');
        if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
    } catch (e) { /* DB not ready yet, will be created on first export */ }
}, 2000);

// ─── API Routes ───
const projectRoutes = require('./routes/projectRoutes');
const assetRoutes = require('./routes/assetRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const roleRoutes = require('./routes/roleRoutes');
const exportRoutes = require('./routes/exportRoutes');
const transcodeRoutes = require('./routes/transcodeRoutes');
const updateRoutes = require('./routes/updateRoutes');
const serverRoutes = require('./routes/serverRoutes');
const userRoutes = require('./routes/userRoutes');
const crateRoutes = require('./routes/crateRoutes');
const overlayRoutes = require('./routes/overlayRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const voiceRoutes = require('./routes/voiceRoutes');
const DiscoveryService = require('./services/DiscoveryService');

app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/transcode', transcodeRoutes);
app.use('/api/update', updateRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/users', userRoutes);
app.use('/api/crates', crateRoutes);
app.use('/api/overlay', overlayRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/voice', voiceRoutes);

// ─── Hub Sync Routes (hub mode only) ───
if (APP_MODE === 'hub') {
    const syncRoutes = require('./routes/syncRoutes');
    app.use('/api/sync', syncRoutes);
}

// ─── Load Plugins + SPA Fallback (registered inside start() to ensure order) ───
// Plugin loader, SPA fallback, and error handler are registered in start()
// so plugins mount before the wildcard catch-all route.

// ─── Start Server (async for sql.js init) ───
async function start() {
    await initDb();

    // Fix 0kb file sizes for existing assets
    try {
        const db = require('./database').getDb();
        const pathResolver = require('./utils/pathResolver');
        const assets = db.prepare('SELECT id, file_path FROM assets WHERE (file_size = 0 OR file_size IS NULL) AND is_sequence = 0').all();
        if (assets.length > 0) {
            console.log(`[DB] Fixing ${assets.length} assets with 0kb file size...`);
            const updateStmt = db.prepare('UPDATE assets SET file_size = ? WHERE id = ?');
            db.transaction(() => {
                for (const a of assets) {
                    try {
                        const resolvedPath = pathResolver.resolveFilePath(a.file_path);
                        if (fs.existsSync(resolvedPath)) {
                            const size = fs.statSync(resolvedPath).size;
                            updateStmt.run(size, a.id);
                        }
                    } catch (e) {}
                }
            })();
            console.log('[DB] File sizes updated.');
        }
    } catch (err) {
        console.error('[DB] Failed to fix file sizes:', err.message);
    }

    // Load plugins AFTER DB init, BEFORE SPA fallback
    try {
        await pluginLoader.loadAll(app);
    } catch (err) {
        console.error('[Plugins] Failed to load plugins:', err.message);
    }

    // SPA fallback — MUST come after all routes (core + plugin)
    app.get('*', (req, res) => {
        if (req.path.startsWith('/api/')) {
            return res.status(404).json({ error: 'Endpoint not found' });
        }
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });

    // Error handler — MUST be last
    app.use((err, req, res, next) => {
        console.error('[DMV] Server error:', err.message);
        res.status(500).json({ error: err.message });
    });

    const server = app.listen(PORT, () => {
        console.log('');
        const version = require('../package.json').version;
        console.log('  ╔══════════════════════════════════════════╗');
        console.log(`  ║   Comfy Asset Manager (CAM) v${version.padEnd(10)}  ║`);
        console.log('  ║   Local Media Asset Manager              ║');
        console.log(`  ║   http://localhost:${PORT}                  ║`);
        if (APP_MODE !== 'standalone') {
        console.log(`  ║   Mode: ${APP_MODE.toUpperCase().padEnd(33)}║`);
        }
        console.log('  ╚══════════════════════════════════════════╝');
        console.log('');

        try {
            WatcherService.start();

            // Auto-match watched files to Flow project/sequence/shot if configured
            WatcherService.onFileDetected = ({ filePath, folderPath, projectId, watchId }) => {
                try {
                    const PathMatchService = require('../plugins/flow/services/PathMatchService');
                    const database = require('./database');
                    PathMatchService.setDatabase(database);

                    const showRoot = PathMatchService.getShowRoot();
                    if (!showRoot) return; // Path matching not configured

                    const tokens = PathMatchService.parsePath(filePath);
                    if (!tokens || !tokens.project) return;

                    const resolved = PathMatchService.resolveTokens(tokens);
                    if (resolved.projectId) {
                        console.log(`[Watcher] Auto-matched: ${require('path').basename(filePath)} → project ${tokens.project}, seq ${tokens.sequence || '-'}, shot ${tokens.shot || '-'}`);
                    }
                } catch {
                    // PathMatchService not available or not configured — skip silently
                }
            };
        } catch (err) {
            console.log('[Watcher] Starting watchers deferred:', err.message);
        }

        // Sync MediaVault plugin to all detected RV installations
        try {
            RVPluginSync.sync();
        } catch (err) {
            console.log('[RVPlugin] Sync deferred:', err.message);
        }

        // Start network discovery so other instances can find us
        try {
            const db = require('./database').getDb();
            const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets').get().count;
            DiscoveryService.start({
                name: require('./database').getSetting('server_name') || require('os').hostname(),
                version,
                port: PORT,
                assetCount,
                mode: APP_MODE,
            });
        } catch (err) {
            console.log('[Discovery] Deferred:', err.message);
        }

        // Batch-repair missing thumbnail files in background (non-blocking)
        setTimeout(async () => {
            try {
                const ThumbnailService = require('./services/ThumbnailService');
                const db = require('./database').getDb();
                const pathResolver = require('./utils/pathResolver');
                await ThumbnailService.batchRepairMissing(db, pathResolver.resolveFilePath);
            } catch (err) {
                console.error('[Thumbnails] Batch repair error:', err.message);
            }
        }, 5000); // Wait 5s after startup so the UI is responsive first

        // ─── Hub / Spoke initialization (after server is listening) ───
        if (APP_MODE === 'hub') {
            try {
                const HubService = require('./services/HubService');
                HubService.init(_config.hub_secret || '');
                console.log(`[Hub] Sync API available at http://localhost:${PORT}/api/sync/`);
            } catch (err) {
                console.error('[Hub] Init error:', err.message);
            }
        }

        if (APP_MODE === 'spoke' && _spokeService) {
            _spokeService.start().catch(err => {
                console.error('[Spoke] Start error:', err.message);
            });
        }
    });

    // ─── Graceful Shutdown ───
    const shutdown = () => {
        console.log('\n[DMV] Shutting down...');
        if (_spokeService) _spokeService.stop();
        DiscoveryService.stop();
        WatcherService.stopAll();
        closeDb();
        server.close(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

start().catch(err => {
    console.error('[DMV] Fatal:', err);
    process.exit(1);
});// Keep alive
setInterval(() => {}, 60000);
