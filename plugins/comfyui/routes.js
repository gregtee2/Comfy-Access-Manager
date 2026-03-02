/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * ComfyUI Integration Plugin — Routes
 * API endpoints for ComfyUI custom nodes to browse, load, and save assets.
 * Also handles workflow extraction from generated media files.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

// ─── Core API (injected via init) ───
let core = null;

function init(coreAPI) {
    core = coreAPI;
}

// ─── Lazy accessors for core services ───
function getDb() { return core.database.getDb(); }
function getSetting(k) { return core.database.getSetting(k); }
function logActivity(...a) { return core.database.logActivity(...a); }
function FileService() { return core.services.FileService; }
function ThumbnailService() { return core.services.ThumbnailService; }
function MediaInfoService() { return core.services.MediaInfoService; }
function detectMediaType(f) { return core.utils.mediaTypes.detectMediaType(f); }
function resolveFilePath(p) { return core.utils.pathResolver.resolveFilePath(p); }
function generateFromConvention(...a) { return core.utils.naming.generateFromConvention(...a); }
function getNextVersion(...a) { return core.utils.naming.getNextVersion(...a); }


// ═══════════════════════════════════════════
//  LOAD FROM VAULT (ComfyUI reads assets)
// ═══════════════════════════════════════════

// GET /projects — List projects (for dropdown in ComfyUI node)
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

// GET /sequences — List sequences (optionally filtered by project)
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

// GET /shots — List shots (optionally filtered by sequence or project)
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

// GET /roles — List roles
router.get('/roles', (req, res) => {
    const db = getDb();
    const roles = db.prepare('SELECT id, name, code FROM roles ORDER BY sort_order, name').all();
    res.json(roles);
});

// GET /assets — List assets filtered for ComfyUI (images/videos only)
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
    res.json(db.prepare(query).all(...params));
});

// GET /asset/:id/path — Get file path for a specific asset
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

// POST /mapping — Save which asset a ComfyUI node is using
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

// GET /mapping/:nodeId — Get the saved asset for a node
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

// POST /save — Save a ComfyUI output file into the vault
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

        // Check if project has a Shot Builder naming convention
        let overrideVaultName = null;
        if (project.naming_convention) {
            try {
                const convention = JSON.parse(project.naming_convention);
                const ext = path.extname(originalName).toLowerCase();

                // Auto-detect next version for this context
                const vaultRoot = getSetting('vault_root');
                let nextVersion = 1;
                if (vaultRoot) {
                    const vaultDir = path.join(vaultRoot, project.code,
                        sequence?.code || '', shot?.code || '');
                    nextVersion = getNextVersion(vaultDir, role?.code || 'output');
                }

                const result = generateFromConvention(convention, {
                    project: project.code,
                    sequence: sequence?.name || '',
                    shot: shot?.name || '',
                    role: role?.code || 'output',
                    version: nextVersion,
                    episode: project.episode || '',
                    take: 1,
                    counter: 1,
                }, ext);
                if (result) overrideVaultName = result.vaultName;
            } catch (e) {
                console.warn('[ComfyUI] Failed to apply naming convention, using default:', e.message);
            }
        }

        const imported = FileService().importFile(file_path, {
            projectCode: project.code,
            sequenceCode: sequence?.code,
            shotCode: shot?.code,
            roleCode: role?.code,
            customName: custom_name,
            overrideVaultName,
        });

        const info = await MediaInfoService().probe(imported.vaultPath);

        const result = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size,
                width, height, duration, fps, codec,
                comfyui_node_id, comfyui_workflow,
                version, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
            const thumbPath = await ThumbnailService().generate(imported.vaultPath, assetId);
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


// ═══════════════════════════════════════════
//  COMFYUI WORKFLOW EXTRACTION & LOADING
// ═══════════════════════════════════════════

/**
 * Extract embedded ComfyUI workflow JSON from a media file.
 * - Video (MP4/WebM): Stored in ffprobe format.tags.comment
 * - PNG: Stored in tEXt chunk with keyword "workflow"
 * Returns the parsed JSON object or null.
 */
function extractWorkflowFromFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    // ── Video files: workflow in comment metadata tag ──
    if (['.mp4', '.webm', '.mkv', '.mov', '.avi'].includes(ext)) {
        return extractVideoWorkflow(filePath);
    }

    // ── PNG files: workflow in tEXt chunk ──
    if (ext === '.png') {
        return extractPngWorkflow(filePath);
    }

    // ── TIFF/TIF files: workflow in EXIF/metadata tags (same as video approach) ──
    if (ext === '.tif' || ext === '.tiff') {
        return extractVideoWorkflow(filePath); // ffprobe reads TIFF metadata too
    }

    return null;
}

