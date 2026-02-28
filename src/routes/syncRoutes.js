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
