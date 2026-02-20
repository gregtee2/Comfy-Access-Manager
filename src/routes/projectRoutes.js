/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Project Routes
 * CRUD for projects, sequences, and shots
 */

const express = require('express');
const router = express.Router();
const { getDb, logActivity } = require('../database');
const FileService = require('../services/FileService');

/**
 * Resolve user access from X-CAM-User header.
 * Blacklist model: users see everything EXCEPT hidden projects.
 * Returns { userId, isAdmin, hiddenIds } where hiddenIds is:
 *   - null → no user header → block everything
 *   - 'all' → admin → no filtering (sees everything)
 *   - Set<number> → project IDs to EXCLUDE
 */
function resolveUserAccess(req) {
    const userId = parseInt(req.headers['x-cam-user'], 10);
    if (!userId || isNaN(userId)) return { userId: null, isAdmin: false, hiddenIds: null };

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return { userId: null, isAdmin: false, hiddenIds: null };

    if (user.is_admin) return { userId: user.id, isAdmin: true, hiddenIds: 'all' };

    const rows = db.prepare('SELECT project_id FROM project_hidden WHERE user_id = ?').all(user.id);
    const ids = new Set(rows.map(r => r.project_id));
    return { userId: user.id, isAdmin: false, hiddenIds: ids };
}

// ═══════════════════════════════════════════
//  PROJECTS
// ═══════════════════════════════════════════

// GET /api/projects — List all projects (blacklist: hide specific projects per user)
router.get('/', (req, res) => {
    const { hiddenIds } = resolveUserAccess(req);

    // No user → empty list (enforced)
    if (hiddenIds === null) return res.json([]);

    const db = getDb();
    const includeArchived = req.query.include_archived === '1';

    let projects;
    if (hiddenIds === 'all' || hiddenIds.size === 0) {
        // Admin or user with nothing hidden — show all
        projects = db.prepare(`
            SELECT p.*,
                (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) as asset_count,
                (SELECT COUNT(*) FROM sequences s WHERE s.project_id = p.id) as sequence_count
            FROM projects p
            ${includeArchived ? '' : 'WHERE COALESCE(p.archived, 0) = 0'}
            ORDER BY p.updated_at DESC
        `).all();
    } else {
        // Regular user — show all EXCEPT hidden
        const hiddenList = [...hiddenIds];
        const placeholders = hiddenList.map(() => '?').join(',');
        const archiveClause = includeArchived ? '' : 'AND COALESCE(p.archived, 0) = 0';
        projects = db.prepare(`
            SELECT p.*,
                (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) as asset_count,
                (SELECT COUNT(*) FROM sequences s WHERE s.project_id = p.id) as sequence_count
            FROM projects p
            WHERE p.id NOT IN (${placeholders}) ${archiveClause}
            ORDER BY p.updated_at DESC
        `).all(...hiddenList);
    }

    // Parse naming_convention JSON for each project
    for (const p of projects) {
        if (p.naming_convention) {
            try { p.naming_convention = JSON.parse(p.naming_convention); } catch (_) {}
        }
    }

    res.json(projects);
});

