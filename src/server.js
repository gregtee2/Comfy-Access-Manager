/**
 * Digital Media Vault (DMV) - Main Server
 * Local Digital Asset Manager for creative production
 * Port: 7700
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, closeDb } = require('./database');
const WatcherService = require('./services/WatcherService');

const app = express();
const PORT = process.env.PORT || 7700;

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Static Files ───
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve thumbnails directory
app.use('/thumbnails', express.static(path.join(__dirname, '..', 'thumbnails')));

// ─── API Routes ───
const projectRoutes = require('./routes/projectRoutes');
const assetRoutes = require('./routes/assetRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const comfyuiRoutes = require('./routes/comfyuiRoutes');
const roleRoutes = require('./routes/roleRoutes');
const exportRoutes = require('./routes/exportRoutes');
const flowRoutes = require('./routes/flowRoutes');

app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/comfyui', comfyuiRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/flow', flowRoutes);

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
        console.log('  ╔══════════════════════════════════════════╗');
        console.log('  ║   Digital Media Vault (DMV) v1.0.0      ║');
        console.log('  ║   Local Digital Asset Manager            ║');
        console.log(`  ║   http://localhost:${PORT}                  ║`);
        console.log('  ╚══════════════════════════════════════════╝');
        console.log('');

        try {
            WatcherService.start();
        } catch (err) {
            console.log('[Watcher] Starting watchers deferred:', err.message);
        }
    });

    // ─── Graceful Shutdown ───
    const shutdown = () => {
        console.log('\n[DMV] Shutting down...');
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
