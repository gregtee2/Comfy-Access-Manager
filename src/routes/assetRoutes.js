/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Asset Routes
 * Import, manage, rename, search, and serve media assets
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb, getSetting, logActivity } = require('../database');
const FileService = require('../services/FileService');
const ThumbnailService = require('../services/ThumbnailService');
const MediaInfoService = require('../services/MediaInfoService');
const { detectMediaType, isMediaFile } = require('../utils/mediaTypes');
const { generateVaultName, getVaultDirectory, generateFromConvention, getNextVersion } = require('../utils/naming');
const { resolveFilePath, getAllPathVariants } = require('../utils/pathResolver');

// Multer for file uploads (temp storage)
const upload = multer({
    dest: path.join(__dirname, '..', '..', 'data', 'uploads'),
    limits: { fileSize: 50 * 1024 * 1024 * 1024 }, // 50GB limit
});


// ═══════════════════════════════════════════
//  POLL (lightweight check for new assets)
// ═══════════════════════════════════════════

// GET /api/assets/poll — Return total asset count + latest timestamp for auto-refresh
router.get('/poll', (req, res) => {
    const { project_id } = req.query;
    const db = getDb();

    let query = 'SELECT COUNT(*) as count, MAX(created_at) as latest, MAX(updated_at) as last_updated FROM assets';
    const params = [];
    if (project_id) {
        query += ' WHERE project_id = ?';
        params.push(project_id);
    }

    const row = db.prepare(query).get(...params);
    res.json({ count: row.count || 0, latest: row.latest || null, last_updated: row.last_updated || null });
});

// ═══════════════════════════════════════════
//  LIST / SEARCH ASSETS
// ═══════════════════════════════════════════

// GET /api/assets — List assets with filtering
router.get('/', (req, res) => {
    const { project_id, sequence_id, shot_id, media_type, search, starred, unassigned, unassigned_shot, role_id, limit = 10000, offset = 0 } = req.query;
    const db = getDb();

    let query = `
        SELECT a.*, 
            p.name as project_name, p.code as project_code,
            s.name as sequence_name, s.code as sequence_code,
            sh.name as shot_name, sh.code as shot_code,
            r.name as role_name, r.code as role_code, r.color as role_color, r.icon as role_icon
        FROM assets a
        LEFT JOIN projects p ON p.id = a.project_id
        LEFT JOIN sequences s ON s.id = a.sequence_id
        LEFT JOIN shots sh ON sh.id = a.shot_id
        LEFT JOIN roles r ON r.id = a.role_id
        WHERE 1=1
    `;
    const params = [];

    if (project_id) { query += ' AND a.project_id = ?'; params.push(project_id); }
    if (unassigned === '1') { query += ' AND a.sequence_id IS NULL'; }
    else if (sequence_id) { query += ' AND a.sequence_id = ?'; params.push(sequence_id); }
    if (unassigned_shot === '1') { query += ' AND a.shot_id IS NULL'; }
    else if (shot_id) { query += ' AND a.shot_id = ?'; params.push(shot_id); }
    if (media_type) { query += ' AND a.media_type = ?'; params.push(media_type); }
    if (role_id) { query += ' AND a.role_id = ?'; params.push(role_id); }
    if (starred === '1') { query += ' AND a.starred = 1'; }
    if (search) {
        query += ' AND (a.vault_name LIKE ? OR a.original_name LIKE ? OR a.notes LIKE ? OR a.tags LIKE ?)';
        const term = `%${search}%`;
        params.push(term, term, term, term);
    }

    // Count matching assets BEFORE applying LIMIT/OFFSET
    const countQuery = query.replace(/SELECT a\.\*.*?FROM/s, 'SELECT COUNT(*) as count FROM');
    const filteredTotal = db.prepare(countQuery).get(...params).count;

    query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const assets = db.prepare(query).all(...params);
    // Resolve file paths so the frontend sees platform-correct absolute paths
    for (const a of assets) {
        if (a.file_path) a.file_path = resolveFilePath(a.file_path);
    }
    const total = db.prepare('SELECT COUNT(*) as count FROM assets').get();

    res.json({ assets, total: total.count, filteredTotal });
});

// ═══════════════════════════════════════════
//  BROWSE FILESYSTEM (for import dialog)
//  MUST be above /:id to avoid wildcard match
// ═══════════════════════════════════════════

router.get('/browse', (req, res) => {
    const { dir, folders_only } = req.query;

    if (!dir) {
        // Return drive roots (Windows: C:\, D:\, etc. / macOS: /, /Volumes/..., etc.)
        const drives = FileService.getDrives();
        res.json({ path: '', entries: drives.map(d => {
            // getDrives() now returns objects with { path, name, type, icon }
            if (typeof d === 'object') {
                return { name: d.name, path: d.path, isDirectory: true, icon: d.icon, driveType: d.type, server: d.server };
            }
            // Fallback for plain string format
            const isVolume = d.startsWith('/Volumes/') || d.startsWith('/mnt/') || d.startsWith('/media/');
            const name = isVolume ? d.split('/').pop() : d;
            const icon = isVolume ? '🌐' : (d === '/' ? '💻' : '💾');
            return { name, path: d, isDirectory: true, icon };
        }) });
        return;
    }

    let entries = FileService.browseDirectory(dir);
    if (folders_only === '1') {
        entries = entries.filter(e => e.isDirectory);
    }
    const parentDir = path.dirname(dir);

    // If parentDir === dir, we're at a filesystem root (e.g. C:\ or /).
    // Return parent='' to signal "go back to drive/volume list".
    const isRoot = parentDir === dir || parentDir === '.';
    res.json({
        path: dir,
        parent: isRoot ? '' : parentDir,
        entries,
    });
});

// ═══════════════════════════════════════════
//  CREATE FOLDER (for folder picker "New Folder" button)
//  MUST be above /:id to avoid wildcard match
// ═══════════════════════════════════════════

router.post('/create-folder', (req, res) => {
    const { parentDir, folderName } = req.body;

    if (!parentDir || !folderName) {
        return res.status(400).json({ error: 'parentDir and folderName are required' });
    }

    // Sanitize folder name — strip path separators and dangerous characters
    const sanitized = folderName.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!sanitized) {
        return res.status(400).json({ error: 'Invalid folder name' });
    }

    const newPath = path.join(parentDir, sanitized);

    try {
        if (fs.existsSync(newPath)) {
            return res.status(409).json({ error: 'Folder already exists', path: newPath });
        }

        fs.mkdirSync(newPath, { recursive: true });
        res.json({ success: true, path: newPath, name: sanitized });
    } catch (err) {
        res.status(500).json({ error: `Failed to create folder: ${err.message}` });
    }
});


// ═══════════════════════════════════════════
//  PREVIEW NAME — preview what the rename would produce
//  MUST be above /:id to avoid wildcard match
// ═══════════════════════════════════════════

router.post('/preview-name', (req, res) => {
    const { originalName, projectCode, sequenceCode, sequenceName, shotCode, shotName, roleCode, takeNumber, customName, template } = req.body;

    if (!originalName || !projectCode) {
        return res.status(400).json({ error: 'originalName and projectCode required' });
    }

    const { type: mediaType } = detectMediaType(originalName);

    const { vaultName } = generateVaultName({
        originalName,
        projectCode,
        sequenceCode,
        sequenceName,
        shotCode,
        shotName,
        roleCode,
        takeNumber,
        mediaType,
        customName,
        template,
    });

    res.json({ vaultName, mediaType });
});


// ═══════════════════════════════════════════
//  RENAME TO HIERARCHY — regenerate vault names from current assignment
//  MUST be above /:id to avoid wildcard match
// ═══════════════════════════════════════════

// POST /api/assets/rename-to-hierarchy — Preview or execute bulk rename
// body: { ids: [1,2,3], preview: true|false }
router.post('/rename-to-hierarchy', (req, res) => {
    const db = getDb();
    const { ids, preview } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array required' });
    }

    const vaultRoot = getSetting('vault_root');
    if (!vaultRoot && !preview) {
        return res.status(500).json({ error: 'Vault root not configured' });
    }

    const results = [];
    let renamed = 0;
    const errors = [];

    // Track names assigned within this batch to avoid collisions between assets
    const usedPaths = new Set();

    for (const id of ids) {
        try {
            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
            if (!asset) { errors.push({ id, error: 'Not found' }); continue; }

            // Never rename linked/registered-in-place assets — their paths are externally managed
            if (asset.is_linked) {
                results.push({ id, oldName: asset.vault_name, newName: asset.vault_name, skipped: true, reason: 'linked' });
                continue;
            }

            // Look up current hierarchy
            const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(asset.project_id);
            if (!project) { errors.push({ id, error: 'No project' }); continue; }

            const sequence = asset.sequence_id
                ? db.prepare('SELECT * FROM sequences WHERE id = ?').get(asset.sequence_id)
                : null;
            const shot = asset.shot_id
                ? db.prepare('SELECT * FROM shots WHERE id = ?').get(asset.shot_id)
                : null;
            const role = asset.role_id
                ? db.prepare('SELECT * FROM roles WHERE id = ?').get(asset.role_id)
                : null;

            // Check if project has a naming convention (Shot Builder)
            let namingConvention = null;
            if (project.naming_convention) {
                try { namingConvention = JSON.parse(project.naming_convention); } catch (_) {}
            }

            const ext = path.extname(asset.vault_name || asset.original_name).toLowerCase();
            const { type: mediaType } = detectMediaType(asset.original_name || asset.vault_name);
            const dir = path.dirname(asset.file_path);

            // Try increasing version/counter until we find a unique name
            // This handles both ShotGrid templates ({version}) and legacy templates ({counter})
            let newVaultName = null;
            for (let attempt = 1; attempt <= 999; attempt++) {
                let candidateName = null;

                if (namingConvention && namingConvention.length > 0) {
                    const convResult = generateFromConvention(namingConvention, {
                        project: project.code,
                        episode: project.episode || '',
                        sequence: sequence?.name || sequence?.code || '',
                        shot: shot?.name || shot?.code || '',
                        role: role?.code || '',
                        version: attempt,
                        counter: attempt,
                    }, ext);
                    if (convResult) candidateName = convResult.vaultName;
                }

                if (!candidateName) {
                    const nameResult = generateVaultName({
                        originalName: asset.original_name || asset.vault_name,
                        projectCode: project.code,
                        sequenceCode: sequence?.code,
                        sequenceName: sequence?.name,
                        shotCode: shot?.code,
                        shotName: shot?.name,
                        roleCode: role?.code,
                        takeNumber: 1,
                        mediaType,
                        version: attempt,
                        counter: attempt,
                    });
                    candidateName = nameResult.vaultName;
                }

                const candidateFullPath = path.join(dir, candidateName);
                const normalizedKey = candidateFullPath.toLowerCase();

                // Check 1: not already claimed by another asset in this batch
                if (usedPaths.has(normalizedKey)) continue;

                // Check 2: doesn't exist on disk (or is the same file we're renaming)
                if (fs.existsSync(candidateFullPath) &&
                    path.resolve(candidateFullPath) !== path.resolve(asset.file_path)) {
                    continue;
                }

                newVaultName = candidateName;
                usedPaths.add(normalizedKey);
                break;
            }

            if (!newVaultName) {
                errors.push({ id, error: 'Could not find unique name after 999 attempts' });
                continue;
            }

            // If name is already the same, skip
            if (newVaultName === asset.vault_name) {
                results.push({ id, oldName: asset.vault_name, newName: newVaultName, skipped: true });
                continue;
            }

            results.push({ id, oldName: asset.vault_name, newName: newVaultName, skipped: false });

            if (!preview) {
                const oldPath = asset.file_path;
                const newPath = path.join(dir, newVaultName);

                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                }

                const relativePath = vaultRoot ? path.relative(vaultRoot, newPath) : newPath;

                db.prepare(`
                    UPDATE assets SET vault_name = ?, file_path = ?, relative_path = ?, updated_at = datetime('now')
                    WHERE id = ?
                `).run(newVaultName, newPath, relativePath, id);

                renamed++;
            }
        } catch (err) {
            errors.push({ id, error: err.message });
        }
    }

    if (!preview) {
        logActivity('bulk_rename_hierarchy', 'asset', null, { count: renamed, total: ids.length });
    }

    res.json({ preview: !!preview, results, renamed, skipped: results.filter(r => r.skipped).length, errors: errors.length, errors_detail: errors });
});


