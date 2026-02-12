/**
 * MediaVault - Project Routes
 * CRUD for projects, sequences, and shots
 */

const express = require('express');
const router = express.Router();
const { getDb, logActivity } = require('../database');
const FileService = require('../services/FileService');

// ═══════════════════════════════════════════
//  PROJECTS
// ═══════════════════════════════════════════

// GET /api/projects — List all projects
router.get('/', (req, res) => {
    const db = getDb();
    const projects = db.prepare(`
        SELECT p.*,
            (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) as asset_count,
            (SELECT COUNT(*) FROM sequences s WHERE s.project_id = p.id) as sequence_count
        FROM projects p
        ORDER BY p.updated_at DESC
    `).all();

    res.json(projects);
});

// GET /api/projects/tree — Full tree: projects → sequences → shots → roles (with asset counts)
router.get('/tree', (req, res) => {
    const db = getDb();
    const projects = db.prepare(`
        SELECT p.id, p.name, p.code, p.type,
            (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) as asset_count
        FROM projects p ORDER BY p.name
    `).all();

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

    // Build tree
    const tree = projects.map(p => ({
        ...p,
        sequences: sequences.filter(s => s.project_id === p.id).map(s => ({
            ...s,
            shots: shots.filter(sh => sh.sequence_id === s.id).map(sh => ({
                ...sh,
                roles: shotRoles.filter(sr => sr.shot_id === sh.id)
            }))
        }))
    }));

    res.json(tree);
});

// GET /api/projects/:id — Get single project with sequences/shots
router.get('/:id', (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sequences = db.prepare(`
        SELECT s.*,
            (SELECT COUNT(*) FROM shots sh WHERE sh.sequence_id = s.id) as shot_count,
            (SELECT COUNT(*) FROM assets a WHERE a.sequence_id = s.id) as asset_count
        FROM sequences s
        WHERE s.project_id = ?
        ORDER BY s.sort_order, s.code
    `).all(project.id);

    const assetCounts = db.prepare(`
        SELECT media_type, COUNT(*) as count 
        FROM assets WHERE project_id = ? 
        GROUP BY media_type
    `).all(project.id);

    const totalAssets = db.prepare('SELECT COUNT(*) as count FROM assets WHERE project_id = ?').get(project.id);

    res.json({
        ...project,
        sequences,
        assetCounts,
        totalAssets: totalAssets.count,
    });
});

// POST /api/projects — Create project
router.post('/', (req, res) => {
    const { name, code, type = 'flexible', description = '' } = req.body;

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
        const result = db.prepare(
            'INSERT INTO projects (name, code, type, description) VALUES (?, ?, ?, ?)'
        ).run(name, cleanCode, type, description);

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
    const { name, description, type } = req.body;
    const db = getDb();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    db.prepare(`
        UPDATE projects SET name = ?, description = ?, type = ?, updated_at = datetime('now') WHERE id = ?
    `).run(name || project.name, description ?? project.description, type || project.type, project.id);

    logActivity('project_updated', 'project', project.id, { name, type });

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    res.json(updated);
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
