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

/**
 * Initialize plugin with core API (dependency injection).
 * FlowService needs database access — pass it the database module.
 * @param {object} core - Core API from pluginLoader
 */
function init(core) {
    FlowService.setDatabase(core.database);
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

// POST /api/flow/sync/full — Full sync: steps + sequences + shots for a project
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

module.exports = router;
module.exports.init = init;
