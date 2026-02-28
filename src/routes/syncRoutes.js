/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * syncRoutes — Hub-side API endpoints for spoke synchronization
 *
 * These routes are ONLY mounted when mode === 'hub'.
 * They provide:
 *   GET  /api/sync/status   — Hub status / health check
 *   GET  /api/sync/events   — SSE stream for real-time DB change events
 *   GET  /api/sync/db       — Download full DB snapshot
 *   GET  /api/sync/spokes   — List connected spokes
 *   POST /api/sync/write    — Receive proxied write from a spoke
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();

const HubService = require('../services/HubService');

// All routes require hub auth (shared secret)
router.use(HubService.requireAuth);

// ─── GET /status - Health check / hub info ───
router.get('/status', (req, res) => {
    try {
        const { getDb, getSetting } = require('../database');
        const db = getDb();
        const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets').get().count;
        const version = require('../../package.json').version;

        res.json({
            status: 'ok',
            mode: 'hub',
            name: getSetting('server_name') || require('os').hostname(),
            version,
            assetCount,
            connectedSpokes: HubService.getConnectedSpokes().length,
            timestamp: Date.now(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /events - SSE endpoint for spokes ───
router.get('/events', (req, res) => {
    const spokeId = crypto.randomUUID();
    const spokeName = req.query.name || 'unknown';

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Send initial connection confirmation
    res.write(`event: connected\ndata: ${JSON.stringify({ spokeId, message: 'Connected to hub' })}\n\n`);

    // Register with HubService
    HubService.addSpokeClient(spokeId, res, spokeName);

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        } catch {
            clearInterval(keepAlive);
        }
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(keepAlive);
        HubService.removeSpokeClient(spokeId);
    });
});

// ─── GET /db - Download full DB snapshot ───
router.get('/db', (req, res) => {
    try {
        // Force WAL checkpoint for consistent snapshot
        HubService.checkpointDb();
        const dbPath = HubService.getDbPath();

        if (!fs.existsSync(dbPath)) {
            return res.status(404).json({ error: 'Database file not found' });
        }

        const stat = fs.statSync(dbPath);
        res.setHeader('Content-Type', 'application/x-sqlite3');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', 'attachment; filename="mediavault.db"');
        res.setHeader('X-DB-Timestamp', Date.now().toString());

        const stream = fs.createReadStream(dbPath);
        stream.pipe(res);

        stream.on('error', (err) => {
            console.error('[Hub] DB download error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to read database' });
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /thumbnails - Download all thumbnails as tar stream ───
// Spoke calls this after DB sync to get all thumbnail images.
// Uses a simple custom tar-like format: for each file,
//   4 bytes (UInt32BE) = filename length
//   N bytes = filename (e.g., "thumb_123.jpg")
//   4 bytes (UInt32BE) = file data length
//   M bytes = file data (raw JPEG)
// Ends with 4 zero bytes (filename length = 0) as sentinel.
router.get('/thumbnails', (req, res) => {
    try {
        const thumbDir = path.join(__dirname, '..', '..', 'thumbnails');
        if (!fs.existsSync(thumbDir)) {
            return res.status(404).json({ error: 'Thumbnails directory not found' });
        }

        const files = fs.readdirSync(thumbDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
        console.log(`[Hub] Serving ${files.length} thumbnails to spoke`);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="thumbnails.bin"');
        res.setHeader('X-Thumbnail-Count', files.length.toString());

        for (const file of files) {
            const filePath = path.join(thumbDir, file);
            try {
                const data = fs.readFileSync(filePath);
                const nameBytes = Buffer.from(file, 'utf8');
                // Write filename length + filename
                const nameLen = Buffer.alloc(4);
                nameLen.writeUInt32BE(nameBytes.length);
                res.write(nameLen);
                res.write(nameBytes);
                // Write file data length + file data
                const dataLen = Buffer.alloc(4);
                dataLen.writeUInt32BE(data.length);
                res.write(dataLen);
                res.write(data);
            } catch (err) {
                // Skip unreadable files
            }
        }

        // Sentinel: 4 zero bytes = end of stream
        res.write(Buffer.alloc(4, 0));
        res.end();
    } catch (err) {
        console.error('[Hub] Thumbnails download error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

// ─── GET /thumbnail/:id - Download a single thumbnail by asset ID ───
// Used by spokes when a new asset is added via SSE and they need just one thumb.
router.get('/thumbnail/:id', (req, res) => {
    const thumbDir = path.join(__dirname, '..', '..', 'thumbnails');
    const thumbPath = path.join(thumbDir, `thumb_${req.params.id}.jpg`);

    if (fs.existsSync(thumbPath)) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.sendFile(thumbPath);
    } else {
        res.status(404).json({ error: 'Thumbnail not found' });
    }
});

// ─── GET /spokes - List connected spokes ───
router.get('/spokes', (req, res) => {
    res.json({
        spokes: HubService.getConnectedSpokes(),
        count: HubService.getConnectedSpokes().length,
    });
});

// ─── POST /write - Spoke forwards a write operation ───
//
// Body: {
//   method: 'POST' | 'PUT' | 'DELETE',
//   path: '/api/assets/123',
//   body: { ... },
//   headers: { ... },
//   spokeName: 'Greg-Mac'
// }
//
// The hub executes the write locally and broadcasts the change to all spokes.
router.post('/write', async (req, res) => {
    const { method, path: apiPath, body, headers: spokeHeaders, spokeName } = req.body;

    if (!method || !apiPath) {
        return res.status(400).json({ error: 'method and path are required' });
    }

    console.log(`[Hub] Write from spoke "${spokeName || 'unknown'}": ${method} ${apiPath}`);

    try {
        // Build an internal request to the hub's own Express routes
        // We use a lightweight approach: make an HTTP request to ourselves
        const http = require('http');
        const PORT = process.env.PORT || 7700;

        const reqOptions = {
            hostname: '127.0.0.1',
            port: PORT,
            path: apiPath,
            method: method.toUpperCase(),
            headers: {
                'Content-Type': 'application/json',
                // Forward the spoke's user header so permissions work
                ...(spokeHeaders?.['x-cam-user'] ? { 'X-CAM-User': spokeHeaders['x-cam-user'] } : {}),
                // Mark this as an internal hub write (not from a spoke proxy)
                'X-Hub-Internal': 'true',
            },
        };

        const proxyPromise = new Promise((resolve, reject) => {
            const proxyReq = http.request(reqOptions, (proxyRes) => {
                let data = '';
                proxyRes.setEncoding('utf8');
                proxyRes.on('data', chunk => data += chunk);
                proxyRes.on('end', () => {
                    resolve({
                        status: proxyRes.statusCode,
                        headers: proxyRes.headers,
                        body: data,
                    });
                });
            });

            proxyReq.on('error', reject);
            proxyReq.setTimeout(60000, () => {
                proxyReq.destroy(new Error('Hub internal request timeout'));
            });

            if (body && method.toUpperCase() !== 'GET') {
                proxyReq.write(JSON.stringify(body));
            }
            proxyReq.end();
        });

        const result = await proxyPromise;

        // Forward the hub's response back to the spoke
        res.status(result.status);
        try {
            res.json(JSON.parse(result.body));
        } catch {
            res.send(result.body);
        }
    } catch (err) {
        console.error(`[Hub] Write proxy error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
