/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Role Routes
 * CRUD for global VFX department roles (Comp, Light, Anim, FX, etc.)
 */

const express = require('express');
const router = express.Router();
const { getDb, logActivity } = require('../database');

// GET /api/roles — List all roles
router.get('/', (req, res) => {
    const db = getDb();
    const roles = db.prepare('SELECT * FROM roles ORDER BY sort_order, name').all();
    res.json(roles);
});

// POST /api/roles — Create a new role
router.post('/', (req, res) => {
    const { name, code, color = '#888888', icon = '🎭' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const cleanCode = (code || name).toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (cleanCode.length < 1) return res.status(400).json({ error: 'Code must be at least 1 character' });

    const db = getDb();
    try {
        const maxOrder = db.prepare('SELECT MAX(sort_order) as mx FROM roles').get();
        const sortOrder = (maxOrder?.mx || 0) + 1;

        const result = db.prepare(
            'INSERT INTO roles (name, code, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)'
        ).run(name.trim(), cleanCode, color, icon, sortOrder);

        logActivity('role_created', 'role', result.lastInsertRowid, { name, code: cleanCode });

        const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(role);
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'A role with that name or code already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/roles/:id — Update a role (rename, color, icon)
router.put('/:id', (req, res) => {
    const { name, code, color, icon, sort_order } = req.body;
    const db = getDb();

    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const newName = name?.trim() || role.name;
    const newCode = code ? code.toUpperCase().replace(/[^A-Z0-9_]/g, '') : role.code;

    try {
        db.prepare('UPDATE roles SET name = ?, code = ?, color = ?, icon = ?, sort_order = ? WHERE id = ?')
            .run(newName, newCode, color || role.color, icon || role.icon, sort_order ?? role.sort_order, role.id);

        logActivity('role_updated', 'role', role.id, { name: newName });

        const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id);
        res.json(updated);
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'A role with that name or code already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/roles/:id — Delete role (assets.role_id set to NULL via FK)
router.delete('/:id', (req, res) => {
    const db = getDb();
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets WHERE role_id = ?').get(role.id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);

    logActivity('role_deleted', 'role', role.id, { name: role.name, assetsAffected: assetCount.count });

    res.json({ success: true, assetsCleared: assetCount.count });
});

// PUT /api/roles/reorder — Bulk update sort_order
router.put('/reorder', (req, res) => {
    const { order } = req.body; // Array of { id, sort_order }
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });

    const db = getDb();
    const stmt = db.prepare('UPDATE roles SET sort_order = ? WHERE id = ?');
    const reorder = db.transaction((items) => {
        for (const item of items) stmt.run(item.sort_order, item.id);
    });
    reorder(order);
    res.json({ success: true });
});

module.exports = router;
