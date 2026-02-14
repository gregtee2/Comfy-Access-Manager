/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - ComfyUI Integration Routes
 * API endpoints for ComfyUI custom nodes to browse, load, and save assets
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb, getSetting, logActivity } = require('../database');
const FileService = require('../services/FileService');
const ThumbnailService = require('../services/ThumbnailService');
const MediaInfoService = require('../services/MediaInfoService');
const { detectMediaType, isMediaFile } = require('../utils/mediaTypes');

// ═══════════════════════════════════════════
//  LOAD FROM VAULT (ComfyUI reads assets)
// ═══════════════════════════════════════════

// GET /api/comfyui/projects — List projects (for dropdown in ComfyUI node)
router.get('/projects', (req, res) => {
    const db = getDb();
    const projects = db.prepare(`
        SELECT id, name, code, type,
            (SELECT COUNT(*) FROM assets WHERE project_id = projects.id) as asset_count
        FROM projects
        ORDER BY name
    `).all();

    res.json(projects);
});

// GET /api/comfyui/sequences — List sequences (optionally filtered by project)
router.get('/sequences', (req, res) => {
    const { project_id } = req.query;
    const db = getDb();

    let query = `SELECT s.id, s.name, s.code, s.project_id, p.name as project_name
                 FROM sequences s
                 LEFT JOIN projects p ON p.id = s.project_id`;
    const params = [];

    if (project_id) { query += ' WHERE s.project_id = ?'; params.push(project_id); }
    query += ' ORDER BY s.sort_order, s.name';

    res.json(db.prepare(query).all(...params));
});

// GET /api/comfyui/shots — List shots (optionally filtered by sequence or project)
router.get('/shots', (req, res) => {
    const { project_id, sequence_id } = req.query;
    const db = getDb();

    let query = `SELECT sh.id, sh.name, sh.code, sh.sequence_id, sh.project_id,
                        seq.name as sequence_name
                 FROM shots sh
                 LEFT JOIN sequences seq ON seq.id = sh.sequence_id
                 WHERE 1=1`;
    const params = [];

    if (project_id) { query += ' AND sh.project_id = ?'; params.push(project_id); }
    if (sequence_id) { query += ' AND sh.sequence_id = ?'; params.push(sequence_id); }
    query += ' ORDER BY sh.sort_order, sh.name';

    res.json(db.prepare(query).all(...params));
});

// GET /api/comfyui/roles — List roles
router.get('/roles', (req, res) => {
    const db = getDb();
    const roles = db.prepare('SELECT id, name, code FROM roles ORDER BY sort_order, name').all();
    res.json(roles);
});

// GET /api/comfyui/assets — List assets filtered for ComfyUI (images/videos only)
router.get('/assets', (req, res) => {
    const { project_id, sequence_id, shot_id, role_id, media_type } = req.query;
    const db = getDb();

    let query = `SELECT id, vault_name, file_path, media_type, width, height, file_ext 
                 FROM assets WHERE 1=1`;
    const params = [];

    if (project_id) { query += ' AND project_id = ?'; params.push(project_id); }
    if (sequence_id) { query += ' AND sequence_id = ?'; params.push(sequence_id); }
    if (shot_id) { query += ' AND shot_id = ?'; params.push(shot_id); }
    if (role_id) { query += ' AND role_id = ?'; params.push(role_id); }
    if (media_type) {
        query += ' AND media_type = ?';
        params.push(media_type);
    } else {
        query += " AND media_type IN ('image', 'video', 'exr')";
    }

    query += ' ORDER BY vault_name';
    const assets = db.prepare(query).all(...params);

    res.json(assets);
});

// GET /api/comfyui/asset/:id/path — Get file path for a specific asset
// This is the key endpoint for ComfyUI: returns the absolute file path
router.get('/asset/:id/path', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT id, file_path, vault_name, media_type FROM assets WHERE id = ?')
        .get(req.params.id);

    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!fs.existsSync(asset.file_path)) {
        return res.status(404).json({ error: 'File missing from vault', expected: asset.file_path });
    }

    res.json({
        id: asset.id,
        path: asset.file_path,
        name: asset.vault_name,
        type: asset.media_type,
    });
});


// ═══════════════════════════════════════════
//  PERSISTENT MAPPING (Node remembers which asset)
// ═══════════════════════════════════════════

