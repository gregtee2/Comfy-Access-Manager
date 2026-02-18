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
const { initDb, closeDb } = require('./database');
const WatcherService = require('./services/WatcherService');
const RVPluginSync = require('./services/RVPluginSync');

const app = express();
const PORT = process.env.PORT || 7700;

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Static Files ───
// In production, serve obfuscated JS from js-dist/ instead of js/
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && fs.existsSync(path.join(__dirname, '..', 'public', 'js-dist'))) {
    // Rewrite /js/* requests to /js-dist/* (HTML stays the same)
    app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js-dist')));
    console.log('  🔒 Serving obfuscated frontend (production mode)');
}
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve thumbnails directory
app.use('/thumbnails', express.static(path.join(__dirname, '..', 'thumbnails')));

// Ensure key folders exist on startup
const { getSetting } = require('./database');
['data', 'thumbnails'].forEach(dir => {
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
const comfyuiRoutes = require('./routes/comfyuiRoutes');
const roleRoutes = require('./routes/roleRoutes');
const exportRoutes = require('./routes/exportRoutes');
const flowRoutes = require('./routes/flowRoutes');
const transcodeRoutes = require('./routes/transcodeRoutes');
const updateRoutes = require('./routes/updateRoutes');
const serverRoutes = require('./routes/serverRoutes');
const userRoutes = require('./routes/userRoutes');
const resolveRoutes = require('./routes/resolveRoutes');
const DiscoveryService = require('./services/DiscoveryService');

app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/comfyui', comfyuiRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/flow', flowRoutes);
app.use('/api/transcode', transcodeRoutes);
app.use('/api/update', updateRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/users', userRoutes);
app.use('/api/resolve', resolveRoutes);

// ─── SPA fallback ───
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Endpoint not found' });
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Error handler ───
app.use((err, req, res, next) => {
    console.error('[DMV] Server error:', err.message);
    res.status(500).json({ error: err.message });
});

// ─── Start Server (async for sql.js init) ───
async function start() {
    await initDb();

    const server = app.listen(PORT, () => {
        console.log('');
        const version = require('../package.json').version;
        console.log('  ╔══════════════════════════════════════════╗');
        console.log(`  ║   Comfy Asset Manager (CAM) v${version.padEnd(10)}  ║`);
        console.log('  ║   Local Media Asset Manager              ║');
        console.log(`  ║   http://localhost:${PORT}                  ║`);
        console.log('  ╚══════════════════════════════════════════╝');
        console.log('');

        try {
            WatcherService.start();
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
            });
        } catch (err) {
            console.log('[Discovery] Deferred:', err.message);
        }
    });

    // ─── Graceful Shutdown ───
    const shutdown = () => {
        console.log('\n[DMV] Shutting down...');
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