// ═══════════════════════════════════════════
//  STRING-PATH GET ROUTES — MUST be above /:id to avoid wildcard match
// ═══════════════════════════════════════════

// GET /api/assets/viewer-status — Which external viewers are installed
router.get('/viewer-status', (req, res) => {
    res.json({
        rv: !!findRV(),
        rvpush: !!findRvPush(),
        rvRunning: isRvRunning(),
    });
});

// GET /api/assets/rv-status — Check if RV is running and rvpush is available
router.get('/rv-status', (req, res) => {
    res.json({
        rvFound: !!findRV(),
        rvpushFound: !!findRvPush(),
        rvRunning: isRvRunning()
    });
});

// GET /api/assets/:id/shot-siblings — Find related assets with hierarchical fallback
// Fallback: shot → sequence → project
router.get('/:id/shot-siblings', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT id, shot_id, sequence_id, project_id, vault_name FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    function groupByRole(rows) {
        const roleMap = new Map();
        for (const s of rows) {
            const key = s.role_id || 0;
            if (!roleMap.has(key)) {
                roleMap.set(key, {
                    id: s.role_id, name: s.role_name || 'Unassigned',
                    code: s.role_code || '', icon: s.role_icon || '', assets: []
                });
            }
            roleMap.get(key).assets.push({
                id: s.id, vault_name: s.vault_name, version: s.version, file_ext: s.file_ext
            });
        }
        return [...roleMap.values()];
    }

    const baseCols = `a.id, a.vault_name, a.version, a.file_ext, a.media_type, a.file_size,
               a.role_id, r.name AS role_name, r.code AS role_code, r.icon AS role_icon, r.color AS role_color,
               r.sort_order AS role_sort`;
    const baseJoin = `FROM assets a LEFT JOIN roles r ON a.role_id = r.id`;
    const baseOrder = `ORDER BY r.sort_order ASC, r.name ASC, a.version DESC`;

    // 1) Shot-level
    if (asset.shot_id) {
        const siblings = db.prepare(`SELECT ${baseCols} ${baseJoin} WHERE a.shot_id = ? AND a.project_id = ? AND a.id != ? ${baseOrder}`)
            .all(asset.shot_id, asset.project_id, asset.id);
        if (siblings.length > 0) return res.json({ scope: 'shot', roles: groupByRole(siblings) });
    }

    // 2) Sequence-level
    if (asset.sequence_id) {
        const seqSiblings = db.prepare(`SELECT ${baseCols} ${baseJoin} WHERE a.sequence_id = ? AND a.project_id = ? AND a.id != ? ${baseOrder}`)
            .all(asset.sequence_id, asset.project_id, asset.id);
        if (seqSiblings.length > 0) return res.json({ scope: 'sequence', roles: groupByRole(seqSiblings) });
    }

    // 3) Project-level
    if (asset.project_id) {
        const projSiblings = db.prepare(`SELECT ${baseCols} ${baseJoin} WHERE a.project_id = ? AND a.id != ? ${baseOrder}`)
            .all(asset.project_id, asset.id);
        if (projSiblings.length > 0) return res.json({ scope: 'project', roles: groupByRole(projSiblings) });
    }

    res.json({ scope: 'none', roles: [] });
});

// GET /api/assets/compare-targets-by-path — Find related assets with hierarchical fallback
// Used by RV plugin to find sibling versions for the currently loaded file
// Fallback: shot → sequence → project
router.get('/compare-targets-by-path', (req, res) => {
    const db = getDb();
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Provide ?path= parameter' });

    // Try all possible path variants (Mac path ↔ Windows path ↔ Linux path)
    const variants = getAllPathVariants(filePath);
    let asset = null;
    const stmt = db.prepare(`
        SELECT id, shot_id, sequence_id, project_id, role_id, vault_name
        FROM assets
        WHERE replace(file_path, '\\', '/') = ?
    `);
    for (const variant of variants) {
        asset = stmt.get(variant);
        if (asset) break;
    }
    if (!asset) return res.status(404).json({ error: 'Asset not found in vault' });

    // Helper to group results by role — includes current asset marked with is_current
    function groupByRole(rows, currentId) {
        const roleMap = new Map();
        for (const s of rows) {
            const key = s.role_id || 0;
            if (!roleMap.has(key)) {
                roleMap.set(key, {
                    id: s.role_id,
                    name: s.role_name || 'Unassigned',
                    code: s.role_code || '',
                    icon: s.role_icon || '',
                    assets: []
                });
            }
            roleMap.get(key).assets.push({
                id: s.id, vault_name: s.vault_name, version: s.version,
                file_ext: s.file_ext, file_path: resolveFilePath(s.file_path),
                created_at: s.created_at || null,
                shot_name: s.shot_name || null, seq_name: s.seq_name || null,
                is_current: s.id === currentId
            });
        }
        return [...roleMap.values()];
    }

    // Build hierarchy tree for the dialog's left panel
    function buildHierarchy(projectId) {
        const proj = db.prepare('SELECT id, name, code FROM projects WHERE id = ?').get(projectId);
        if (!proj) return null;
        const seqs = db.prepare('SELECT id, name, code FROM sequences WHERE project_id = ? ORDER BY sort_order, name').all(projectId);
        const shots = db.prepare('SELECT id, sequence_id, name, code FROM shots WHERE project_id = ? ORDER BY sort_order, code').all(projectId);
        return {
            ...proj,
            sequences: seqs.map(s => ({
                ...s,
                shots: shots.filter(sh => sh.sequence_id === s.id)
            }))
        };
    }

    // All roles for filter panel
    const allRoles = db.prepare('SELECT id, name, code, icon, color FROM roles ORDER BY sort_order, name').all();
    const hierarchy = asset.project_id ? buildHierarchy(asset.project_id) : null;

    const baseCols = `a.id, a.vault_name, a.version, a.file_ext, a.media_type, a.file_size, a.file_path, a.created_at,
               a.role_id, r.name AS role_name, r.code AS role_code, r.icon AS role_icon, r.color AS role_color,
               r.sort_order AS role_sort`;
    const baseJoin = `FROM assets a LEFT JOIN roles r ON a.role_id = r.id`;
    const baseOrder = `ORDER BY r.sort_order ASC, r.name ASC, a.version DESC`;

    // 1) Try shot-level siblings (includes current asset — no id != ? exclusion)
    if (asset.shot_id) {
        const siblings = db.prepare(`
            SELECT ${baseCols} ${baseJoin}
            WHERE a.shot_id = ? AND a.project_id = ?
            ${baseOrder}
        `).all(asset.shot_id, asset.project_id);
        if (siblings.length > 0) {
            return res.json({ asset: { id: asset.id, vault_name: asset.vault_name }, scope: 'shot', roles: groupByRole(siblings, asset.id), allRoles, hierarchy });
        }
    }

    // 2) Fallback: sequence-level siblings (all shots in same sequence)
    if (asset.sequence_id) {
        const seqSiblings = db.prepare(`
            SELECT ${baseCols}, sh.name AS shot_name ${baseJoin}
            LEFT JOIN shots sh ON a.shot_id = sh.id
            WHERE a.sequence_id = ? AND a.project_id = ?
            ${baseOrder}
        `).all(asset.sequence_id, asset.project_id);
        if (seqSiblings.length > 0) {
            return res.json({ asset: { id: asset.id, vault_name: asset.vault_name }, scope: 'sequence', roles: groupByRole(seqSiblings, asset.id), allRoles, hierarchy });
        }
    }

    // 3) Fallback: project-level (all assets in the project)
    if (asset.project_id) {
        const projSiblings = db.prepare(`
            SELECT ${baseCols}, sh.name AS shot_name, sq.name AS seq_name ${baseJoin}
            LEFT JOIN shots sh ON a.shot_id = sh.id
            LEFT JOIN sequences sq ON a.sequence_id = sq.id
            WHERE a.project_id = ?
            ${baseOrder}
        `).all(asset.project_id);
        if (projSiblings.length > 0) {
            return res.json({ asset: { id: asset.id, vault_name: asset.vault_name }, scope: 'project', roles: groupByRole(projSiblings, asset.id), allRoles, hierarchy });
        }
    }

    // Nothing found at any level
    res.json({ asset: { id: asset.id, vault_name: asset.vault_name }, scope: 'none', roles: [], allRoles, hierarchy });
});


// GET /api/assets/overlay-info — Lightweight metadata for RV overlay burn-in
// Used by RV plugin to show filename, version, role, project/shot info on screen
router.get('/overlay-info', (req, res) => {
    const db = getDb();
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ found: false, error: 'Provide ?path= parameter' });

    const variants = getAllPathVariants(filePath);
    const stmt = db.prepare(`
        SELECT a.id, a.vault_name, a.original_name, a.version, a.file_ext,
               a.media_type, a.created_at, a.status,
               r.name AS role_name, r.code AS role_code,
               p.name AS project_name, p.code AS project_code,
               seq.name AS sequence_name, seq.code AS sequence_code,
               sh.name AS shot_name, sh.code AS shot_code
        FROM assets a
        LEFT JOIN roles r ON a.role_id = r.id
        LEFT JOIN projects p ON a.project_id = p.id
        LEFT JOIN sequences seq ON a.sequence_id = seq.id
        LEFT JOIN shots sh ON a.shot_id = sh.id
        WHERE replace(a.file_path, '\\', '/') = ?
        LIMIT 1
    `);

    let asset = null;
    for (const variant of variants) {
        asset = stmt.get(variant);
        if (asset) break;
    }

    if (!asset) {
        return res.json({ found: false, vault_name: require('path').basename(filePath) });
    }

    res.json({
        found: true,
        asset_id: asset.id,
        vault_name: asset.vault_name,
        original_name: asset.original_name,
        version: asset.version,
        file_ext: asset.file_ext,
        media_type: asset.media_type,
        created_at: asset.created_at || null,
        role_name: asset.role_name || null,
        role_code: asset.role_code || null,
        project_name: asset.project_name || null,
        project_code: asset.project_code || null,
        sequence_name: asset.sequence_name || null,
        shot_name: asset.shot_name || null,
        status: asset.status || 'WIP'
    });
});


// GET /api/assets/:id — Single asset with full details
router.get('/:id', (req, res) => {
    const db = getDb();
    const asset = db.prepare(`
        SELECT a.*, 
            p.name as project_name, p.code as project_code,
            s.name as sequence_name, s.code as sequence_code,
            sh.name as shot_name, sh.code as shot_code
        FROM assets a
        LEFT JOIN projects p ON p.id = a.project_id
        LEFT JOIN sequences s ON s.id = a.sequence_id
        LEFT JOIN shots sh ON sh.id = a.shot_id
        WHERE a.id = ?
    `).get(req.params.id);

    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    asset.file_path = resolveFilePath(asset.file_path);
    res.json(asset);
});