function extractVideoWorkflow(filePath) {
    const ffprobe = MediaInfoService().findFFprobe();
    if (!ffprobe) return null;

    try {
        const out = execFileSync(ffprobe, [
            '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
        ], { maxBuffer: 20 * 1024 * 1024, timeout: 15000, windowsHide: true }).toString();

        const info = JSON.parse(out);
        const comment = info.format?.tags?.comment || info.format?.tags?.Comment;
        if (!comment) return null;

        const parsed = JSON.parse(comment);
        // VHS stores the graph directly; some tools wrap in { workflow: {...} }
        if (parsed.nodes && parsed.links) return parsed;
        if (parsed.workflow?.nodes) return parsed.workflow;
        return parsed;
    } catch (e) {
        console.error('[ComfyUI] Video workflow extraction failed:', e.message);
        return null;
    }
}

function extractPngWorkflow(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        // Verify PNG signature
        if (buffer.length < 8 || buffer.toString('hex', 0, 4) !== '89504e47') return null;

        let offset = 8; // Skip 8-byte PNG signature
        while (offset + 8 < buffer.length) {
            const length = buffer.readUInt32BE(offset);
            const type = buffer.toString('ascii', offset + 4, offset + 8);

            if (type === 'tEXt' && length > 0) {
                const chunkData = buffer.slice(offset + 8, offset + 8 + length);
                const nullIdx = chunkData.indexOf(0);
                if (nullIdx > 0) {
                    const keyword = chunkData.toString('ascii', 0, nullIdx);
                    if (keyword === 'workflow') {
                        const value = chunkData.toString('utf8', nullIdx + 1);
                        return JSON.parse(value);
                    }
                }
            }

            if (type === 'IEND') break;
            offset += 12 + length; // 4 len + 4 type + data + 4 CRC
        }
        return null;
    } catch (e) {
        console.error('[ComfyUI] PNG workflow extraction failed:', e.message);
        return null;
    }
}

/**
 * POST JSON data to a URL. Returns a promise.
 */
function httpPost(url, data) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const postData = JSON.stringify(data);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, body }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(postData);
        req.end();
    });
}

/**
 * Check if ComfyUI is running by hitting its root URL.
 */
function checkComfyUI(comfyUrl) {
    return new Promise((resolve) => {
        const parsed = new URL(comfyUrl);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: '/',
            method: 'GET',
        }, (res) => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
        req.end();
    });
}

// GET /status — Check if ComfyUI is reachable
router.get('/status', async (req, res) => {
    const comfyUrl = getSetting('comfyui_url') || 'http://127.0.0.1:8188';
    const running = await checkComfyUI(comfyUrl);
    res.json({ running, url: comfyUrl });
});

// GET /check-workflow/:id — Check if an asset has an embedded workflow
router.get('/check-workflow/:id', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT id, file_path, vault_name, media_type, file_ext FROM assets WHERE id = ?')
        .get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const resolved = resolveFilePath(asset.file_path);
    if (!fs.existsSync(resolved)) {
        return res.json({ hasWorkflow: false, reason: 'File not found on disk' });
    }

    const workflow = extractWorkflowFromFile(resolved);
    res.json({
        hasWorkflow: !!workflow,
        nodeCount: workflow?.nodes?.length || 0,
    });
});