// GET /api/projects/tree — Full tree (blacklist model)
router.get('/tree', (req, res) => {
    const { hiddenIds } = resolveUserAccess(req);
    if (hiddenIds === null) return res.json([]);

    const db = getDb();
    const includeArchived = req.query.include_archived === '1';

    let projects;
    if (hiddenIds === 'all' || hiddenIds.size === 0) {
        projects = db.prepare(`
            SELECT p.id, p.name, p.code, p.type, COALESCE(p.archived, 0) as archived,
                (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) as asset_count
            FROM projects p
            ${includeArchived ? '' : 'WHERE COALESCE(p.archived, 0) = 0'}
            ORDER BY p.name
        `).all();
    } else {
        const hiddenList = [...hiddenIds];
        const placeholders = hiddenList.map(() => '?').join(',');
        const archiveClause = includeArchived ? '' : 'AND COALESCE(p.archived, 0) = 0';
        projects = db.prepare(`
            SELECT p.id, p.name, p.code, p.type, COALESCE(p.archived, 0) as archived,
                (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) as asset_count
            FROM projects p
            WHERE p.id NOT IN (${placeholders}) ${archiveClause}
            ORDER BY p.name
        `).all(...hiddenList);
    }

    const sequences = db.prepare(`
        SELECT s.id, s.project_id, s.name, s.code,
            (SELECT COUNT(*) FROM assets a WHERE a.sequence_id = s.id) as asset_count
        FROM sequences s ORDER BY s.name, s.code
    `).all();

    const shots = db.prepare(`
        SELECT sh.id, sh.project_id, sh.sequence_id, sh.name, sh.code,
            (SELECT COUNT(*) FROM assets a WHERE a.shot_id = sh.id) as asset_count
        FROM shots sh ORDER BY sh.sort_order, sh.code
    `).all();

    // Get role counts per shot (only roles that have assets in each shot)
    const shotRoles = db.prepare(`
        SELECT a.shot_id, r.id as role_id, r.name as role_name, r.code as role_code,
               r.color as role_color, r.icon as role_icon, COUNT(a.id) as asset_count
        FROM assets a
        JOIN roles r ON r.id = a.role_id
        WHERE a.shot_id IS NOT NULL
        GROUP BY a.shot_id, r.id
        ORDER BY r.sort_order, r.name
    `).all();

    // Get role counts per sequence (assets directly on sequence)
    const seqRoles = db.prepare(`
        SELECT a.sequence_id, r.id as role_id, r.name as role_name, r.code as role_code,
               r.color as role_color, r.icon as role_icon, COUNT(a.id) as asset_count
        FROM assets a
        JOIN roles r ON r.id = a.role_id
        WHERE a.sequence_id IS NOT NULL
        GROUP BY a.sequence_id, r.id
        ORDER BY r.sort_order, r.name
    `).all();

    // Build tree
    const tree = projects.map(p => ({
        ...p,
        sequences: sequences.filter(s => s.project_id === p.id).map(s => ({
            ...s,
            roles: seqRoles.filter(sr => sr.sequence_id === s.id),
            shots: shots.filter(sh => sh.sequence_id === s.id).map(sh => ({
                ...sh,
                roles: shotRoles.filter(sr => sr.shot_id === sh.id)
            }))
        }))
    }));

    res.json(tree);
});