// POST /api/comfyui/mapping — Save which asset a ComfyUI node is using
router.post('/mapping', (req, res) => {
    const { workflow_id, node_id, asset_id } = req.body;
    if (!node_id || !asset_id) {
        return res.status(400).json({ error: 'node_id and asset_id required' });
    }

    const db = getDb();
    const asset = db.prepare('SELECT file_path FROM assets WHERE id = ?').get(asset_id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    db.prepare(`
        INSERT INTO comfyui_mappings (workflow_id, node_id, asset_id, file_path, last_used)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(workflow_id, node_id) DO UPDATE SET
            asset_id = excluded.asset_id,
            file_path = excluded.file_path,
            last_used = datetime('now')
    `).run(workflow_id || 'default', node_id, asset_id, asset.file_path);

    res.json({ success: true });
});

// GET /api/comfyui/mapping/:nodeId — Get the saved asset for a node
router.get('/mapping/:nodeId', (req, res) => {
    const { workflow_id } = req.query;
    const db = getDb();

    const mapping = db.prepare(`
        SELECT m.*, a.vault_name, a.media_type, a.width, a.height
        FROM comfyui_mappings m
        LEFT JOIN assets a ON a.id = m.asset_id
        WHERE m.node_id = ? AND m.workflow_id = ?
        ORDER BY m.last_used DESC LIMIT 1
    `).get(req.params.nodeId, workflow_id || 'default');

    if (!mapping) return res.status(404).json({ error: 'No mapping found' });

    // Verify file still exists
    if (!fs.existsSync(mapping.file_path)) {
        return res.status(404).json({
            error: 'Mapped file no longer exists',
            expected: mapping.file_path,
            asset_id: mapping.asset_id,
        });
    }

    res.json(mapping);
});


// ═══════════════════════════════════════════
//  SAVE TO VAULT (ComfyUI outputs → vault)
// ═══════════════════════════════════════════

// POST /api/comfyui/save — Save a ComfyUI output file into the vault
router.post('/save', async (req, res) => {
    const { file_path, project_id, sequence_id, shot_id, role_id, custom_name, node_id, workflow_id, generation_info } = req.body;

    if (!file_path) return res.status(400).json({ error: 'file_path required' });
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    if (!fs.existsSync(file_path)) return res.status(404).json({ error: 'File not found' });

    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
        const originalName = path.basename(file_path);
        const { type: mediaType } = detectMediaType(originalName);

        let sequence = null, shot = null, role = null;
        if (sequence_id) sequence = db.prepare('SELECT * FROM sequences WHERE id = ?').get(sequence_id);
        if (shot_id) shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(shot_id);
        if (role_id) role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);

        const imported = FileService.importFile(file_path, {
            projectCode: project.code,
            sequenceCode: sequence?.code,
            shotCode: shot?.code,
            roleCode: role?.code,
            customName: custom_name,
        });

        const info = await MediaInfoService.probe(imported.vaultPath);

        const result = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size,
                width, height, duration, fps, codec,
                comfyui_node_id, comfyui_workflow,
                version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            project.id, sequence?.id || null, shot?.id || null, role?.id || null,
            originalName, imported.vaultName, imported.vaultPath, imported.relativePath,
            imported.mediaType, path.extname(originalName).toLowerCase(),
            info.fileSize || 0, info.width, info.height, info.duration, info.fps, info.codec,
            node_id || null, workflow_id || null,
            1
        );

        const assetId = result.lastInsertRowid;

        // Store generation metadata if provided (model, sampler, scheduler, etc.)
        if (generation_info && typeof generation_info === 'object') {
            try {
                const existing = db.prepare('SELECT metadata FROM assets WHERE id = ?').get(assetId);
                const meta = JSON.parse(existing?.metadata || '{}');
                meta.generation = generation_info;
                db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), assetId);
            } catch (metaErr) {
                console.warn('[ComfyUI] Failed to save generation metadata:', metaErr.message);
            }
        }

        // Generate thumbnail
        try {
            const thumbPath = await ThumbnailService.generate(imported.vaultPath, assetId);
            if (thumbPath) {
                db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, assetId);
            }
        } catch {}

        // Save mapping if node_id provided
        if (node_id) {
            db.prepare(`
                INSERT INTO comfyui_mappings (workflow_id, node_id, asset_id, file_path, last_used)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(workflow_id, node_id) DO UPDATE SET
                    asset_id = excluded.asset_id,
                    file_path = excluded.file_path,
                    last_used = datetime('now')
            `).run(workflow_id || 'default', node_id, assetId, imported.vaultPath);
        }

        logActivity('comfyui_save', 'asset', assetId, {
            original: originalName,
            vault: imported.vaultName,
            node_id,
        });

        const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
        res.json(asset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