// POST /load-in-comfy/:id — Extract workflow and send to ComfyUI
router.post('/load-in-comfy/:id', async (req, res) => {
    try {
        const comfyUrl = getSetting('comfyui_url') || 'http://127.0.0.1:8188';

        // 1. Check if ComfyUI is running
        const running = await checkComfyUI(comfyUrl);
        if (!running) {
            return res.status(503).json({
                success: false,
                error: 'ComfyUI is not running. Start ComfyUI first.',
            });
        }

        // 2. Get asset from DB
        const db = getDb();
        const asset = db.prepare('SELECT id, file_path, vault_name, media_type, file_ext FROM assets WHERE id = ?')
            .get(req.params.id);
        if (!asset) {
            return res.status(404).json({ success: false, error: 'Asset not found' });
        }

        // 3. Resolve path and check file exists
        const resolved = resolveFilePath(asset.file_path);
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({
                success: false,
                error: 'File not found on disk: ' + resolved,
            });
        }

        // 4. Extract workflow from file metadata
        const workflow = extractWorkflowFromFile(resolved);
        if (!workflow) {
            return res.status(422).json({
                success: false,
                error: 'No ComfyUI workflow found in this file\'s metadata.',
            });
        }

        // 5. POST workflow to ComfyUI's pending endpoint
        const result = await httpPost(comfyUrl + '/mediavault/load-workflow', workflow);
        if (result.status !== 200 || !result.body?.success) {
            const hint = result.status === 404
                ? ' — The /mediavault/load-workflow route was not found. Restart ComfyUI to load the updated MediaVault plugin.'
                : '';
            return res.status(502).json({
                success: false,
                error: 'Failed to send workflow to ComfyUI (HTTP ' + result.status + ')' + hint,
            });
        }

        logActivity('comfyui_load', 'asset', asset.id, {
            name: asset.vault_name,
            nodes: workflow.nodes?.length || 0,
        });

        res.json({
            success: true,
            comfyUrl,
            nodeCount: workflow.nodes?.length || 0,
            assetName: asset.vault_name,
        });

    } catch (err) {
        console.error('[ComfyUI] load-in-comfy error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /send-to-comfy — Send selected assets to ComfyUI as LoadFromMediaVault nodes
router.post('/send-to-comfy', async (req, res) => {
    try {
        const comfyUrl = getSetting('comfyui_url') || 'http://127.0.0.1:8188';

        // 1. Check if ComfyUI is running
        const running = await checkComfyUI(comfyUrl);
        if (!running) {
            return res.status(503).json({
                success: false,
                error: 'ComfyUI is not running. Start ComfyUI first.',
            });
        }

        // 2. Get asset IDs from request
        const { assetIds } = req.body;
        if (!assetIds || !Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ success: false, error: 'assetIds array required' });
        }

        // 3. Look up each asset with its full hierarchy
        const db = getDb();
        const assets = [];
        for (const id of assetIds) {
            const asset = db.prepare(`
                SELECT a.id, a.vault_name, a.file_path, a.media_type,
                       a.project_id, a.sequence_id, a.shot_id, a.role_id,
                       p.name as project_name, p.code as project_code,
                       sq.name as sequence_name, sq.code as sequence_code,
                       sh.name as shot_name, sh.code as shot_code,
                       r.name as role_name, r.code as role_code
                FROM assets a
                LEFT JOIN projects p ON p.id = a.project_id
                LEFT JOIN sequences sq ON sq.id = a.sequence_id
                LEFT JOIN shots sh ON sh.id = a.shot_id
                LEFT JOIN roles r ON r.id = a.role_id
                WHERE a.id = ?
            `).get(id);
            if (asset) assets.push(asset);
        }

        if (assets.length === 0) {
            return res.status(404).json({ success: false, error: 'No valid assets found' });
        }

        // 4. Build asset metadata for ComfyUI nodes
        const assetData = assets.map(a => ({
            id: a.id,
            vault_name: a.vault_name,
            project: a.project_name && a.project_code ? `${a.project_name} (${a.project_code})` : '(Load MediaVault...)',
            sequence: a.sequence_name && a.sequence_code ? `${a.sequence_name} (${a.sequence_code})` : '* (All Sequences)',
            shot: a.shot_name && a.shot_code ? `${a.shot_name} (${a.shot_code})` : '* (All Shots)',
            role: a.role_name && a.role_code ? `${a.role_name} (${a.role_code})` : '* (All Roles)',
        }));

        // 5. POST to ComfyUI's pending-send endpoint
        console.log(`[ComfyUI] send-to-comfy: POSTing ${assetData.length} asset(s) to ${comfyUrl}/mediavault/send-assets`);
        console.log(`[ComfyUI] send-to-comfy: Asset data:`, JSON.stringify(assetData, null, 2));
        const result = await httpPost(comfyUrl + '/mediavault/send-assets', { assets: assetData });
        console.log(`[ComfyUI] send-to-comfy: ComfyUI response — status=${result.status}, body=`, result.body);
        if (result.status !== 200 || !result.body?.success) {
            const hint = result.status === 404
                ? ' — Restart ComfyUI to load the updated MediaVault plugin.'
                : '';
            return res.status(502).json({
                success: false,
                error: 'Failed to send assets to ComfyUI (HTTP ' + result.status + ')' + hint,
            });
        }

        logActivity('comfyui_send', 'asset', assets[0].id, {
            count: assets.length,
            names: assets.map(a => a.vault_name),
        });

        res.json({
            success: true,
            comfyUrl,
            assetCount: assets.length,
        });

    } catch (err) {
        console.error('[ComfyUI] send-to-comfy error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
module.exports.init = init;