// PUT /api/assets/:id/status — Update asset status
router.put('/:id/status', (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status required' });
    
    const validStatuses = ['WIP', 'Review', 'Approved', 'Final', 'Reject'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const db = getDb();
    const result = db.prepare("UPDATE assets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
    
    if (result.changes === 0) return res.status(404).json({ error: 'Asset not found' });
    
    logActivity('update_status', 'asset', req.params.id, JSON.stringify({ status }));
    res.json({ success: true, status });
});


// ═══════════════════════════════════════════
//  IMPORT ASSETS
// ═══════════════════════════════════════════

// POST /api/assets/import — Import files from filesystem paths
// Supports: individual files, frame sequences (auto-detected), and derivative generation
// Add ?stream=1 for SSE progress events during large imports
router.post('/import', async (req, res) => {
    const { files, project_id, sequence_id, shot_id, role_id, take_number, custom_name, template } = req.body;

    if (!files || !files.length) {
        return res.status(400).json({ error: 'No files provided' });
    }
    if (!project_id) {
        return res.status(400).json({ error: 'Project ID required' });
    }

    // ── SSE progress streaming (opt-in via ?stream=1) ──
    const streaming = req.query.stream === '1';
    if (streaming) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
    }
    const totalFiles = files.length;
    let importedSoFar = 0;
    function sendProgress(filename) {
        importedSoFar++;
        if (streaming) {
            res.write(`data: ${JSON.stringify({ current: importedSoFar, total: totalFiles, file: filename })}\n\n`);
        }
    }

    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let sequence = null, shot = null, role = null;
    if (sequence_id) sequence = db.prepare('SELECT * FROM sequences WHERE id = ?').get(sequence_id);
    if (shot_id) shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(shot_id);
    if (role_id) role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);

    // Load project's naming convention (if set via Shot Builder)
    let namingConvention = null;
    if (project.naming_convention) {
        try { namingConvention = JSON.parse(project.naming_convention); } catch (_) {}
    }
    // Accept wildcard values from the import request (for "ask at import" wildcards)
    const wildcardValues = req.body.wildcard_values || {};

    const results = [];
    const errors = [];
    const derivativeJobIds = [];

    const registerInPlace = !!req.body.register_in_place;
    const keepOriginalNames = !!req.body.keep_original_names;
    const generateDerivatives = !!req.body.generate_derivatives;
    const derivativeFormats = Array.isArray(req.body.derivative_formats) ? req.body.derivative_formats : [];
    const derivativeFps = parseInt(req.body.derivative_fps) || 24;

    // ── Step 1: Detect frame sequences ──
    const { detectSequences, buildFrameFilename, buildVaultPattern } = require('../utils/sequenceDetector');
    const { sequences: detectedSeqs, singles } = detectSequences(files);

    // ── Step 2: Import detected frame sequences as single assets ──
    let seqCounter = 0;  // Unique counter for each sequence vault name
    for (const seq of detectedSeqs) {
        seqCounter++;
        try {
            // Validate all frames exist
            const missingFrames = seq.files.filter(f => !fs.existsSync(f));
            if (missingFrames.length > 0) {
                errors.push({ file: `${seq.baseName}${seq.ext} (sequence)`, error: `${missingFrames.length} frames not found` });
                continue;
            }

            // Generate ONE vault name for the whole sequence (base name without frame number)
            const seqOriginalName = `${seq.baseName}${seq.ext}`;
            const { type: mediaType } = detectMediaType(seqOriginalName);

            let vaultBaseName, vaultExt;
            if (keepOriginalNames) {
                // Keep original sequence naming
                vaultBaseName = seq.baseName;
                vaultExt = seq.ext;
            } else if (namingConvention && namingConvention.length > 0) {
                // Use project's Shot Builder convention
                const convResult = generateFromConvention(namingConvention, {
                    project: project.code,
                    sequence: sequence?.name || sequence?.code,
                    shot: shot?.name || shot?.code,
                    role: role?.code,
                    version: seqCounter,
                    take: take_number || 1,
                    counter: seqCounter,
                    wildcards: wildcardValues,
                }, seq.ext);
                if (convResult) {
                    vaultBaseName = path.basename(convResult.vaultName, convResult.ext);
                    vaultExt = convResult.ext;
                } else {
                    // Fallback to legacy naming
                    const naming = require('../utils/naming');
                    const nameResult = naming.generateVaultName({
                        originalName: seqOriginalName,
                        projectCode: project.code,
                        sequenceCode: sequence?.code,
                        sequenceName: sequence?.name,
                        shotCode: shot?.code,
                        shotName: shot?.name,
                        roleCode: role?.code,
                        takeNumber: take_number || 1,
                        mediaType,
                        customName: custom_name || null,
                        counter: seqCounter,
                    });
                    vaultBaseName = path.basename(nameResult.vaultName, nameResult.ext);
                    vaultExt = nameResult.ext;
                }
            } else {
                const naming = require('../utils/naming');
                const nameResult = naming.generateVaultName({
                    originalName: seqOriginalName,
                    projectCode: project.code,
                    sequenceCode: sequence?.code,
                    sequenceName: sequence?.name,
                    shotCode: shot?.code,
                    shotName: shot?.name,
                    roleCode: role?.code,
                    takeNumber: take_number || 1,
                    mediaType,
                    customName: custom_name || null,
                    counter: seqCounter,
                });
                // Base name without extension: "EDA1500_comp_v001"
                vaultBaseName = path.basename(nameResult.vaultName, nameResult.ext);
                vaultExt = nameResult.ext;  // ".exr"
            }

            let firstFramePath, framePatternString, totalSize = 0;

            if (registerInPlace) {
                // Register in place: just catalog the sequence
                firstFramePath = path.resolve(seq.files[0]);
                framePatternString = `${seq.baseName}${seq.separator}%0${seq.digits}d${seq.ext}`;

                // Sum file sizes
                for (const fp of seq.files) {
                    try { totalSize += fs.statSync(fp).size; } catch {}
                }
            } else {
                // Normal import: move/copy all frames into vault
                const vaultRoot = FileService.getVaultRoot();
                const { getVaultDirectory: getVaultDir } = require('../utils/naming');
                const vaultDir = getVaultDir(vaultRoot, project.code, mediaType, sequence?.code, shot?.code);
                FileService.ensureDir(vaultDir);

                // Collision resolution: ensure this base name doesn't already
                // have frame files in the vault (e.g. from a previous import)
                const naming = require('../utils/naming');
                const testFrame = buildFrameFilename(vaultBaseName, seq.frameStart, seq.digits, vaultExt);

                // Put each sequence inside its own named subfolder so multiple
                // sequences don't dump hundreds of frames into the same directory.
                // e.g. Project/SQ010/SH020/image/render_comp_v001/render_comp_v001.0001.exr
                let seqDir = path.join(vaultDir, vaultBaseName);
                if (fs.existsSync(path.join(seqDir, testFrame))) {
                    const resolved = naming.resolveCollision(
                        path.join(vaultDir, `${vaultBaseName}${vaultExt}`)
                    );
                    vaultBaseName = path.basename(resolved, vaultExt);
                    seqDir = path.join(vaultDir, vaultBaseName);
                }
                FileService.ensureDir(seqDir);

                for (let fi = 0; fi < seq.files.length; fi++) {
                    const srcFrame = seq.files[fi];
                    const frameNum = seq.frameStart + fi;
                    const frameFilename = buildFrameFilename(vaultBaseName, frameNum, seq.digits, vaultExt);
                    const destPath = path.join(seqDir, frameFilename);

                    if (req.body.keep_originals) {
                        fs.copyFileSync(srcFrame, destPath);
                    } else {
                        try {
                            fs.renameSync(srcFrame, destPath);
                        } catch (err) {
                            if (err.code === 'EXDEV') {
                                fs.copyFileSync(srcFrame, destPath);
                                fs.unlinkSync(srcFrame);
                            } else throw err;
                        }
                    }

                    totalSize += fs.statSync(destPath).size;
                    if (fi === 0) firstFramePath = destPath;
                }

                framePatternString = buildVaultPattern(vaultBaseName, seq.digits, vaultExt);
            }

            // Probe first frame for dimensions
            const info = await MediaInfoService.probe(firstFramePath);

            // Compute relative path
            const vaultRoot = registerInPlace ? '' : FileService.getVaultRoot();
            const relativePath = vaultRoot ? path.relative(vaultRoot, firstFramePath) : firstFramePath;

            // Insert ONE asset row for the entire sequence
            const vaultName = `${vaultBaseName}${vaultExt}`;
            const result = db.prepare(`
                INSERT INTO assets (
                    project_id, sequence_id, shot_id, role_id,
                    original_name, vault_name, file_path, relative_path,
                    media_type, file_ext, file_size,
                    width, height, duration, fps, codec,
                    take_number, version, is_linked,
                    is_sequence, frame_start, frame_end, frame_count, frame_pattern,
                    status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
                project.id,
                sequence?.id || null,
                shot?.id || null,
                role_id || null,
                seqOriginalName,
                vaultName,
                firstFramePath,
                relativePath,
                mediaType,
                vaultExt,
                totalSize,
                info.width, info.height,
                null,  // duration: calculated from frame_count / fps if needed
                null,  // fps: set by user or default
                info.codec,
                take_number || 1,
                1,
                registerInPlace ? 1 : 0,
                1,                  // is_sequence = true
                seq.frameStart,
                seq.frameEnd,
                seq.frameCount,
                framePatternString
            );

            const assetId = result.lastInsertRowid;

            // Generate thumbnail from first frame
            const autoThumb = getSetting('auto_thumbnail') !== 'false';
            if (autoThumb) {
                try {
                    const thumbPath = await ThumbnailService.generate(firstFramePath, assetId);
                    if (thumbPath) {
                        db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, assetId);
                    }
                } catch (thumbErr) {
                    console.error(`[Import] Thumbnail failed for sequence ${vaultName}:`, thumbErr.message);
                }
            }

            logActivity('asset_imported', 'asset', assetId, {
                original: seqOriginalName,
                vault: vaultName,
                project: project.name,
                isSequence: true,
                frameCount: seq.frameCount,
                frameRange: `${seq.frameStart}-${seq.frameEnd}`,
            });

            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
            results.push(asset);

            // Broadcast to spokes (hub mode)
            req.app.locals.broadcastChange?.('assets', 'insert', { record: asset });

            sendProgress(`${seqOriginalName} (${seq.frameCount} frames)`);

            // Queue derivatives for this sequence if requested
            if (generateDerivatives && derivativeFormats.length > 0) {
                const TranscodeService = require('../services/TranscodeService');
                for (const fmt of derivativeFormats) {
                    const jobId = TranscodeService.queueDerivative(assetId, fmt, {
                        fps: derivativeFps,
                        _totalFrames: seq.frameCount,
                    });
                    derivativeJobIds.push(jobId);
                }
            }

        } catch (err) {
            errors.push({ file: `${seq.baseName}${seq.ext} (${seq.frameCount} frames)`, error: err.message });
            sendProgress(`${seq.baseName}${seq.ext} (error)`);
        }
    }

    // ── Step 3: Import remaining single files normally ──
    // Track version numbers per (sequence, role) so batch imports get v001, v002, v003…
    let _versionTracker = {};
    for (let i = 0; i < singles.length; i++) {
        const filePath = singles[i];

        try {
            if (!fs.existsSync(filePath)) {
                errors.push({ file: filePath, error: 'File not found' });
                continue;
            }

            if (!isMediaFile(filePath)) {
                errors.push({ file: filePath, error: 'Not a supported media file' });
                continue;
            }

            const originalName = path.basename(filePath);
            const { type: mediaType } = detectMediaType(originalName);

            let vaultPath, vaultName, relativePath, finalMediaType;

            if (registerInPlace) {
                vaultPath = path.resolve(filePath);
                relativePath = vaultPath;
                finalMediaType = mediaType;

                if (keepOriginalNames) {
                    vaultName = originalName;
                } else if (namingConvention && namingConvention.length > 0) {
                    // Auto-increment version per (sequence, role) combo
                    if (!_versionTracker) _versionTracker = {};
                    const _vk = `${sequence?.id || ''}_${role?.id || ''}`;
                    if (!(_vk in _versionTracker)) _versionTracker[_vk] = 1;
                    const _autoVer = _versionTracker[_vk]++;

                    const convResult = generateFromConvention(namingConvention, {
                        project: project.code,
                        sequence: sequence?.name || sequence?.code,
                        shot: shot?.name || shot?.code,
                        role: role?.code,
                        version: _autoVer,
                        take: take_number || (i + 1),
                        counter: i + 1,
                        wildcards: wildcardValues,
                    }, path.extname(originalName));
                    vaultName = convResult ? convResult.vaultName : originalName;
                } else {
                    const naming = require('../utils/naming');
                    const nameResult = naming.generateVaultName({
                        originalName,
                        projectCode: project.code,
                        sequenceCode: sequence?.code,
                        sequenceName: sequence?.name,
                        shotCode: shot?.code,
                        shotName: shot?.name,
                        roleCode: role?.code,
                        takeNumber: take_number || (i + 1),
                        customName: singles.length === 1 && !detectedSeqs.length ? custom_name : null,
                        counter: i + 1,
                    });
                    vaultName = nameResult.vaultName;
                }
            } else {
                // Pre-compute convention name if project has one
                let overrideVaultName = null;
                if (!keepOriginalNames && namingConvention && namingConvention.length > 0) {
                    // Auto-increment version per (sequence, role) combo
                    if (!_versionTracker) _versionTracker = {};
                    const _vk = `${sequence?.id || ''}_${role?.id || ''}`;
                    if (!(_vk in _versionTracker)) _versionTracker[_vk] = 1;
                    const _autoVer = _versionTracker[_vk]++;

                    const convResult = generateFromConvention(namingConvention, {
                        project: project.code,
                        sequence: sequence?.name || sequence?.code,
                        shot: shot?.name || shot?.code,
                        role: role?.code,
                        version: _autoVer,
                        take: take_number || (i + 1),
                        counter: i + 1,
                        wildcards: wildcardValues,
                    }, path.extname(originalName));
                    if (convResult) overrideVaultName = convResult.vaultName;
                }

                const imported = FileService.importFile(filePath, {
                    projectCode: project.code,
                    sequenceCode: sequence?.code,
                    sequenceName: sequence?.name,
                    shotCode: shot?.code,
                    shotName: shot?.name,
                    roleCode: role?.code,
                    takeNumber: take_number || (i + 1),
                    customName: singles.length === 1 && !detectedSeqs.length ? custom_name : null,
                    template,
                    counter: i + 1,
                    keepOriginals: !!req.body.keep_originals,
                    keepOriginalName: keepOriginalNames,
                    overrideVaultName,
                });
                vaultPath = imported.vaultPath;
                vaultName = imported.vaultName;
                relativePath = imported.relativePath;
                finalMediaType = imported.mediaType;
            }

            const info = await MediaInfoService.probe(vaultPath);

            const result = db.prepare(`
                INSERT INTO assets (
                    project_id, sequence_id, shot_id, role_id,
                    original_name, vault_name, file_path, relative_path,
                    media_type, file_ext, file_size,
                    width, height, duration, fps, codec,
                    take_number, version, is_linked,
                    status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
                project.id,
                sequence?.id || null,
                shot?.id || null,
                role_id || null,
                originalName,
                vaultName,
                vaultPath,
                relativePath,
                finalMediaType,
                path.extname(originalName).toLowerCase(),
                info.fileSize || 0,
                info.width, info.height, info.duration, info.fps, info.codec,
                take_number || (i + 1),
                1,
                registerInPlace ? 1 : 0
            );

            const assetId = result.lastInsertRowid;

            const autoThumb = getSetting('auto_thumbnail') !== 'false';
            if (autoThumb) {
                try {
                    const thumbPath = await ThumbnailService.generate(vaultPath, assetId);
                    if (thumbPath) {
                        db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, assetId);
                    }
                } catch (thumbErr) {
                    console.error(`[Import] Thumbnail failed for ${originalName}:`, thumbErr.message);
                }
            }

            logActivity('asset_imported', 'asset', assetId, {
                original: originalName,
                vault: vaultName,
                project: project.name,
            });

            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
            results.push(asset);

            // Broadcast to spokes (hub mode)
            req.app.locals.broadcastChange?.('assets', 'insert', { record: asset });

            sendProgress(originalName);

            // Queue derivatives for video/exr single files if requested
            if (generateDerivatives && derivativeFormats.length > 0) {
                const { type: srcType } = detectMediaType(vaultName);
                if (srcType === 'video' || srcType === 'exr') {
                    const TranscodeService = require('../services/TranscodeService');
                    for (const fmt of derivativeFormats) {
                        const jobId = TranscodeService.queueDerivative(assetId, fmt, {
                            fps: derivativeFps,
                            _totalDuration: info.duration || null,
                        });
                        derivativeJobIds.push(jobId);
                    }
                }
            }

        } catch (err) {
            errors.push({ file: filePath, error: err.message });
            sendProgress(path.basename(filePath) + ' (error)');
        }
    }

    // Update project timestamp
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(project.id);

    const sequenceCount = detectedSeqs.length;
    const singleCount = singles.length;

    const resultPayload = {
        imported: results.length,
        errors: errors.length,
        assets: results,
        errors_detail: errors,
        sequences_detected: sequenceCount,
        singles_imported: singleCount,
        derivative_jobs: derivativeJobIds,
    };

    if (streaming) {
        res.write(`event: done\ndata: ${JSON.stringify(resultPayload)}\n\n`);
        res.end();
    } else {
        res.json(resultPayload);
    }
});

