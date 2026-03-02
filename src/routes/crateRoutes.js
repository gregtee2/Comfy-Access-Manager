/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM — Crate Routes
 * CRUD for crates (asset staging/export collections).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb, logActivity } = require('../database');
const { resolveFilePath } = require('../utils/pathResolver');

// ────────────────────────────────────────────
//  SSE — push crate changes to open browsers
// ────────────────────────────────────────────

const _sseClients = new Set();

function _broadcast(crateId, action, detail) {
    const payload = JSON.stringify({ crateId, action, ...detail });
    console.log(`[Crate SSE] Broadcasting to ${_sseClients.size} client(s):`, { crateId, action });
    for (const client of _sseClients) {
        client.write(`data: ${payload}\n\n`);
    }
}

router.get('/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write(':\n\n');  // comment line = keepalive
    _sseClients.add(res);
    console.log(`[Crate SSE] Client connected (${_sseClients.size} total)`);
    req.on('close', () => {
        _sseClients.delete(res);
        console.log(`[Crate SSE] Client disconnected (${_sseClients.size} remaining)`);
    });
});

// ────────────────────────────────────────────
//  LIST ALL CRATES (with item counts)
// ────────────────────────────────────────────

router.get('/', (req, res) => {
    try {
        const db = getDb();
        const crates = db.prepare(`
            SELECT c.*, COUNT(ci.id) AS item_count
            FROM crates c
            LEFT JOIN crate_items ci ON ci.crate_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `).all();
        res.json(crates);
    } catch (err) {
        console.error('Failed to list crates:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  CREATE CRATE
// ────────────────────────────────────────────

router.post('/', (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

        const db = getDb();
        const result = db.prepare('INSERT INTO crates (name) VALUES (?)').run(name.trim());
        const crate = db.prepare('SELECT * FROM crates WHERE id = ?').get(result.lastInsertRowid);
        logActivity('create', 'crate', crate.id, { name: crate.name });
        res.json(crate);
    } catch (err) {
        console.error('Failed to create crate:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  RENAME CRATE
// ────────────────────────────────────────────

router.put('/:id', (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
        const db = getDb();
        db.prepare('UPDATE crates SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
        const crate = db.prepare('SELECT * FROM crates WHERE id = ?').get(req.params.id);
        res.json(crate);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  DELETE CRATE
// ────────────────────────────────────────────

router.delete('/:id', (req, res) => {
    try {
        const db = getDb();
        const crate = db.prepare('SELECT * FROM crates WHERE id = ?').get(req.params.id);
        if (!crate) return res.status(404).json({ error: 'Crate not found' });

        db.prepare('DELETE FROM crate_items WHERE crate_id = ?').run(req.params.id);
        db.prepare('DELETE FROM crates WHERE id = ?').run(req.params.id);
        logActivity('delete', 'crate', crate.id, { name: crate.name });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  LIST ITEMS IN A CRATE (joined with assets)
// ────────────────────────────────────────────

router.get('/:id/items', (req, res) => {
    try {
        const db = getDb();
        const items = db.prepare(`
            SELECT ci.id AS crate_item_id, ci.added_at,
                   a.*,
                   p.name AS project_name, p.code AS project_code,
                   s.name AS shot_name, s.code AS shot_code,
                   r.name AS role_name, r.code AS role_code, r.color AS role_color, r.icon AS role_icon
            FROM crate_items ci
            JOIN assets a ON a.id = ci.asset_id
            LEFT JOIN projects p ON p.id = a.project_id
            LEFT JOIN shots s ON s.id = a.shot_id
            LEFT JOIN roles r ON r.id = a.role_id
            WHERE ci.crate_id = ?
            ORDER BY ci.added_at DESC
        `).all(req.params.id);

        // Resolve file paths for cross-platform
        for (const item of items) {
            if (item.file_path) item.file_path = resolveFilePath(item.file_path);
        }

        res.json(items);
    } catch (err) {
        console.error('Failed to list crate items:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  ADD ASSET(S) TO CRATE
// ────────────────────────────────────────────

router.post('/:id/items', (req, res) => {
    try {
        const { assetIds } = req.body;   // Array of asset IDs
        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ error: 'assetIds array is required' });
        }

        const db = getDb();
        const crate = db.prepare('SELECT * FROM crates WHERE id = ?').get(req.params.id);
        if (!crate) return res.status(404).json({ error: 'Crate not found' });

        const insert = db.prepare('INSERT OR IGNORE INTO crate_items (crate_id, asset_id) VALUES (?, ?)');
        const addAll = db.transaction((ids) => {
            let added = 0;
            for (const aid of ids) {
                const r = insert.run(req.params.id, aid);
                if (r.changes > 0) added++;
            }
            return added;
        });
        const added = addAll(assetIds);
        logActivity('add_to_crate', 'crate', crate.id, { added, total: assetIds.length });
        if (added > 0) _broadcast(Number(req.params.id), 'add', { added });
        res.json({ ok: true, added });
    } catch (err) {
        console.error('Failed to add to crate:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  REMOVE ITEM(S) FROM CRATE
// ────────────────────────────────────────────

router.delete('/:id/items', (req, res) => {
    try {
        const { assetIds } = req.body;   // Array of asset IDs to remove
        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ error: 'assetIds array is required' });
        }

        const db = getDb();
        const del = db.prepare('DELETE FROM crate_items WHERE crate_id = ? AND asset_id = ?');
        const removeAll = db.transaction((ids) => {
            let removed = 0;
            for (const aid of ids) {
                const r = del.run(req.params.id, aid);
                if (r.changes > 0) removed++;
            }
            return removed;
        });
        const removed = removeAll(assetIds);
        if (removed > 0) _broadcast(Number(req.params.id), 'remove', { removed });
        res.json({ ok: true, removed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  EXPORT CRATE (copy all files to target dir)
// ────────────────────────────────────────────

router.post('/:id/export', async (req, res) => {
    try {
        const { targetDir } = req.body;
        if (!targetDir) return res.status(400).json({ error: 'targetDir is required' });

        const db = getDb();
        const crate = db.prepare('SELECT * FROM crates WHERE id = ?').get(req.params.id);
        if (!crate) return res.status(404).json({ error: 'Crate not found' });

        const items = db.prepare(`
            SELECT a.file_path, a.vault_name, a.file_ext
            FROM crate_items ci
            JOIN assets a ON a.id = ci.asset_id
            WHERE ci.crate_id = ?
        `).all(req.params.id);

        if (items.length === 0) return res.status(400).json({ error: 'Crate is empty' });

        // Ensure target directory exists
        fs.mkdirSync(targetDir, { recursive: true });

        let copied = 0;
        const errors = [];

        for (const item of items) {
            const srcPath = resolveFilePath(item.file_path);
            const destName = item.vault_name || path.basename(srcPath);
            const destPath = path.join(targetDir, destName);

            try {
                if (!fs.existsSync(srcPath)) {
                    errors.push({ file: destName, error: 'Source file not found' });
                    continue;
                }
                // Handle collision: add counter
                let finalDest = destPath;
                if (fs.existsSync(finalDest)) {
                    const ext = path.extname(destName);
                    const base = path.basename(destName, ext);
                    let counter = 2;
                    while (fs.existsSync(finalDest)) {
                        finalDest = path.join(targetDir, `${base}_${counter}${ext}`);
                        counter++;
                    }
                }
                fs.copyFileSync(srcPath, finalDest);
                copied++;
            } catch (copyErr) {
                errors.push({ file: destName, error: copyErr.message });
            }
        }

        logActivity('export_crate', 'crate', crate.id, { name: crate.name, copied, errors: errors.length, targetDir });
        res.json({ ok: true, copied, total: items.length, errors });
    } catch (err) {
        console.error('Failed to export crate:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────
//  ADD TO CRATE BY FILE PATH (used by RV plugin)
// ────────────────────────────────────────────

router.post('/:id/add-by-path', (req, res) => {
    try {
        const { filePath: rawPath } = req.body;
        if (!rawPath) return res.status(400).json({ error: 'filePath is required' });

        const db = getDb();
        const crate = db.prepare('SELECT * FROM crates WHERE id = ?').get(req.params.id);
        if (!crate) return res.status(404).json({ error: 'Crate not found' });

        // Resolve cross-platform path variants
        const { getAllPathVariants } = require('../utils/pathResolver');
        const variants = getAllPathVariants(rawPath);
        const stmt = db.prepare(`SELECT id, vault_name FROM assets WHERE replace(file_path, '\\', '/') = ? LIMIT 1`);

        let asset = null;
        for (const v of variants) {
            asset = stmt.get(v);
            if (asset) break;
        }

        console.log('[Crate] add-by-path lookup:', { rawPath, variants: variants.slice(0, 3), foundAsset: asset ? { id: asset.id, vault_name: asset.vault_name } : null });

        if (!asset) return res.status(404).json({ error: 'Asset not found in vault for this path' });

        const existing = db.prepare('SELECT id FROM crate_items WHERE crate_id = ? AND asset_id = ?').get(crate.id, asset.id);
        if (existing) {
            console.log('[Crate] DUPLICATE — asset %d already in crate %d', asset.id, crate.id);
        }
        db.prepare('INSERT OR IGNORE INTO crate_items (crate_id, asset_id) VALUES (?, ?)').run(crate.id, asset.id);

        logActivity('add_to_crate_by_path', 'crate', crate.id, { assetId: asset.id, vaultName: asset.vault_name });
        _broadcast(crate.id, 'add', { added: 1, vaultName: asset.vault_name });
        res.json({ ok: true, assetId: asset.id, vaultName: asset.vault_name, crateName: crate.name });
    } catch (err) {
        console.error('Failed to add to crate by path:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