// GET /api/projects/:id — Get single project (access-checked, blacklist)
router.get('/:id', (req, res) => {
    const { hiddenIds } = resolveUserAccess(req);
    if (hiddenIds === null) return res.status(403).json({ error: 'No user selected' });

    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Non-admin: check if project is hidden from this user
    if (hiddenIds !== 'all' && hiddenIds.has(project.id)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const sequences = db.prepare(`
        SELECT s.*,
            (SELECT COUNT(*) FROM shots sh WHERE sh.sequence_id = s.id) as shot_count,
            (SELECT COUNT(*) FROM assets a WHERE a.sequence_id = s.id) as asset_count
        FROM sequences s
        WHERE s.project_id = ?
        ORDER BY s.sort_order, s.code
    `).all(project.id);

    const shots = db.prepare(`
        SELECT sh.id, sh.project_id, sh.sequence_id, sh.name, sh.code,
            (SELECT COUNT(*) FROM assets a WHERE a.shot_id = sh.id) as asset_count
        FROM shots sh WHERE sh.project_id = ? ORDER BY sh.sort_order, sh.code
    `).all(project.id);

    const shotRoles = db.prepare(`
        SELECT a.shot_id, r.id as role_id, r.name as role_name, r.code as role_code,
               r.color as role_color, r.icon as role_icon, COUNT(a.id) as asset_count
        FROM assets a
        JOIN roles r ON r.id = a.role_id
        WHERE a.project_id = ? AND a.shot_id IS NOT NULL
        GROUP BY a.shot_id, r.id
        ORDER BY r.name
    `).all(project.id);

    // Sequence-level roles (assets directly on sequence, no shot)
    const seqRoles = db.prepare(`
        SELECT a.sequence_id, r.id as role_id, r.name as role_name, r.code as role_code,
               r.color as role_color, r.icon as role_icon, COUNT(a.id) as asset_count
        FROM assets a
        JOIN roles r ON r.id = a.role_id
        WHERE a.project_id = ? AND a.sequence_id IS NOT NULL
        GROUP BY a.sequence_id, r.id
        ORDER BY r.name
    `).all(project.id);

    // Nest shots + roles under sequences, attach sequence-level roles
    for (const seq of sequences) {
        seq.shots = shots.filter(sh => sh.sequence_id === seq.id).map(sh => ({
            ...sh,
            roles: shotRoles.filter(sr => sr.shot_id === sh.id)
        }));
        seq.roles = seqRoles.filter(sr => sr.sequence_id === seq.id);
    }

    // Orphan shots (no sequence parent) — fallback rendering
    const orphanShots = shots.filter(sh => !sh.sequence_id).map(sh => ({
        ...sh,
        roles: shotRoles.filter(sr => sr.shot_id === sh.id)
    }));

    const assetCounts = db.prepare(`
        SELECT media_type, COUNT(*) as count 
        FROM assets WHERE project_id = ? 
        GROUP BY media_type
    `).all(project.id);

    const totalAssets = db.prepare('SELECT COUNT(*) as count FROM assets WHERE project_id = ?').get(project.id);

    // Parse naming_convention JSON
    if (project.naming_convention) {
        try { project.naming_convention = JSON.parse(project.naming_convention); } catch (_) {}
    }

    res.json({
        ...project,
        sequences,
        orphanShots,
        assetCounts,
        totalAssets: totalAssets.count,
    });
});

// POST /api/projects — Create project
router.post('/', (req, res) => {
    const { name, code, type = 'flexible', description = '', naming_convention, episode = '' } = req.body;

    if (!name || !code) {
        return res.status(400).json({ error: 'Name and code are required' });
    }

    // Validate code format (uppercase, no spaces)
    const cleanCode = code.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (cleanCode.length < 2) {
        return res.status(400).json({ error: 'Code must be at least 2 characters (letters, numbers, underscores)' });
    }

    const db = getDb();

    try {
        // Create project in database
        const conventionJson = naming_convention ? JSON.stringify(naming_convention) : null;
        const result = db.prepare(
            'INSERT INTO projects (name, code, type, description, naming_convention, episode) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(name, cleanCode, type, description, conventionJson, episode);

        // Create vault folder structure
        try {
            const vaultRoot = FileService.getVaultRoot();
            FileService.ensureDir(require('path').join(vaultRoot, cleanCode));
        } catch (e) {
            // Vault root not configured yet — that's OK
        }

        logActivity('project_created', 'project', result.lastInsertRowid, { name, code: cleanCode });

        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(project);
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'A project with that name or code already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/projects/:id — Update project
router.put('/:id', (req, res) => {
    const { name, description, type, naming_convention, episode } = req.body;
    const db = getDb();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const newEpisode = episode !== undefined ? episode : (project.episode || '');

    // If naming_convention is provided, update it too
    if (naming_convention !== undefined) {
        const conventionJson = naming_convention ? JSON.stringify(naming_convention) : null;
        db.prepare(`
            UPDATE projects SET name = ?, description = ?, type = ?, naming_convention = ?, episode = ?, updated_at = datetime('now') WHERE id = ?
        `).run(name || project.name, description ?? project.description, type || project.type, conventionJson, newEpisode, project.id);
    } else {
        db.prepare(`
            UPDATE projects SET name = ?, description = ?, type = ?, episode = ?, updated_at = datetime('now') WHERE id = ?
        `).run(name || project.name, description ?? project.description, type || project.type, newEpisode, project.id);
    }

    logActivity('project_updated', 'project', project.id, { name, type });

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    // Parse naming_convention JSON for the response
    if (updated.naming_convention) {
        try { updated.naming_convention = JSON.parse(updated.naming_convention); } catch (_) {}
    }
    res.json(updated);
});

// GET /api/projects/:id/naming-convention — Get project's naming convention
router.get('/:id/naming-convention', (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT naming_convention FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let convention = null;
    if (project.naming_convention) {
        try { convention = JSON.parse(project.naming_convention); } catch (_) {}
    }
    res.json({ convention });
});

// PUT /api/projects/:id/naming-convention — Update project's naming convention
router.put('/:id/naming-convention', (req, res) => {
    const { convention } = req.body;
    const db = getDb();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const conventionJson = convention ? JSON.stringify(convention) : null;
    db.prepare(`UPDATE projects SET naming_convention = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(conventionJson, project.id);

    logActivity('naming_convention_updated', 'project', project.id, { tokens: convention?.length || 0 });
    res.json({ success: true, convention });
});

// PUT /api/projects/:id/archive — Toggle archive status
router.put('/:id/archive', (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const newArchived = project.archived ? 0 : 1;
    db.prepare('UPDATE projects SET archived = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newArchived, project.id);

    logActivity(newArchived ? 'project_archived' : 'project_unarchived', 'project', project.id, { name: project.name });
    res.json({ success: true, archived: newArchived });
});

// DELETE /api/projects/:id — Delete project and all assets
router.delete('/:id', (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets WHERE project_id = ?').get(project.id);

    // Cascading delete handled by FK constraints
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    logActivity('project_deleted', 'project', project.id, { name: project.name, assetsDeleted: assetCount.count });

    res.json({ success: true, assetsDeleted: assetCount.count });
});


// ═══════════════════════════════════════════
//  SEQUENCES
// ═══════════════════════════════════════════

// GET /api/projects/:id/sequences
router.get('/:id/sequences', (req, res) => {
    const db = getDb();
    const sequences = db.prepare(`
        SELECT s.*,
            (SELECT COUNT(*) FROM shots sh WHERE sh.sequence_id = s.id) as shot_count,
            (SELECT COUNT(*) FROM assets a WHERE a.sequence_id = s.id) as asset_count
        FROM sequences s
        WHERE s.project_id = ?
        ORDER BY s.sort_order, s.code
    `).all(req.params.id);

    res.json(sequences);
});

// POST /api/projects/:id/sequences — Create sequence
router.post('/:id/sequences', (req, res) => {
    const { name, code, description = '', sort_order = 0 } = req.body;
    const projectId = parseInt(req.params.id);

    if (!name || !code) {
        return res.status(400).json({ error: 'Name and code are required' });
    }

    const db = getDb();
    try {
        const result = db.prepare(
            'INSERT INTO sequences (project_id, name, code, description, sort_order) VALUES (?, ?, ?, ?, ?)'
        ).run(projectId, name, code.toUpperCase(), description, sort_order);

        logActivity('sequence_created', 'sequence', result.lastInsertRowid, { name, code });

        const seq = db.prepare('SELECT * FROM sequences WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(seq);
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Sequence code already exists in this project' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/projects/:projectId/sequences/:seqId
router.put('/:projectId/sequences/:seqId', (req, res) => {
    const { name, description, sort_order } = req.body;
    const db = getDb();

    const seq = db.prepare('SELECT * FROM sequences WHERE id = ? AND project_id = ?')
        .get(req.params.seqId, req.params.projectId);
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });

    db.prepare('UPDATE sequences SET name = ?, description = ?, sort_order = ? WHERE id = ?')
        .run(name || seq.name, description ?? seq.description, sort_order ?? seq.sort_order, seq.id);

    const updated = db.prepare('SELECT * FROM sequences WHERE id = ?').get(seq.id);
    res.json(updated);
});

// DELETE /api/projects/:projectId/sequences/:seqId
router.delete('/:projectId/sequences/:seqId', (req, res) => {
    const db = getDb();
    const seq = db.prepare('SELECT * FROM sequences WHERE id = ? AND project_id = ?')
        .get(req.params.seqId, req.params.projectId);
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });

    // Unassign assets from all shots in this sequence, and from the sequence itself
    const shotIds = db.prepare('SELECT id FROM shots WHERE sequence_id = ?').all(seq.id).map(s => s.id);
    if (shotIds.length > 0) {
        db.prepare(`UPDATE assets SET shot_id = NULL WHERE shot_id IN (${shotIds.join(',')})`).run();
    }
    db.prepare('UPDATE assets SET sequence_id = NULL WHERE sequence_id = ?').run(seq.id);
    db.prepare('DELETE FROM shots WHERE sequence_id = ?').run(seq.id);
    db.prepare('DELETE FROM sequences WHERE id = ?').run(seq.id);

    logActivity('sequence_deleted', 'sequence', seq.id, { name: seq.name, code: seq.code, shotsDeleted: shotIds.length });
    res.json({ success: true });
});


// ═══════════════════════════════════════════
//  SHOTS
// ═══════════════════════════════════════════

// GET /api/projects/:projectId/sequences/:seqId/shots
router.get('/:projectId/sequences/:seqId/shots', (req, res) => {
    const db = getDb();
    const shots = db.prepare(`
        SELECT sh.*,
            (SELECT COUNT(*) FROM assets a WHERE a.shot_id = sh.id) as asset_count
        FROM shots sh
        WHERE sh.sequence_id = ? AND sh.project_id = ?
        ORDER BY sh.sort_order, sh.code
    `).all(req.params.seqId, req.params.projectId);

    res.json(shots);
});

// POST /api/projects/:projectId/sequences/:seqId/shots — Create shot
router.post('/:projectId/sequences/:seqId/shots', (req, res) => {
    const { name, code, description = '', sort_order = 0 } = req.body;
    const projectId = parseInt(req.params.projectId);
    const sequenceId = parseInt(req.params.seqId);

    if (!name || !code) {
        return res.status(400).json({ error: 'Name and code are required' });
    }

    const db = getDb();
    try {
        const result = db.prepare(
            'INSERT INTO shots (project_id, sequence_id, name, code, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(projectId, sequenceId, name, code.toUpperCase(), description, sort_order);

        logActivity('shot_created', 'shot', result.lastInsertRowid, { name, code });

        const shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(shot);
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Shot code already exists in this sequence' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/projects/:projectId/sequences/:seqId/shots/:shotId
router.put('/:projectId/sequences/:seqId/shots/:shotId', (req, res) => {
    const { name, description, sort_order } = req.body;
    const db = getDb();

    const shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(req.params.shotId);
    if (!shot) return res.status(404).json({ error: 'Shot not found' });

    db.prepare('UPDATE shots SET name = ?, description = ?, sort_order = ? WHERE id = ?')
        .run(name || shot.name, description ?? shot.description, sort_order ?? shot.sort_order, shot.id);

    const updated = db.prepare('SELECT * FROM shots WHERE id = ?').get(shot.id);
    res.json(updated);
});

// DELETE /api/projects/:projectId/sequences/:seqId/shots/:shotId
router.delete('/:projectId/sequences/:seqId/shots/:shotId', (req, res) => {
    const db = getDb();
    const shot = db.prepare('SELECT * FROM shots WHERE id = ? AND sequence_id = ?')
        .get(req.params.shotId, req.params.seqId);
    if (!shot) return res.status(404).json({ error: 'Shot not found' });

    // Unassign assets from this shot (don't delete them)
    db.prepare('UPDATE assets SET shot_id = NULL WHERE shot_id = ?').run(shot.id);
    db.prepare('DELETE FROM shots WHERE id = ?').run(shot.id);

    logActivity('shot_deleted', 'shot', shot.id, { name: shot.name, code: shot.code });
    res.json({ success: true });
});

module.exports = router;