// POST /api/assets/upload — Upload via HTTP multipart
router.post('/upload', upload.array('files', 50), async (req, res) => {
    const { project_id, sequence_id, shot_id } = req.body;

    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
    if (!project_id) return res.status(400).json({ error: 'Project ID required' });

    // Convert uploaded temp files to paths and re-use import logic
    const files = req.files.map(f => {
        // Rename temp file to include original extension
        const ext = path.extname(f.originalname);
        const newPath = f.path + ext;
        fs.renameSync(f.path, newPath);
        return newPath;
    });

    // Forward to import handler logic
    req.body.files = files;
    // Call import logic inline (avoiding circular routing)
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const results = [];
    for (let i = 0; i < files.length; i++) {
        try {
            const originalName = req.files[i].originalname;
            const { type: mediaType } = detectMediaType(originalName);
            
            const imported = FileService.importFile(files[i], {
                projectCode: project.code,
                counter: i + 1,
            });

            const info = await MediaInfoService.probe(imported.vaultPath);

            const result = db.prepare(`
                INSERT INTO assets (
                    project_id, sequence_id, shot_id,
                    original_name, vault_name, file_path, relative_path,
                    media_type, file_ext, file_size,
                    width, height, duration, fps, codec,
                    take_number, version,
                    status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
                project.id, sequence_id || null, shot_id || null,
                originalName, imported.vaultName, imported.vaultPath, imported.relativePath,
                imported.mediaType, path.extname(originalName).toLowerCase(),
                info.fileSize || 0, info.width, info.height, info.duration, info.fps, info.codec,
                i + 1, 1
            );

            const assetId = result.lastInsertRowid;
            try {
                const thumbPath = await ThumbnailService.generate(imported.vaultPath, assetId);
                if (thumbPath) {
                    db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, assetId);
                }
            } catch {}

            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
            results.push(asset);

            // Broadcast to spokes (hub mode)
            req.app.locals.broadcastChange?.('assets', 'insert', { record: asset });
        } catch (err) {
            console.error('[Upload] Error:', err.message);
        }
    }

    res.json({ imported: results.length, assets: results });
});


// ═══════════════════════════════════════════
//  RENAME / UPDATE / DELETE
// ═══════════════════════════════════════════

// PUT /api/assets/:id — Update asset metadata
router.put('/:id', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const { notes, tags, starred, take_number, sequence_id, shot_id, role_id } = req.body;

    db.prepare(`
        UPDATE assets SET 
            notes = ?, tags = ?, starred = ?, take_number = ?,
            sequence_id = ?, shot_id = ?, role_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(
        notes ?? asset.notes,
        tags ? JSON.stringify(tags) : asset.tags,
        starred !== undefined ? (starred ? 1 : 0) : asset.starred,
        take_number ?? asset.take_number,
        sequence_id !== undefined ? sequence_id : asset.sequence_id,
        shot_id !== undefined ? shot_id : asset.shot_id,
        role_id !== undefined ? role_id : asset.role_id,
        asset.id
    );

    const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id);

    // Broadcast to spokes (hub mode)
    req.app.locals.broadcastChange?.('assets', 'update', { id: asset.id, record: updated });

    res.json(updated);
});

// POST /api/assets/:id/rename — Rename asset file
router.post('/:id/rename', (req, res) => {
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'New name required' });

    const db = getDb();
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    try {
        // Preserve extension
        const ext = path.extname(asset.file_path);
        let finalName = newName;
        if (!finalName.endsWith(ext)) finalName += ext;

        const newPath = FileService.renameFile(asset.file_path, finalName);
        const vaultRoot = getSetting('vault_root') || '';
        const relativePath = path.relative(vaultRoot, newPath);

        db.prepare(`
            UPDATE assets SET vault_name = ?, file_path = ?, relative_path = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(finalName, newPath, relativePath, asset.id);

        logActivity('asset_renamed', 'asset', asset.id, {
            from: asset.vault_name,
            to: finalName,
        });

        const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id);

        // Broadcast to spokes (hub mode)
        req.app.locals.broadcastChange?.('assets', 'update', { id: asset.id, record: updated });

        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/assets/:id — Delete asset (and file from disk)
router.delete('/:id', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const deleteFile = req.query.delete_file === 'true'; // Default: DB only — file stays on disk

    // Never delete the physical file for linked/referenced assets
    if (deleteFile && !asset.is_linked && fs.existsSync(asset.file_path)) {
        fs.unlinkSync(asset.file_path);
    }

    // Delete thumbnail
    ThumbnailService.deleteThumb(asset.id);

    db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
    logActivity('asset_deleted', 'asset', asset.id, { name: asset.vault_name });

    // Broadcast to spokes (hub mode)
    req.app.locals.broadcastChange?.('assets', 'delete', { id: asset.id });

    res.json({ success: true });
});

// POST /api/assets/bulk-assign — Move assets to a sequence (and optionally shot + role)
router.post('/bulk-assign', (req, res) => {
    const db = getDb();
    const { ids, sequence_id, shot_id, role_id } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array required' });
    }

    const vaultRoot = getSetting('vault_root');
    if (!vaultRoot) return res.status(500).json({ error: 'Vault root not configured' });

    // Look up the sequence (and optional shot)
    let sequence = null, shot = null;
    if (sequence_id) {
        sequence = db.prepare('SELECT s.*, p.code as project_code FROM sequences s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(sequence_id);
        if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    }
    if (shot_id) {
        shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(shot_id);
    }

    let moved = 0;
    const errors = [];

    for (const id of ids) {
        try {
            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
            if (!asset) { errors.push({ id, error: 'Not found' }); continue; }

            // Use the sequence's project (supports cross-project drag)
            const targetProjectId = sequence ? sequence.project_id : asset.project_id;
            const { getVaultDirectory } = require('../utils/naming');
            const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(targetProjectId);
            const newDir = getVaultDirectory(
                vaultRoot,
                project.code,
                asset.media_type,
                sequence?.code || null,
                shot?.code || null
            );
            FileService.ensureDir(newDir);

            const newPath = path.join(newDir, asset.vault_name);
            const oldPath = asset.file_path;

            // Move the file if it's actually in a different location
            if (path.resolve(oldPath) !== path.resolve(newPath)) {
                if (fs.existsSync(oldPath)) {
                    try {
                        fs.renameSync(oldPath, newPath);
                    } catch (err) {
                        if (err.code === 'EXDEV') {
                            fs.copyFileSync(oldPath, newPath);
                            fs.unlinkSync(oldPath);
                        } else {
                            throw err;
                        }
                    }
                }
            }

            const relativePath = path.relative(vaultRoot, newPath);

            // Update database — include project_id for cross-project moves
            db.prepare(`
                UPDATE assets 
                SET project_id = ?, sequence_id = ?, shot_id = ?, role_id = COALESCE(?, role_id), file_path = ?, relative_path = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(
                targetProjectId,
                sequence_id || null,
                shot_id || null,
                role_id || null,
                newPath,
                relativePath,
                id
            );

            moved++;
        } catch (err) {
            errors.push({ id, error: err.message });
        }
    }

    logActivity('bulk_assign', 'asset', null, {
        count: moved,
        sequence_id,
        shot_id,
        sequence_code: sequence?.code,
    });

    // Broadcast updates to spokes (hub mode)
    if (req.app.locals.broadcastChange && moved > 0) {
        for (const id of ids) {
            const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
            if (updated) req.app.locals.broadcastChange('assets', 'update', { id, record: updated });
        }
    }

    res.json({ moved, errors: errors.length, errors_detail: errors });
});

