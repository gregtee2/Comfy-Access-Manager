/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Flow Production Tracking Plugin — Backend Routes
 * Sync projects, sequences, shots, pipeline steps from Flow → CAM
 * Publish versions from CAM → Flow
 */

const express = require('express');
const router = express.Router();
const FlowService = require('./services/FlowService');
const PathMatchService = require('./services/PathMatchService');

/**
 * Initialize plugin with core API (dependency injection).
 * FlowService needs database access — pass it the database module.
 * @param {object} core - Core API from pluginLoader
 */
function init(core) {
    FlowService.setDatabase(core.database);
    PathMatchService.setDatabase(core.database);
}

// ─── Status / Config ───

// GET /api/flow/status — Check if Flow is configured and test connection
router.get('/status', async (req, res) => {
    try {
        const configured = FlowService.isConfigured();
        if (!configured) {
            return res.json({
                configured: false,
                connected: false,
                message: 'Flow not configured. Add credentials in Settings → Flow Production Tracking.'
            });
        }

        try {
            const result = await FlowService.testConnection();
            res.json({
                configured: true,
                connected: true,
                server_info: result.server_info,
            });
        } catch (err) {
            res.json({
                configured: true,
                connected: false,
                error: err.message,
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/flow/test — Test Flow connection
router.post('/test', async (req, res) => {
    try {
        const result = await FlowService.testConnection();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Sync Operations ───

// POST /api/flow/sync/projects — Fetch projects from Flow and create/update locally
router.post('/sync/projects', async (req, res) => {
    try {
        const result = await FlowService.syncProjects();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/sync/steps — Fetch pipeline steps → roles
router.post('/sync/steps', async (req, res) => {
    try {
        const result = await FlowService.syncSteps();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/sync/sequences — Fetch sequences for a project
// Body: { flowProjectId, localProjectId }
router.post('/sync/sequences', async (req, res) => {
    const { flowProjectId, localProjectId } = req.body;
    if (!flowProjectId || !localProjectId) {
        return res.status(400).json({ error: 'flowProjectId and localProjectId required' });
    }

    try {
        const result = await FlowService.syncSequences(flowProjectId, localProjectId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/sync/shots — Fetch shots for a project
// Body: { flowProjectId, localProjectId }
router.post('/sync/shots', async (req, res) => {
    const { flowProjectId, localProjectId } = req.body;
    if (!flowProjectId || !localProjectId) {
        return res.status(400).json({ error: 'flowProjectId and localProjectId required' });
    }

    try {
        const result = await FlowService.syncShots(flowProjectId, localProjectId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/sync/full — Full sync: steps + sequences + shots + tasks for a project
// Body: { flowProjectId, localProjectId }
router.post('/sync/full', async (req, res) => {
    const { flowProjectId, localProjectId } = req.body;
    if (!flowProjectId || !localProjectId) {
        return res.status(400).json({ error: 'flowProjectId and localProjectId required' });
    }

    try {
        const result = await FlowService.fullSync(flowProjectId, localProjectId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Tasks ───

// POST /api/flow/sync/tasks — Fetch tasks for a project
// Body: { flowProjectId, localProjectId }
router.post('/sync/tasks', async (req, res) => {
    const { flowProjectId, localProjectId } = req.body;
    if (!flowProjectId || !localProjectId) {
        return res.status(400).json({ error: 'flowProjectId and localProjectId required' });
    }

    try {
        const result = await FlowService.syncTasks(flowProjectId, localProjectId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/flow/tasks/:projectId — Get locally synced tasks for a project
router.get('/tasks/:projectId', (req, res) => {
    const { projectId } = req.params;
    const { entityType, entityFlowId, status } = req.query;

    try {
        const tasks = FlowService.getTasks(parseInt(projectId), {
            entityType,
            entityFlowId: entityFlowId ? parseInt(entityFlowId) : null,
            status,
        });
        res.json(tasks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/flow/tasks/:flowTaskId/status — Update a task's status in Flow
// Body: { status }
router.post('/tasks/:flowTaskId/status', async (req, res) => {
    const { flowTaskId } = req.params;
    const { status } = req.body;
    if (!status) {
        return res.status(400).json({ error: 'status required' });
    }

    try {
        const result = await FlowService.updateTaskStatus(parseInt(flowTaskId), status);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Publish ───

// POST /api/flow/publish/version — Create a Version in Flow from a CAM asset
// Body: { assetId, flowProjectId, flowShotId?, code?, description? }
router.post('/publish/version', async (req, res) => {
    const { assetId, flowProjectId } = req.body;
    if (!assetId || !flowProjectId) {
        return res.status(400).json({ error: 'assetId and flowProjectId required' });
    }

    try {
        const result = await FlowService.publishVersion(req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/publish/thumbnail — Upload thumbnail to a Flow Version
// Body: { flowVersionId, thumbnailPath }
router.post('/publish/thumbnail', async (req, res) => {
    const { flowVersionId, thumbnailPath } = req.body;
    if (!flowVersionId || !thumbnailPath) {
        return res.status(400).json({ error: 'flowVersionId and thumbnailPath required' });
    }

    try {
        const result = await FlowService.uploadThumbnail(flowVersionId, thumbnailPath);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/publish/media — Upload review media (mov/mp4) to a Flow Version for Screening Room
// Body: { flowVersionId, mediaPath, field? }
router.post('/publish/media', async (req, res) => {
    const { flowVersionId, mediaPath, field } = req.body;
    if (!flowVersionId || !mediaPath) {
        return res.status(400).json({ error: 'flowVersionId and mediaPath required' });
    }

    try {
        const result = await FlowService.uploadMedia(flowVersionId, mediaPath, field || 'sg_uploaded_movie');
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/publish/note — Export a CAM review note as a ShotGrid Note with attachment
// Body: { reviewNoteId, flowProjectId, flowShotId?, flowVersionId?, subject?, body? }
router.post('/publish/note', async (req, res) => {
    const { reviewNoteId, flowProjectId } = req.body;
    if (!reviewNoteId || !flowProjectId) {
        return res.status(400).json({ error: 'reviewNoteId and flowProjectId required' });
    }

    const database = require('../../src/database');
    const db = database.getDb();
    const path = require('path');

    // Load the review note
    const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(reviewNoteId);
    if (!note) {
        return res.status(404).json({ error: 'Review note not found' });
    }

    // Build subject line
    let subject = req.body.subject;
    if (!subject) {
        let assetName = '';
        if (note.asset_id) {
            const asset = db.prepare('SELECT vault_name FROM assets WHERE id = ?').get(note.asset_id);
            assetName = asset ? asset.vault_name : '';
        }
        const frameStr = note.frame_number != null ? ` F${note.frame_number}` : '';
        subject = `Review Note: ${assetName}${frameStr}`.trim();
    }

    // Build body
    const body = req.body.body || note.note_text || '';

    // Resolve annotation image path on disk
    let attachmentPath = null;
    if (note.annotation_image) {
        const DATA_DIR = process.env.CAM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
        const fullPath = path.join(DATA_DIR, 'review-snapshots', note.annotation_image);
        const fs = require('fs');
        if (fs.existsSync(fullPath)) {
            attachmentPath = fullPath;
        }
    }

    try {
        const result = await FlowService.createNote({
            flowProjectId,
            subject,
            body,
            flowShotId: req.body.flowShotId || null,
            flowVersionId: req.body.flowVersionId || null,
            addresseeIds: req.body.addresseeIds || null,
            attachmentPath,
            reviewNoteId: note.id,
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/publish/annotated-frame — Direct RV-to-ShotGrid annotated frame export.
// Called by the RV plugin to send an annotated frame directly to ShotGrid in one step.
// Saves the frame locally as a review note AND creates a ShotGrid Note with attachment.
// Body: { renderedFramePath, sourcePath?, frameNumber, noteText? }
router.post('/publish/annotated-frame', async (req, res) => {
    const { renderedFramePath, sourcePath, frameNumber, noteText } = req.body || {};

    if (!renderedFramePath) {
        return res.status(400).json({ error: 'renderedFramePath is required' });
    }
    if (frameNumber == null) {
        return res.status(400).json({ error: 'frameNumber is required' });
    }

    const database = require('../../src/database');
    const db = database.getDb();
    const path = require('path');
    const fs = require('fs');

    // Verify the rendered file exists
    if (!fs.existsSync(renderedFramePath)) {
        return res.status(400).json({ error: 'Rendered frame file not found: ' + renderedFramePath });
    }

    // ─── Resolve asset from sourcePath ───
    let asset = null;
    if (sourcePath) {
        try {
            const normalizedPath = sourcePath.replace(/\\/g, '/');
            asset = db.prepare(
                `SELECT a.*, p.code AS project_code, p.name AS project_name, p.flow_id AS project_flow_id,
                        s.flow_id AS shot_flow_id, s.code AS shot_code,
                        seq.flow_id AS sequence_flow_id, seq.code AS sequence_code
                 FROM assets a
                 LEFT JOIN projects p ON a.project_id = p.id
                 LEFT JOIN shots s ON a.shot_id = s.id
                 LEFT JOIN sequences seq ON a.sequence_id = seq.id
                 WHERE replace(a.file_path, '\\', '/') = ?
                 LIMIT 1`
            ).get(normalizedPath);
        } catch { /* non-critical */ }
    }

    // ─── Check Flow is configured and we have project mapping ───
    const configured = FlowService.isConfigured();
    if (!configured) {
        return res.status(400).json({ error: 'Flow Production Tracking is not configured. Add credentials in Settings.' });
    }

    const flowProjectId = asset?.project_flow_id;
    if (!flowProjectId) {
        return res.status(400).json({
            error: 'Cannot resolve Flow project. Ensure the asset\'s project is synced with Flow.',
            hint: sourcePath ? `Asset not found or project not linked: ${sourcePath}` : 'No sourcePath provided',
        });
    }

    // ─── Save the frame locally (same logic as review notes) ───
    const DATA_DIR = process.env.CAM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
    const snapshotsBase = path.join(DATA_DIR, 'review-snapshots');

    const projectCode = (asset.project_code || asset.project_name || 'GENERAL').replace(/[^a-zA-Z0-9_-]/g, '_');
    const today = new Date();
    const dateFolder = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const snapshotsDir = path.join(snapshotsBase, projectCode, dateFolder);
    if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `flow_annot_f${frameNumber}_${timestamp}.png`;
    const relativePath = path.join(projectCode, dateFolder, filename).replace(/\\/g, '/');
    const destPath = path.join(snapshotsDir, filename);

    try {
        fs.copyFileSync(renderedFramePath, destPath);
    } catch (err) {
        console.error('[Flow] Failed to copy annotated frame:', err.message);
        return res.status(500).json({ error: 'Failed to save annotated frame' });
    }

    // ─── Create a local review note (so it also shows in the Notes UI) ───
    const author = req.headers['x-cam-user'] || 'Unknown';
    const text = (noteText && noteText.trim()) || `Annotated frame ${frameNumber}`;

    // Find the most recent active session (if any) for the local note
    let sessionId = null;
    try {
        const session = db.prepare(
            `SELECT id FROM review_sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`
        ).get();
        if (session) sessionId = session.id;
    } catch { /* no session — OK, note will have null session_id */ }

    let reviewNoteId = null;
    try {
        const result = db.prepare(`
            INSERT INTO review_notes (session_id, asset_id, frame_number, note_text, author, annotation_image)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(sessionId, asset?.id || null, frameNumber, text, author, relativePath);
        reviewNoteId = Number(result.lastInsertRowid);
    } catch (err) {
        console.error('[Flow] Failed to create local review note:', err.message);
        // Non-fatal — continue with Flow publish
    }

    // ─── Build ShotGrid Note ───
    const assetName = asset?.vault_name || 'Unknown';
    const shotCode = asset?.shot_code || '';
    const subject = `Review Note: ${shotCode ? shotCode + ' – ' : ''}${assetName} F${frameNumber}`;

    try {
        const result = await FlowService.createNote({
            flowProjectId,
            subject,
            body: text,
            flowShotId: asset?.shot_flow_id || null,
            flowVersionId: null,
            addresseeIds: null,
            attachmentPath: destPath,
            reviewNoteId,
        });

        // Clean up temp file from RV
        try { fs.unlinkSync(renderedFramePath); } catch { /* already cleaned */ }

        // Broadcast the note creation for the UI
        if (reviewNoteId) {
            const note = db.prepare('SELECT * FROM review_notes WHERE id = ?').get(reviewNoteId);
            if (note) {
                note.asset_name = assetName;
                req.app.locals.broadcastChange?.('review_notes', 'insert', { record: note });
            }
        }

        res.json({
            success: true,
            flowNote: result.note,
            attachmentId: result.attachment_id,
            reviewNoteId,
            message: `Annotation sent to ShotGrid: ${subject}`,
        });
    } catch (err) {
        // Clean up temp file even on failure
        try { fs.unlinkSync(renderedFramePath); } catch { /* OK */ }
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Mappings ───

// GET /api/flow/mappings/projects — Get local projects linked to Flow
router.get('/mappings/projects', (req, res) => {
    try {
        const mappings = FlowService.getProjectMappings();
        res.json(mappings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/flow/projects — Fetch projects directly from Flow (preview, no save)
router.get('/projects', async (req, res) => {
    try {
        const result = await FlowService.execute('sync_projects');
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Path Matching + Bulk Scan ───

// GET /api/flow/path-config — Get current path pattern and show root
router.get('/path-config', (req, res) => {
    res.json({
        showRoot: PathMatchService.getShowRoot(),
        pattern: PathMatchService.getPattern(),
    });
});

// POST /api/flow/path-config — Save path pattern and show root
// Body: { showRoot, pattern }
router.post('/path-config', (req, res) => {
    const { showRoot, pattern } = req.body;
    const database = require('../../src/database');
    if (showRoot !== undefined) database.setSetting('flow_show_root', showRoot);
    if (pattern !== undefined)  database.setSetting('flow_path_pattern', pattern);
    res.json({ success: true, showRoot: PathMatchService.getShowRoot(), pattern: PathMatchService.getPattern() });
});

// POST /api/flow/scan-tree — Recursively scan a directory, register in-place, auto-match
// Body: { rootDir, dryRun?, maxFiles? }
router.post('/scan-tree', (req, res) => {
    const { rootDir, dryRun, maxFiles } = req.body;
    if (!rootDir) return res.status(400).json({ error: 'rootDir required' });

    const fs = require('fs');
    if (!fs.existsSync(rootDir)) {
        return res.status(400).json({ error: 'Directory does not exist: ' + rootDir });
    }

    try {
        const result = PathMatchService.scanAndRegisterTree(rootDir, {
            dryRun: !!dryRun,
            maxFiles: maxFiles || 50000,
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/auto-match — Run auto-match on all unassigned assets
// Body: { projectId? }
router.post('/auto-match', (req, res) => {
    try {
        const result = PathMatchService.matchAllUnassigned({
            projectId: req.body.projectId || null,
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/auto-match/:assetId — Auto-match a single asset
router.post('/auto-match/:assetId', (req, res) => {
    try {
        const result = PathMatchService.matchAsset(parseInt(req.params.assetId));
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/flow/preview-match — Preview path matching without registering
// Body: { filePath }
router.post('/preview-match', (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });

    const tokens = PathMatchService.parsePath(filePath);
    const resolved = tokens ? PathMatchService.resolveTokens(tokens) : null;
    res.json({ tokens, resolved });
});

module.exports = router;
module.exports.init = init;
