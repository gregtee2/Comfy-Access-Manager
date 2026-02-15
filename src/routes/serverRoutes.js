/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault — Server Discovery Routes
 * Find other MediaVault instances on the network, manage saved servers,
 * and provide server identity info.
 */

const express = require('express');
const router = express.Router();
const os = require('os');
const DiscoveryService = require('../services/DiscoveryService');
const { getDb, getSetting, setSetting } = require('../database');

// ─── GET /api/servers/info ───
// Returns this server's identity (used by remote instances to verify connectivity)
router.get('/info', (req, res) => {
    const db = getDb();
    const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets').get().count;
    const projectCount = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
    const vaultRoot = getSetting('vault_root');

    res.json({
        name: getSetting('server_name') || os.hostname(),
        hostname: os.hostname(),
        platform: process.platform,
        version: require('../../package.json').version,
        port: parseInt(process.env.PORT) || 7700,
        ip: DiscoveryService.getLocalIPs(),
        assets: assetCount,
        projects: projectCount,
        vaultRoot: vaultRoot || null,
    });
});

// ─── GET /api/servers/discover ───
// Scan the LAN for other MediaVault instances
router.get('/discover', async (req, res) => {
    try {
        const timeout = Math.min(parseInt(req.query.timeout) || 2000, 5000);
        const servers = await DiscoveryService.discover(timeout);
        res.json({ servers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/servers/saved ───
// Return list of manually saved remote servers
router.get('/saved', (req, res) => {
    try {
        const raw = getSetting('remote_servers');
        const servers = raw ? JSON.parse(raw) : [];
        res.json({ servers });
    } catch {
        res.json({ servers: [] });
    }
});

// ─── POST /api/servers/save ───
// Save a remote server to the list
router.post('/save', (req, res) => {
    const { name, url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    try {
        const raw = getSetting('remote_servers');
        const servers = raw ? JSON.parse(raw) : [];

        // Normalize URL
        const normalized = url.replace(/\/+$/, '');

        // Dedupe
        if (servers.some(s => s.url === normalized)) {
            return res.json({ servers, message: 'Already saved' });
        }

        servers.push({ name: name || normalized, url: normalized, addedAt: new Date().toISOString() });
        setSetting('remote_servers', JSON.stringify(servers));
        res.json({ servers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/servers/saved/:index ───
// Remove a saved server by index
router.delete('/saved/:index', (req, res) => {
    try {
        const raw = getSetting('remote_servers');
        const servers = raw ? JSON.parse(raw) : [];
        const idx = parseInt(req.params.index);
        if (idx >= 0 && idx < servers.length) {
            servers.splice(idx, 1);
            setSetting('remote_servers', JSON.stringify(servers));
        }
        res.json({ servers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/servers/ping ───
// Check if a remote server is reachable
router.post('/ping', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${url}/api/servers/info`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const info = await response.json();
        res.json({ online: true, ...info });
    } catch (err) {
        res.json({ online: false, error: err.message });
    }
});

// ─── POST /api/servers/name ───
// Set this server's friendly name
router.post('/name', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    setSetting('server_name', name.trim());
    res.json({ name: name.trim() });
});

// ─── GET /api/servers/path-map ───
// Get path mappings for cross-platform file access
router.get('/path-map', (req, res) => {
    try {
        const raw = getSetting('path_mappings');
        const mappings = raw ? JSON.parse(raw) : [];
        res.json({ mappings });
    } catch {
        res.json({ mappings: [] });
    }
});

// ─── POST /api/servers/path-map ───
// Save path mappings (e.g., Z:\ → /Volumes/media)
router.post('/path-map', (req, res) => {
    const { mappings } = req.body;
    if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });
    setSetting('path_mappings', JSON.stringify(mappings));
    res.json({ mappings });
});

module.exports = router;