// POST /api/assets/bulk-role — Assign a role to multiple assets
router.post('/bulk-role', (req, res) => {
    const db = getDb();
    const { ids, role_id } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array required' });
    }

    // role_id can be null to clear role
    const stmt = db.prepare('UPDATE assets SET role_id = ? WHERE id = ?');
    const assign = db.transaction((items) => {
        for (const id of items) stmt.run(role_id || null, id);
    });
    assign(ids);

    // Broadcast updates to spokes (hub mode)
    if (req.app.locals.broadcastChange) {
        for (const id of ids) {
            const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
            if (updated) req.app.locals.broadcastChange('assets', 'update', { id, record: updated });
        }
    }

    res.json({ success: true, updated: ids.length });
});

// POST /api/assets/bulk-delete — Delete multiple assets at once
router.post('/bulk-delete', (req, res) => {
    const db = getDb();
    const { ids, delete_files = false } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array required' });
    }

    let deleted = 0;
    const errors = [];

    for (const id of ids) {
        try {
            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
            if (!asset) { errors.push({ id, error: 'Not found' }); continue; }

            // Never delete physical file for linked/referenced assets
            if (delete_files && !asset.is_linked && fs.existsSync(asset.file_path)) {
                fs.unlinkSync(asset.file_path);
            }
            ThumbnailService.deleteThumb(asset.id);
            db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
            logActivity('asset_deleted', 'asset', asset.id, { name: asset.vault_name });

            // Broadcast to spokes (hub mode)
            req.app.locals.broadcastChange?.('assets', 'delete', { id: asset.id });

            deleted++;
        } catch (err) {
            errors.push({ id, error: err.message });
        }
    }

    res.json({ deleted, errors: errors.length, errors_detail: errors });
});

// POST /api/assets/:id/star — Toggle star
router.post('/:id/star', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const newStarred = asset.starred ? 0 : 1;
    db.prepare('UPDATE assets SET starred = ? WHERE id = ?').run(newStarred, asset.id);

    res.json({ id: asset.id, starred: !!newStarred });
});


// ═══════════════════════════════════════════
//  SERVE FILES
// ═══════════════════════════════════════════

// Codecs the browser can play natively (H.264, H.265, VP8/9, AV1)
const BROWSER_CODECS = new Set(['h264', 'h265', 'hevc', 'vp8', 'vp9', 'av1', 'avc', 'avc1']);

// GET /api/assets/:id/stream — Transcode non-browser codecs (ProRes, DNxHR, etc.) to H.264 on the fly
router.get('/:id/stream', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT file_path, vault_name, media_type, codec, width, height FROM assets WHERE id = ?').get(req.params.id);
    if (asset) asset.file_path = resolveFilePath(asset.file_path);
    if (!asset || !fs.existsSync(asset.file_path)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const ThumbnailService = require('../services/ThumbnailService');
    const ffmpegPath = ThumbnailService.findFFmpeg();
    if (!ffmpegPath) {
        return res.status(500).json({ error: 'FFmpeg not found — cannot transcode' });
    }

    // Scale down if > 1920 wide to keep transcode fast
    const maxW = parseInt(req.query.maxw) || 1920;
    const scaleFilter = asset.width > maxW
        ? `-vf scale=${maxW}:-2`
        : '';

    const isScrub = maxW <= 480;
    const { spawn } = require('child_process');
    const args = [
        '-analyzeduration', '5000000',  // 5s — helps MXF/DNxHD containers
        '-probesize', '5000000',
        '-i', asset.file_path,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', isScrub ? '28' : '23',  // Lower quality for tiny scrub preview
        ...(isScrub ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),  // Strip audio for scrub
        ...(scaleFilter ? ['-vf', `scale=${maxW}:-2`] : []),
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        '-f', 'mp4',
        '-'
    ];

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');

    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true });
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {}); // Swallow stderr

    res.on('close', () => {
        ffmpeg.kill('SIGTERM');
    });
});

// GET /api/assets/:id/file — Serve the actual media file
router.get('/:id/file', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT file_path, vault_name, media_type FROM assets WHERE id = ?').get(req.params.id);
    if (asset) asset.file_path = resolveFilePath(asset.file_path);
    if (!asset || !fs.existsSync(asset.file_path)) {
        return res.status(404).json({ error: 'File not found' });
    }

    // Support range requests for video streaming
    const stat = fs.statSync(asset.file_path);
    const range = req.headers.range;

    if (range && asset.media_type === 'video') {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': getMimeType(asset.vault_name),
        });
        fs.createReadStream(asset.file_path, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': getMimeType(asset.vault_name),
        });
        fs.createReadStream(asset.file_path).pipe(res);
    }
});

// GET /api/assets/:id/thumbnail — Serve thumbnail
router.get('/:id/thumbnail', async (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT id, file_path, thumbnail_path FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    asset.file_path = resolveFilePath(asset.file_path);
    if (asset.thumbnail_path) asset.thumbnail_path = resolveFilePath(asset.thumbnail_path);

    let thumbPath = asset.thumbnail_path;

    // Generate on-demand if missing
    if (!thumbPath || !fs.existsSync(thumbPath)) {
        try {
            thumbPath = await ThumbnailService.generate(asset.file_path, asset.id);
            if (thumbPath) {
                db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, asset.id);
            }
        } catch {}
    }

    if (thumbPath && fs.existsSync(thumbPath)) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.sendFile(thumbPath);
    } else {
        res.status(404).json({ error: 'Thumbnail not available' });
    }
});


// (browse and preview-name routes moved above /:id)


// ─── Helpers ───

function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.webm': 'video/webm',
        '.m4v': 'video/mp4',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
    };
    return mimeMap[ext] || 'application/octet-stream';
}

// ═══════════════════════════════════════════
//  External Viewer helpers (RV / OpenRV)
// ═══════════════════════════════════════════

/**
 * Find RV (Autodesk/ShotGrid media viewer) executable on this machine.
 * Checks standard install locations per platform.
 */
