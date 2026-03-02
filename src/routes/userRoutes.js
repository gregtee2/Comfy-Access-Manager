/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM - User Routes
 * CRUD for users + project visibility (blacklist model) + PIN auth.
 * Blacklist = users see everything by default; admin HIDES specific projects.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb, logActivity } = require('../database');

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// ═══════════════════════════════════════════
//  PIN VERIFICATION (before /:id to avoid conflict)
// ═══════════════════════════════════════════

// POST /api/users/verify-pin — Verify a user's PIN
router.post('/verify-pin', (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) return res.status(400).json({ error: 'userId and pin required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.pin_hash) return res.json({ valid: true }); // No PIN set = always valid

    const valid = user.pin_hash === hashPin(pin);
    res.json({ valid });
});

// ═══════════════════════════════════════════
//  PROJECT-LEVEL HIDDEN ROUTES (before /:id)
// ═══════════════════════════════════════════

// GET /api/users/project/:projectId/hidden — Get users this project is hidden from
router.get('/project/:projectId/hidden', (req, res) => {
    const db = getDb();
    const projectId = req.params.projectId;

    const hiddenUsers = db.prepare(`
        SELECT u.id, u.name, u.avatar, u.color, u.is_admin
        FROM users u
        JOIN project_hidden ph ON ph.user_id = u.id
        WHERE ph.project_id = ?
        ORDER BY u.name
    `).all(projectId);

    res.json(hiddenUsers);
});

// PUT /api/users/project/:projectId/hidden — Set which users this project is hidden from
// Body: { userIds: [2, 3] }  (users who CANNOT see this project)
router.put('/project/:projectId/hidden', (req, res) => {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds array required' });

    const db = getDb();
    const projectId = req.params.projectId;

    const setHidden = db.transaction((ids) => {
        db.prepare('DELETE FROM project_hidden WHERE project_id = ?').run(projectId);
        const insert = db.prepare('INSERT OR IGNORE INTO project_hidden (user_id, project_id) VALUES (?, ?)');
        for (const uid of ids) insert.run(uid, projectId);
    });
    setHidden(userIds);

    logActivity('hidden_updated', 'project', projectId, { hiddenFromUserIds: userIds });
    res.json({ success: true, userIds });
});

// ═══════════════════════════════════════════
//  USERS CRUD
// ═══════════════════════════════════════════

// GET /api/users — List all users (pin_hash replaced with has_pin boolean)
router.get('/', (req, res) => {
    const db = getDb();
    const users = db.prepare('SELECT * FROM users ORDER BY is_admin DESC, name').all();
    // Never send raw pin_hash to client
    const safe = users.map(u => ({
        ...u,
        has_pin: !!u.pin_hash,
        pin_hash: undefined
    }));
    res.json(safe);
});

// GET /api/users/:id — Get single user + hidden project IDs
router.get('/:id', (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const hiddenProjects = db.prepare(
        'SELECT project_id FROM project_hidden WHERE user_id = ?'
    ).all(user.id).map(r => r.project_id);

    res.json({
        ...user,
        has_pin: !!user.pin_hash,
        pin_hash: undefined,
        hiddenProjectIds: hiddenProjects
    });
});

// POST /api/users — Create a new user
router.post('/', (req, res) => {
    const { name, is_admin = 0, color = '#888888', avatar = '👤', pin } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const db = getDb();
    const pinHash = pin ? hashPin(pin) : null;

    try {
        const result = db.prepare(
            'INSERT INTO users (name, is_admin, color, avatar, pin_hash) VALUES (?, ?, ?, ?, ?)'
        ).run(name.trim(), is_admin ? 1 : 0, color, avatar, pinHash);

        logActivity('user_created', 'user', result.lastInsertRowid, { name: name.trim(), is_admin });

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json({ ...user, has_pin: !!user.pin_hash, pin_hash: undefined });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'A user with that name already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/users/:id — Update user (name, admin, color, avatar)
router.put('/:id', (req, res) => {
    const { name, is_admin, color, avatar } = req.body;
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newName = name?.trim() || user.name;
    const newAdmin = is_admin !== undefined ? (is_admin ? 1 : 0) : user.is_admin;

    try {
        db.prepare('UPDATE users SET name = ?, is_admin = ?, color = ?, avatar = ? WHERE id = ?')
            .run(newName, newAdmin, color || user.color, avatar || user.avatar, user.id);

        logActivity('user_updated', 'user', user.id, { name: newName, is_admin: newAdmin });
        const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        res.json({ ...updated, has_pin: !!updated.pin_hash, pin_hash: undefined });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'A user with that name already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/users/:id/pin — Set or remove PIN
// Body: { pin: "1234" } to set, { pin: null } or { pin: "" } to remove
router.put('/:id/pin', (req, res) => {
    const { pin } = req.body;
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const pinHash = pin ? hashPin(pin) : null;
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, user.id);

    logActivity('pin_changed', 'user', user.id, { name: user.name, has_pin: !!pinHash });
    res.json({ success: true, has_pin: !!pinHash });
});

// DELETE /api/users/:id — Delete user (cannot delete last admin)
router.delete('/:id', (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent deleting the last admin
    if (user.is_admin) {
        const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get();
        if (adminCount.count <= 1) {
            return res.status(400).json({ error: 'Cannot delete the last admin user' });
        }
    }

    // Clean up hidden entries
    db.prepare('DELETE FROM project_hidden WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    logActivity('user_deleted', 'user', user.id, { name: user.name });
    res.json({ success: true });
});

// ═══════════════════════════════════════════
//  USER-LEVEL HIDDEN PROJECTS
// ═══════════════════════════════════════════

// GET /api/users/:id/hidden-projects — Project IDs hidden from this user
router.get('/:id/hidden-projects', (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.is_admin) return res.json({ userId: user.id, admin: true, hiddenProjectIds: [] });

    const projectIds = db.prepare(
        'SELECT project_id FROM project_hidden WHERE user_id = ?'
    ).all(user.id).map(r => r.project_id);

    res.json({ userId: user.id, admin: false, hiddenProjectIds: projectIds });
});

// PUT /api/users/:id/hidden-projects — Set hidden projects (replaces all)
// Body: { projectIds: [1, 5] } (these projects will be hidden from this user)
router.put('/:id/hidden-projects', (req, res) => {
    const { projectIds } = req.body;
    if (!Array.isArray(projectIds)) return res.status(400).json({ error: 'projectIds array required' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const setHidden = db.transaction((ids) => {
        db.prepare('DELETE FROM project_hidden WHERE user_id = ?').run(user.id);
        const insert = db.prepare('INSERT OR IGNORE INTO project_hidden (user_id, project_id) VALUES (?, ?)');
        for (const pid of ids) insert.run(user.id, pid);
    });
    setHidden(projectIds);

    logActivity('hidden_updated', 'user', user.id, { name: user.name, hiddenProjectIds: projectIds });
    res.json({ success: true, projectIds });
});

module.exports = router;