function findRV() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // 1. Check user-configured RV path in settings (highest priority)
    try {
        const customPath = getSetting('rv_path');
        if (customPath && fs.existsSync(customPath)) return customPath;
    } catch (e) { /* settings not ready yet */ }

    // 2. Check MediaVault bundled RV (tools/rv/ — installed by install.bat / install.sh)
    if (isMac) {
        const bundledRvMac = path.join(__dirname, '..', '..', 'tools', 'rv', 'RV.app', 'Contents', 'MacOS', 'RV');
        if (fs.existsSync(bundledRvMac)) return bundledRvMac;
    }
    const bundledRv = path.join(__dirname, '..', '..', 'tools', 'rv', 'bin', isWin ? 'rv.exe' : 'rv');
    if (fs.existsSync(bundledRv)) return bundledRv;

    // 3. Check OpenRV local build (common for self-compiled OpenRV)
    if (isWin) {
        const openrvBuild = 'C:\\OpenRV\\_build\\stage\\app\\bin\\rv.exe';
        if (fs.existsSync(openrvBuild)) return openrvBuild;
    } else if (isMac) {
        const homedir = require('os').homedir();
        const macBuilds = [
            path.join(homedir, 'OpenRV', '_build', 'stage', 'app', 'RV.app', 'Contents', 'MacOS', 'RV'),
            path.join(homedir, 'OpenRV', '_install', 'RV.app', 'Contents', 'MacOS', 'RV'),
        ];
        for (const p of macBuilds) {
            if (fs.existsSync(p)) return p;
        }
    }

    if (isWin) {
        // Windows: check Program Files for RV installations
        const searchDirs = ['C:\\Program Files', 'C:\\Program Files (x86)'];
        const folderPrefixes = ['Autodesk\\RV', 'Shotgun\\RV', 'ShotGrid\\RV', 'Shotgun RV', 'RV'];
        for (const base of searchDirs) {
            for (const prefix of folderPrefixes) {
                const dir = path.join(base, prefix);
                // Exact match
                const exe = path.join(dir, 'bin', 'rv.exe');
                if (fs.existsSync(exe)) return exe;
            }
            // Scan for versioned folders like "Autodesk/RV-2024.0.1"
            try {
                const autodesk = path.join(base, 'Autodesk');
                if (fs.existsSync(autodesk)) {
                    const dirs = fs.readdirSync(autodesk).filter(d => d.startsWith('RV'));
                    for (const d of dirs) {
                        const exe = path.join(autodesk, d, 'bin', 'rv.exe');
                        if (fs.existsSync(exe)) return exe;
                    }
                }
            } catch (e) { /* ignore */ }
            try {
                const shotgun = path.join(base, 'Shotgun');
                if (fs.existsSync(shotgun)) {
                    const dirs = fs.readdirSync(shotgun).filter(d => d.startsWith('RV'));
                    for (const d of dirs) {
                        const exe = path.join(shotgun, d, 'bin', 'rv.exe');
                        if (fs.existsSync(exe)) return exe;
                    }
                }
            } catch (e) { /* ignore */ }
        }
    } else if (isMac) {
        // macOS: check /Applications for RV.app bundles
        const candidates = [
            '/Applications/RV.app/Contents/MacOS/RV',
            '/Applications/Autodesk/RV.app/Contents/MacOS/RV',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        try {
            const dirs = fs.readdirSync('/Applications').filter(d =>
                d.startsWith('RV') && d.endsWith('.app')
            );
            for (const d of dirs) {
                const exe = path.join('/Applications', d, 'Contents', 'MacOS', 'RV');
                if (fs.existsSync(exe)) return exe;
            }
        } catch (e) { /* ignore */ }
    } else {
        // Linux: check common install locations
        const candidates = [
            '/usr/local/rv/bin/rv',
            '/opt/rv/bin/rv',
            '/usr/local/bin/rv',
            '/usr/bin/rv',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        // Scan /opt for versioned RV installs (e.g. /opt/rv-2024.0.1/)
        try {
            const dirs = fs.readdirSync('/opt').filter(d => d.startsWith('rv'));
            for (const d of dirs) {
                const exe = path.join('/opt', d, 'bin', 'rv');
                if (fs.existsSync(exe)) return exe;
            }
        } catch (e) { /* ignore */ }
    }
    return null;
}

/**
 * Find rvpush.exe companion tool (lives next to rv.exe in same bin/ dir).
 * rvpush sends commands to a running RV session over network.
 */
function findRvPush() {
    const rvExe = findRV();
    if (!rvExe) return null;
    const rvDir = path.dirname(rvExe);
    const pushExe = path.join(rvDir, process.platform === 'win32' ? 'rvpush.exe' : 'rvpush');
    if (fs.existsSync(pushExe)) return pushExe;
    return null;
}

/**
 * Resolve an asset DB row to the path RV should receive.
 * - For regular files: returns the resolved file path.
 * - For image sequences: returns RV sequence notation, e.g.
 *   /path/to/render.1001-1100#.exr  (one # per padding digit)
 * @param {Object} asset - Asset row with file_path, is_sequence, frame_pattern,
 *                         frame_start, frame_end, frame_count
 * @returns {string|null} RV-compatible path, or null if file doesn't exist
 */
function resolveAssetRvPath(asset) {
    if (!asset || !asset.file_path) return null;

    const resolved = resolveFilePath(asset.file_path);

    if (asset.is_sequence && asset.frame_pattern && asset.frame_start != null && asset.frame_end != null) {
        // Build RV sequence notation from the frame_pattern (printf-style)
        // frame_pattern looks like: "render.%04d.exr" or "render_%04d.exr"
        // RV wants: "/dir/render.1001-1100####.exr"
        const dir = path.dirname(resolved);
        const pattern = asset.frame_pattern; // e.g. "render.%04d.exr"

        // Extract padding width from %0Nd pattern
        const padMatch = pattern.match(/%0(\d+)d/);
        const digits = padMatch ? parseInt(padMatch[1], 10) : 4;
        const hashes = '#'.repeat(digits);

        // Replace %0Nd with frameStart-frameEnd followed by # padding
        const rvPattern = pattern.replace(/%0\d+d/, `${asset.frame_start}-${asset.frame_end}${hashes}`);
        const rvPath = path.join(dir, rvPattern);

        // Verify at least the first frame exists
        const firstFrame = pattern.replace(/%0\d+d/, String(asset.frame_start).padStart(digits, '0'));
        const firstFramePath = path.join(dir, firstFrame);
        if (fs.existsSync(firstFramePath)) return rvPath;

        // Fallback: try resolved file_path directly
        if (fs.existsSync(resolved)) return resolved;
        return null;
    }

    // Regular file
    if (fs.existsSync(resolved)) return resolved;
    return null;
}

/**
 * Check if an RV process is currently running.
 * Returns true/false.
 */
function isRvRunning() {
    const { execSync } = require('child_process');
    try {
        if (process.platform === 'win32') {
            const out = execSync('tasklist /FI "IMAGENAME eq rv.exe" /NH', { windowsHide: true, encoding: 'utf8' });
            return out.includes('rv.exe');
        } else {
            execSync('pgrep -x rv', { stdio: 'ignore' });
            return true;
        }
    } catch { return false; }
}

/**
 * Try to push files to a running RV session via rvpush.
 * @param {string} pushExe - Path to rvpush.exe
 * @param {string[]} filePaths - Files to load
 * @param {string} mode - 'set' (replace) or 'merge' (add)
 * @returns {{ success: boolean, started: boolean }} - started=true if we had to launch a new RV
 */
function rvPush(pushExe, filePaths, mode = 'set') {
    const { spawnSync } = require('child_process');
    const cwd = path.dirname(pushExe);

    // Build rvpush arguments
    // Note: rvpush doesn't support compare flags (-wipe, -tile, etc.)
    // Those are only valid for the rv executable itself
    const args = [mode, ...filePaths];

    // Set RVPUSH_RV_EXECUTABLE_PATH=none so rvpush never auto-launches RV
    // (we handle launching ourselves with -network to ensure future pushes work)
    const env = { ...process.env, RVPUSH_RV_EXECUTABLE_PATH: 'none' };

    const result = spawnSync(pushExe, args, { cwd, windowsHide: true, timeout: 5000, encoding: 'utf8', env });

    // Exit 0 = success (pushed to running RV)
    // Exit 15 = no running RV found, rvpush started a new one
    // Exit 4 = connection failed (RV not running and couldn't auto-start)
    if (result.status === 0) {
        console.log(`[RV] rvpush ${mode}: ${filePaths.length} file(s) → running session`);
        return { success: true, started: false };
    }
    if (result.status === 15) {
        console.log(`[RV] rvpush ${mode}: started new RV with ${filePaths.length} file(s)`);
        return { success: true, started: true };
    }
    return { success: false, started: false };
}

/**
 * Launch file(s) in RV with persistent session support.
 * 1. If RV is running → use rvpush to replace/merge media (no restart)
 * 2. If RV is not running → launch rv.exe with -network flag (enables rvpush)
 *
 * When RV receives 2+ sources it lets the user pick wipe/tile/sequence from its own UI.
 *
 * macOS note: Must use `open -a <bundle>` to properly activate the app window.
 * Launching the binary directly via execFile works but the window stays hidden
 * behind other apps because macOS doesn't give it foreground activation.
 */
function launchInRV(exePath, filePaths) {
    const { execFile } = require('child_process');
    const cwd = path.dirname(exePath);
    const pushExe = findRvPush();

    // Always try rvpush first. RV handles 2+ sources natively.
    if (pushExe) {
        const pushResult = rvPush(pushExe, filePaths, 'set');
        if (pushResult.success) return;
    }

    // No running RV (or no rvpush) — launch fresh with -network enabled
    if (process.platform === 'darwin') {
        // macOS: use `open -a` to properly activate the app window.
        // Walk up from the binary (Contents/MacOS/RV) to find the .app bundle.
        let appBundle = null;
        let dir = exePath;
        for (let i = 0; i < 5; i++) {
            dir = path.dirname(dir);
            if (dir.endsWith('.app')) { appBundle = dir; break; }
        }
        if (appBundle) {
            const args = ['-a', appBundle, '--args', '-network', ...filePaths];
            execFile('/usr/bin/open', args, { cwd });
            console.log(`[RV] Launched via 'open -a' (macOS): ${filePaths.length} file(s)`);
            return;
        }
    }

    // Windows/Linux or fallback: launch binary directly
    const args = ['-network', ...filePaths];
    const { spawn } = require('child_process');
    console.log(`[RV] Spawning: ${exePath} ${args.join(' ')}`);
    const child = spawn(exePath, args, {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
    });
    let stderrBuf = '';
    child.stdout.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) console.log(`[RV] stdout: ${msg.substring(0, 300)}`);
    });
    child.stderr.on('data', (d) => {
        stderrBuf += d.toString();
        if (stderrBuf.length < 2000) return; // batch small writes
        console.error(`[RV] stderr: ${stderrBuf.substring(0, 500)}`);
        stderrBuf = '';
    });
    child.on('error', (err) => {
        console.error(`[RV] Spawn error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
        if (stderrBuf.trim()) console.error(`[RV] stderr: ${stderrBuf.substring(0, 500)}`);
        if (code !== 0 && code !== null) {
            console.error(`[RV] Exited with code ${code} signal ${signal}`);
        } else {
            console.log(`[RV] Process exited (code=${code})`);
        }
    });
    child.unref();
    console.log(`[RV] Launched new session (-network): ${filePaths.length} file(s), PID=${child.pid}`);
}

// POST /api/assets/rv-push — Push files to a running RV session (or start one)
// Body: { ids: [assetId, ...], mode: 'set'|'merge' }
//   mode 'set' = replace current media, 'merge' = add to sources
router.post('/rv-push', (req, res) => {
    const db = getDb();
    const { ids, mode } = req.body || {};
    if (!ids || !Array.isArray(ids) || ids.length < 1) {
        return res.status(400).json({ error: 'Provide an array of asset ids' });
    }

    const pushExe = findRvPush();
    const rvExe = findRV();
    if (!pushExe && !rvExe) {
        return res.status(404).json({ error: 'Neither rvpush nor RV found.' });
    }

    // Resolve file paths (apply cross-platform path mappings; handle sequences)
    const filePaths = [];
    for (const id of ids) {
        const asset = db.prepare(
            'SELECT file_path, is_sequence, frame_pattern, frame_start, frame_end, frame_count FROM assets WHERE id = ?'
        ).get(id);
        if (asset) {
            const rvPath = resolveAssetRvPath(asset);
            if (rvPath) filePaths.push(rvPath);
        }
    }
    if (filePaths.length === 0) {
        return res.status(404).json({ error: 'No valid files found' });
    }

    const pushMode = mode === 'merge' ? 'merge' : 'set';

    // Try rvpush first
    if (pushExe) {
        const result = rvPush(pushExe, filePaths, pushMode);
        if (result.success) {
            return res.json({
                success: true,
                count: filePaths.length,
                mode: pushMode,
                started: result.started,
                message: result.started
                    ? `Started RV with ${filePaths.length} file(s)`
                    : `Pushed ${filePaths.length} file(s) to running RV (${pushMode})`
            });
        }
    }

    // rvpush failed — launch fresh RV with -network
    if (rvExe) {
        launchInRV(rvExe, filePaths);
        return res.json({
            success: true,
            count: filePaths.length,
            mode: pushMode,
            started: true,
            message: `Launched new RV session with ${filePaths.length} file(s)`
        });
    }

    res.status(500).json({ error: 'Failed to push or launch RV' });
});

// ═══════════════════════════════════════════
//  REVIEW MODE — FFmpeg burn-in overlays
// ═══════════════════════════════════════════

/**
 * Build FFmpeg drawtext/drawbox filter string for review overlays.
 * Returns a complex filter string with burn-in, watermark, safe areas, frame counter.
 */
/**
 * Find a usable font file for FFmpeg drawtext.
 * Returns the fontfile= parameter string (with escaped path for FFmpeg).
 */
function findFontFile() {
    const isWin = process.platform === 'win32';
    const candidates = isWin ? [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/calibri.ttf',
    ] : [
        '/System/Library/Fonts/Helvetica.ttc',        // macOS
        '/System/Library/Fonts/SFNSText.ttf',         // macOS
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  // Linux
        '/usr/share/fonts/TTF/DejaVuSans.ttf',        // Linux alt
    ];
    for (const f of candidates) {
        if (fs.existsSync(f)) {
            // FFmpeg needs forward slashes and escaped colons
            return f.replace(/\\/g, '/').replace(/:/g, '\\:');
        }
    }
    return null; // Will fall back to font=Arial and hope fontconfig works
}

function buildReviewFilters(opts) {
    const {
        burnIn = true,
        watermark = true,
        safeAreas = false,
        frameCounter = true,
        watermarkText = 'INTERNAL REVIEW',
        hierarchy = '',       // "Project > Sequence > Shot | Role"
        techInfo = '',        // "1920×1080 | H264 | 24fps"
        isVideo = true,
    } = opts;

    // Escape special characters for FFmpeg drawtext
    // Order matters: escape backslash FIRST, then others
    const esc = (s) => s
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "'\\\\''")
        .replace(/%/g, '%%');

    // Font specification — prefer fontfile (works everywhere), fallback to font name
    const fontPath = findFontFile();
    const fontParam = fontPath ? `fontfile='${fontPath}'` : 'font=Arial';

    const filters = [];

    // --- Top burn-in bar: hierarchy + tech info ---
    if (burnIn && (hierarchy || techInfo)) {
        filters.push("drawbox=x=0:y=0:w=iw:h=36:color=black@0.65:t=fill");
        if (hierarchy) {
            filters.push(`drawtext=text='${esc(hierarchy)}':x=10:y=10:fontsize=16:fontcolor=white:${fontParam}`);
        }
        if (techInfo) {
            filters.push(`drawtext=text='${esc(techInfo)}':x=w-text_w-10:y=10:fontsize=14:fontcolor=white@0.7:${fontParam}`);
        }
    }

    // --- Bottom frame counter bar ---
    if (frameCounter) {
        filters.push("drawbox=x=0:y=ih-36:w=iw:h=36:color=black@0.65:t=fill");
        if (isVideo) {
            // Frame number (left) and timecode (right) for video
            filters.push(`drawtext=text='Frame %{frame_num}':start_number=1:x=10:y=ih-26:fontsize=16:fontcolor=white:${fontParam}`);
            filters.push(`drawtext=text='%{pts\\:hms}':x=w-text_w-10:y=ih-26:fontsize=16:fontcolor=white@0.8:${fontParam}`);
        } else {
            // Just filename for images
            filters.push(`drawtext=text='${esc(opts.filename || '')}':x=10:y=ih-26:fontsize=14:fontcolor=white@0.8:${fontParam}`);
        }
    }

    // --- Center watermark ---
    if (watermark && watermarkText) {
        filters.push(`drawtext=text='${esc(watermarkText)}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=56:fontcolor=white@0.12:${fontParam}`);
    }

    // --- Safe areas (title safe 90%, action safe 93%) ---
    if (safeAreas) {
        // Action safe (93%) — subtle yellow
        const ax = 'iw*0.035', ay = 'ih*0.035', aw = 'iw*0.93', ah = 'ih*0.93';
        filters.push(`drawbox=x=${ax}:y=${ay}:w=${aw}:h=${ah}:color=yellow@0.25:t=1`);
        // Title safe (90%) — subtle red
        const tx = 'iw*0.05', ty = 'ih*0.05', tw = 'iw*0.9', th = 'ih*0.9';
        filters.push(`drawbox=x=${tx}:y=${ty}:w=${tw}:h=${th}:color=red@0.3:t=1`);
    }

    return filters.join(',');
}

// POST /api/assets/:id/open-review — Open file with burn-in overlays in external player
router.post('/:id/open-review', async (req, res) => {
    const { execFile } = require('child_process');
    const os = require('os');
    const db = getDb();

    // Get asset with full hierarchy info
    const asset = db.prepare(`
        SELECT a.*, 
            p.name as project_name, p.code as project_code,
            s.name as sequence_name, s.code as sequence_code,
            sh.name as shot_name, sh.code as shot_code,
            r.name as role_name, r.code as role_code
        FROM assets a
        LEFT JOIN projects p ON p.id = a.project_id
        LEFT JOIN sequences s ON s.id = a.sequence_id
        LEFT JOIN shots sh ON sh.id = a.shot_id
        LEFT JOIN roles r ON r.id = a.role_id
        WHERE a.id = ?
    `).get(req.params.id);
    if (asset) asset.file_path = resolveFilePath(asset.file_path);
    const rvPath = asset ? resolveAssetRvPath(asset) : null;

    if (!asset || !fs.existsSync(asset.file_path)) {
        return res.status(404).json({ error: 'File not found' });
    }

    // Find FFmpeg
    const ffmpegPath = ThumbnailService.findFFmpeg();
    if (!ffmpegPath) {
        return res.status(500).json({ error: 'FFmpeg not found — required for review mode' });
    }

    // Find external player (RV)
    const exePath = findRV();
    if (!exePath) {
        return res.status(404).json({ error: 'RV not found — install OpenRV or set path in Settings' });
    }

    // Overlay options from client
    const {
        burnIn = true,
        watermark = true,
        safeAreas = false,
        frameCounter = true,
        watermarkText = 'INTERNAL REVIEW',
    } = req.body || {};

    // Build hierarchy string: "Project > Sequence > Shot | Role"
    const hierParts = [];
    if (asset.project_name) hierParts.push(asset.project_name);
    if (asset.sequence_name) hierParts.push(asset.sequence_name);
    if (asset.shot_name) hierParts.push(asset.shot_name);
    let hierarchy = hierParts.join(' > ');
    if (asset.role_name) hierarchy += (hierarchy ? '  |  ' : '') + asset.role_name;

    // Build tech info string
    const techParts = [];
    if (asset.width && asset.height) techParts.push(`${asset.width}x${asset.height}`);
    if (asset.codec) techParts.push(asset.codec);
    if (asset.fps) techParts.push(`${asset.fps}fps`);
    const techInfo = techParts.join(' | ');

    const isVideo = (asset.media_type === 'video');
    const ext = path.extname(asset.file_path).toLowerCase();
    const tmpDir = path.join(os.tmpdir(), `dmv-review-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Output to temp file (always .mp4 for video, .png for images)
    const outExt = isVideo ? '.mp4' : '.png';
    const outFile = path.join(tmpDir, `review${outExt}`);

    // Build filter string
    const filterStr = buildReviewFilters({
        burnIn, watermark, safeAreas, frameCounter, watermarkText,
        hierarchy, techInfo, isVideo,
        filename: asset.vault_name,
    });

    if (!filterStr) {
        // No overlays selected — just open normally (use RV sequence notation if applicable)
        launchInRV(exePath, [rvPath || asset.file_path]);
        return res.json({ success: true, mode: 'direct' });
    }

    // Build FFmpeg args
    const args = ['-y', '-i', asset.file_path];

    if (isVideo) {
        // Video: transcode with overlays (use NVENC if available, fall back to libx264)
        args.push(
            '-vf', filterStr,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '18',
            '-c:a', 'copy',
            outFile
        );
    } else {
        // Image: apply overlays to single frame
        args.push(
            '-vf', filterStr,
            '-frames:v', '1',
            outFile
        );
    }

    console.log(`[Review] Generating overlay file for: ${asset.vault_name}`);
    res.json({ success: true, mode: 'processing', message: 'Generating review file with overlays...' });

    // Run FFmpeg asynchronously — open file when done
    execFile(ffmpegPath, args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
            // Log the actual FFmpeg error (stderr has the real info)
            const errText = (stderr || err.message || '').toString();
            // Find the last meaningful line (skip the banner)
            const lines = errText.split('\n').filter(l => l.trim());
            const lastLines = lines.slice(-5).join('\n');
            console.error(`[Review] FFmpeg failed:\n${lastLines}`);
            return;
        }
        console.log(`[Review] Generated: ${outFile}`);

        // Open in RV
        launchInRV(exePath, [outFile]);

        // Clean up temp dir after 1 hour
        setTimeout(() => {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }, 3600000);
    });
});

// POST /api/assets/:id/open-external — Open file in external player
router.post('/:id/open-external', (req, res) => {
    const db = getDb();
    const asset = db.prepare(
        'SELECT file_path, vault_name, is_sequence, frame_pattern, frame_start, frame_end, frame_count FROM assets WHERE id = ?'
    ).get(req.params.id);
    const rvPath = asset ? resolveAssetRvPath(asset) : null;
    const resolvedPlain = asset ? resolveFilePath(asset.file_path) : null;
    if (!asset || (!rvPath && !resolvedPlain)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const { player, customPath } = req.body || {};
    let exePath = null;
    let playerName = '';

    if (player === 'custom' && customPath) {
        if (fs.existsSync(customPath)) {
            exePath = customPath;
        } else {
            return res.status(404).json({ error: `Custom player not found at: ${customPath}` });
        }
        const { execFile } = require('child_process');
        execFile(exePath, [resolvedPlain || rvPath], { cwd: path.dirname(exePath) });
        playerName = path.basename(exePath);
    } else if (player === 'rv') {
        exePath = findRV();
        if (!exePath) {
            return res.status(404).json({ error: 'RV not found. Install Autodesk RV / ShotGrid RV.' });
        }
        launchInRV(exePath, [rvPath || resolvedPlain]);
        playerName = 'RV';
    } else {
        // RV (default)
        exePath = findRV();
        if (!exePath) {
            return res.status(404).json({ error: 'RV not found. Install OpenRV or set path in Settings.' });
        }
        launchInRV(exePath, [rvPath || resolvedPlain]);
        playerName = 'RV';
    }

    console.log(`[${playerName}] Launched: ${asset.vault_name}`);
    res.json({ success: true, path: asset.file_path, player: playerName });
});

// ═══════════════════════════════════════════
//  FORMAT VARIANTS (siblings with same base name)
// ═══════════════════════════════════════════

// GET /api/assets/:id/formats — find format variants (same base name, different extension)
// Includes both GLOB-matched siblings and explicit derivatives (parent_asset_id)
router.get('/:id/formats', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    // Strip extension to get base name
    const baseName = asset.vault_name.replace(/\.[^.]+$/, '');

    // 1. GLOB match: same base name, any extension, same project
    const globMatches = db.prepare(`
        SELECT id, vault_name, file_ext, media_type, file_size, is_sequence, is_derivative, parent_asset_id
        FROM assets
        WHERE project_id = ?
        AND vault_name GLOB ?
        ORDER BY file_ext
    `).all(asset.project_id, baseName + '.*');

    // 2. Explicit derivatives: linked via parent_asset_id (covers cases where name differs)
    const parentId = asset.parent_asset_id || asset.id;
    const explicitDerivatives = db.prepare(`
        SELECT id, vault_name, file_ext, media_type, file_size, is_sequence, is_derivative, parent_asset_id
        FROM assets
        WHERE (parent_asset_id = ? OR parent_asset_id = ? OR id = ?)
        ORDER BY file_ext
    `).all(parentId, asset.id, parentId);

    // Merge and deduplicate by ID
    const seen = new Set();
    const formats = [];
    for (const row of [...globMatches, ...explicitDerivatives]) {
        if (!seen.has(row.id)) {
            seen.add(row.id);
            formats.push(row);
        }
    }

    res.json({ formats, baseName });
});


// ═══════════════════════════════════════════
//  PUBLISH FRAME (RV → Vault)
// ═══════════════════════════════════════════

/**
 * POST /api/assets/publish-frame
 * Called by the RV plugin to extract a single frame from the currently-loaded
 * source and import it as a "Ref" asset in the vault.
 *
 * Body: { sourcePath: string, frameNumber: number, renderedFramePath?: string }
 *
 * If renderedFramePath is provided (exported by RV with annotations/paint-overs
 * composited), that file is imported directly instead of extracting from source.
 *
 * For image sequences (EXR/DPX/TIFF): copies the specific frame file AND
 * generates a PNG preview via FFmpeg.
 * For video files (MP4/MOV/etc.): extracts frame as PNG via FFmpeg.
 *
 * Naming: {convention}_ref_F{frame}_v{ver}.{ext}
 */
router.post('/publish-frame', async (req, res) => {
    const { sourcePath, frameNumber, renderedFramePath } = req.body;
    const { execFile } = require('child_process');
    const os = require('os');

    if (!sourcePath) return res.status(400).json({ success: false, error: 'sourcePath is required' });
    if (frameNumber == null) return res.status(400).json({ success: false, error: 'frameNumber is required' });

    const db = getDb();

    // ── 1. Find source asset in DB by path ──
    const variants = getAllPathVariants(sourcePath);
    const stmt = db.prepare(`
        SELECT a.*, p.name AS project_name, p.code AS project_code,
               p.naming_convention, p.episode,
               seq.name AS sequence_name, seq.code AS sequence_code,
               sh.name AS shot_name, sh.code AS shot_code
        FROM assets a
        LEFT JOIN projects p ON a.project_id = p.id
        LEFT JOIN sequences seq ON a.sequence_id = seq.id
        LEFT JOIN shots sh ON a.shot_id = sh.id
        WHERE replace(a.file_path, '\\', '/') = ?
        LIMIT 1
    `);

    let asset = null;
    for (const variant of variants) {
        asset = stmt.get(variant);
        if (asset) break;
    }

    if (!asset) {
        return res.status(404).json({ success: false, error: 'Source asset not found in vault' });
    }

    // ── 2. Find or create "Ref" role ──
    let refRole = db.prepare("SELECT * FROM roles WHERE LOWER(name) = 'ref' OR LOWER(code) = 'ref'").get();
    if (!refRole) {
        db.prepare("INSERT INTO roles (name, code, color, icon) VALUES ('Ref', 'ref', '#888888', '📌')").run();
        refRole = db.prepare("SELECT * FROM roles WHERE code = 'ref'").get();
    }

    // ── 3. Determine source type and build frame file path ──
    const sourceExt = path.extname(sourcePath).toLowerCase();
    const sequenceExts = new Set(['.exr', '.dpx', '.tiff', '.tif', '.png', '.jpg', '.jpeg', '.tga']);
    const isSequence = asset.is_sequence || sequenceExts.has(sourceExt);

    const tempDir = path.join(os.tmpdir(), `cam_publish_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const publishedAssets = [];
    const frameStr = String(frameNumber).padStart(4, '0');

    // Build base name for the ref asset
    const project = { code: asset.project_code, naming_convention: asset.naming_convention, episode: asset.episode };
    const vaultRoot = FileService.getVaultRoot();
    const refMediaType = 'image';
    const vaultDir = getVaultDirectory(vaultRoot, project.code, refMediaType, asset.sequence_code, asset.shot_code);
    FileService.ensureDir(vaultDir);

    // Build ref base pattern for version auto-increment
    let refBasePattern;
    if (asset.shot_code) {
        refBasePattern = `${asset.shot_code}_ref_F${frameStr}_v`;
    } else if (asset.sequence_code) {
        refBasePattern = `${asset.sequence_code}_ref_F${frameStr}_v`;
    } else {
        refBasePattern = `${project.code}_ref_F${frameStr}_v`;
    }
    const version = getNextVersion(vaultDir, refBasePattern);
    const versionStr = String(version).padStart(3, '0');

    // Helper to build vault name
    function buildVaultName(ext) {
        // Try naming convention first
        let namingConvention = null;
        if (project.naming_convention) {
            try { namingConvention = JSON.parse(project.naming_convention); } catch (_) {}
        }
        if (namingConvention && namingConvention.length > 0) {
            const convResult = generateFromConvention(namingConvention, {
                project: project.code,
                episode: project.episode,
                sequence: asset.sequence_name || asset.sequence_code,
                shot: asset.shot_name || asset.shot_code,
                role: 'ref',
                version: version,
            }, ext);
            if (convResult) {
                // Insert frame number before version: shoot_ref_v001 → shoot_ref_F0142_v001
                const vName = convResult.vaultName;
                const vMatch = vName.match(/_v(\d+)(\.[^.]+)$/);
                if (vMatch) {
                    return vName.replace(/_v(\d+)(\.[^.]+)$/, `_F${frameStr}_v${vMatch[1]}$2`);
                }
                // No version token — just append frame number before extension
                const extIdx = vName.lastIndexOf('.');
                return extIdx > 0 ? `${vName.slice(0, extIdx)}_F${frameStr}${vName.slice(extIdx)}` : vName;
            }
        }
        // Fallback: manual construction
        const parts = [asset.shot_code || asset.sequence_code || project.code, 'ref', `F${frameStr}`, `v${versionStr}`];
        return parts.join('_') + ext;
    }

    // Helper to register an imported file in DB
    function registerAsset(filePath, vaultName, ext) {
        const relativePath = path.relative(vaultRoot, filePath);
        const stats = fs.statSync(filePath);
        const result = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size, version, is_linked, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
            asset.project_id, asset.sequence_id || null, asset.shot_id || null, refRole.id,
            vaultName, vaultName, filePath, relativePath,
            'image', ext, stats.size, version
        );
        const assetId = result.lastInsertRowid;
        logActivity('publish_frame', 'asset', assetId,
            `Published frame ${frameNumber} from ${asset.vault_name}`);
        return assetId;
    }

    try {
        // ── Rendered frame path (RV exported composited frame with annotations) ──
        if (renderedFramePath && fs.existsSync(renderedFramePath) && fs.statSync(renderedFramePath).size > 100) {
            // RV already exported the displayed frame (with annotations/paint-overs/
            // color corrections baked in). Import that file directly.
            const renderedExt = path.extname(renderedFramePath).toLowerCase() || '.png';
            const pngVaultName = buildVaultName(renderedExt);
            const destPath = path.join(vaultDir, pngVaultName);
            fs.copyFileSync(renderedFramePath, destPath);
            const assetId = registerAsset(destPath, pngVaultName, renderedExt);

            // Generate thumbnail
            try {
                const thumbPath = await ThumbnailService.generate(destPath, assetId);
                if (thumbPath) db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, assetId);
            } catch (_) {}

            publishedAssets.push({ id: assetId, vault_name: pngVaultName });

        } else if (isSequence) {
            // ── Sequence source: find the actual frame file ──
            const resolvedSourcePath = resolveFilePath(asset.file_path);
            let sourceFramePath;

            if (asset.frame_pattern) {
                // Use frame_pattern (e.g. "render.%04d.exr") to construct exact frame path
                const dir = path.dirname(resolvedSourcePath);
                const padMatch = asset.frame_pattern.match(/%0(\d+)d/);
                const digits = padMatch ? parseInt(padMatch[1], 10) : 4;
                const frameName = asset.frame_pattern.replace(/%0\d+d/, String(frameNumber).padStart(digits, '0'));
                sourceFramePath = path.join(dir, frameName);
            } else {
                // Try to derive from the source path filename
                sourceFramePath = resolvedSourcePath;
            }

            if (!sourceFramePath || !fs.existsSync(sourceFramePath)) {
                // Clean up
                try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
                return res.status(404).json({
                    success: false,
                    error: `Frame file not found: ${sourceFramePath || 'unknown'}`
                });
            }

            // Copy the native frame file (EXR/DPX) into vault
            const nativeExt = path.extname(sourceFramePath).toLowerCase();
            const nativeVaultName = buildVaultName(nativeExt);
            const nativeDestPath = path.join(vaultDir, nativeVaultName);
            fs.copyFileSync(sourceFramePath, nativeDestPath);
            const nativeId = registerAsset(nativeDestPath, nativeVaultName, nativeExt);

            // Generate thumbnail
            try {
                const thumbPath = await ThumbnailService.generate(nativeDestPath, nativeId);
                if (thumbPath) db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, nativeId);
            } catch (_) {}

            publishedAssets.push({ id: nativeId, vault_name: nativeVaultName });

            // Also generate a PNG preview via FFmpeg
            const pngVaultName = buildVaultName('.png');
            const pngTempPath = path.join(tempDir, 'preview.png');

            await new Promise((resolve, reject) => {
                const ffmpegPath = ThumbnailService.findFFmpeg();
                if (!ffmpegPath) return reject(new Error('FFmpeg not found'));
                execFile(ffmpegPath, [
                    '-i', sourceFramePath,
                    '-frames:v', '1',
                    '-y', pngTempPath
                ], { timeout: 30000, windowsHide: true }, (err) => {
                    if (err) reject(err); else resolve();
                });
            });

            if (fs.existsSync(pngTempPath) && fs.statSync(pngTempPath).size > 100) {
                const pngDestPath = path.join(vaultDir, pngVaultName);
                fs.copyFileSync(pngTempPath, pngDestPath);
                const pngId = registerAsset(pngDestPath, pngVaultName, '.png');

                try {
                    const thumbPath = await ThumbnailService.generate(pngDestPath, pngId);
                    if (thumbPath) db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, pngId);
                } catch (_) {}

                publishedAssets.push({ id: pngId, vault_name: pngVaultName });
            }

        } else {
            // ── Video source: extract frame via FFmpeg ──
            const resolvedSourcePath = resolveFilePath(asset.file_path);
            if (!fs.existsSync(resolvedSourcePath)) {
                try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
                return res.status(404).json({ success: false, error: 'Source video not found on disk' });
            }

            const pngVaultName = buildVaultName('.png');
            const pngTempPath = path.join(tempDir, 'frame.png');

            // Use frame number to calculate timestamp (need fps)
            const fps = asset.fps || 24;
            const timestamp = frameNumber / fps;

            await new Promise((resolve, reject) => {
                const ffmpegPath = ThumbnailService.findFFmpeg();
                if (!ffmpegPath) return reject(new Error('FFmpeg not found'));
                execFile(ffmpegPath, [
                    '-ss', String(timestamp),
                    '-i', resolvedSourcePath,
                    '-frames:v', '1',
                    '-y', pngTempPath
                ], { timeout: 30000, windowsHide: true }, (err) => {
                    if (err) reject(err); else resolve();
                });
            });

            if (!fs.existsSync(pngTempPath) || fs.statSync(pngTempPath).size < 100) {
                try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
                return res.status(500).json({ success: false, error: 'FFmpeg frame extraction produced no output' });
            }

            const pngDestPath = path.join(vaultDir, pngVaultName);
            fs.copyFileSync(pngTempPath, pngDestPath);
            const pngId = registerAsset(pngDestPath, pngVaultName, '.png');

            try {
                const thumbPath = await ThumbnailService.generate(pngDestPath, pngId);
                if (thumbPath) db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, pngId);
            } catch (_) {}

            publishedAssets.push({ id: pngId, vault_name: pngVaultName });
        }

        // Clean up temp dir
        try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}

        // Broadcast new assets to spokes (hub mode)
        if (req.app.locals.broadcastChange && publishedAssets.length > 0) {
            for (const pa of publishedAssets) {
                const record = db.prepare('SELECT * FROM assets WHERE id = ?').get(pa.id);
                if (record) req.app.locals.broadcastChange('assets', 'insert', { record });
            }
        }

        res.json({ success: true, assets: publishedAssets });

        // ── Forward new asset records to hub (spoke mode) ──
        // publish-frame runs locally (LOCAL_ONLY) but we need the hub DB to
        // know about these assets so they survive the next DB sync.
        const spokeService = req.app.locals.spokeService;
        if (spokeService && publishedAssets.length > 0) {
            setImmediate(() => {
                for (const pa of publishedAssets) {
                    const record = db.prepare('SELECT * FROM assets WHERE id = ?').get(pa.id);
                    if (!record) continue;
                    spokeService.forwardRequest('POST', '/api/sync/write', {
                        method: 'POST',
                        path: '/api/assets/spoke-register',
                        body: record,
                        headers: {},
                        spokeName: spokeService.localName,
                    }).then(() => {
                        console.log(`[Spoke] Forwarded asset ${pa.id} (${pa.vault_name}) to hub`);
                    }).catch(err => {
                        console.error(`[Spoke] Failed to forward asset ${pa.id} to hub:`, err.message);
                    });
                }
            });
        }

    } catch (err) {
        console.error('[publish-frame] Error:', err.message);
        try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
        res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════
//  SPOKE-REGISTER (Internal — hub-side asset insertion)
// ═══════════════════════════════════════════

/**
 * POST /api/assets/spoke-register
 * Internal endpoint used by spoke mode to register locally-created assets
 * (e.g., from publish-frame) on the hub's database so they survive DB syncs.
 * Accepts a full asset record and does an INSERT OR IGNORE.
 */
router.post('/spoke-register', (req, res) => {
    const db = getDb();
    const a = req.body;

    if (!a || !a.vault_name) {
        return res.status(400).json({ error: 'Asset data with vault_name is required' });
    }

    try {
        // Check if this asset already exists (by vault_name + project)
        const existing = db.prepare(
            'SELECT id FROM assets WHERE vault_name = ? AND project_id = ?'
        ).get(a.vault_name, a.project_id);

        if (existing) {
            return res.json({ success: true, id: existing.id, already_exists: true });
        }

        const result = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size, version,
                is_linked, status, notes, tags, starred,
                thumbnail_path, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            a.project_id || null,
            a.sequence_id || null,
            a.shot_id || null,
            a.role_id || null,
            a.original_name || a.vault_name,
            a.vault_name,
            a.file_path || '',
            a.relative_path || '',
            a.media_type || 'image',
            a.file_ext || '',
            a.file_size || 0,
            a.version || 1,
            a.is_linked || 0,
            a.status || null,
            a.notes || null,
            a.tags || null,
            a.starred || 0,
            a.thumbnail_path || null
        );

        const newId = Number(result.lastInsertRowid);

        logActivity('spoke_register', 'asset', newId,
            `Asset registered from spoke: ${a.vault_name}`);

        // Generate thumbnail on hub side — file should be accessible via NAS path mapping
        if (a.file_path) {
            const localPath = resolveFilePath(a.file_path);
            if (localPath && fs.existsSync(localPath)) {
                ThumbnailService.generate(localPath, newId)
                    .then(thumbPath => {
                        if (thumbPath) {
                            const thumbName = path.basename(thumbPath);
                            db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?')
                                .run(thumbName, newId);
                            console.log(`[spoke-register] Thumbnail generated for asset ${newId}`);
                        }
                    })
                    .catch(err => console.error(`[spoke-register] Thumbnail error: ${err.message}`));
            } else {
                console.log(`[spoke-register] File not accessible locally, skipping thumbnail: ${a.file_path}`);
            }
        }

        // Broadcast to spokes (hub mode) — so other spokes get the new asset
        const newAsset = db.prepare('SELECT * FROM assets WHERE id = ?').get(newId);
        if (newAsset) {
            req.app.locals.broadcastChange?.('assets', 'insert', { record: newAsset });
        }

        res.json({ success: true, id: newId });
    } catch (err) {
        console.error('[spoke-register] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
