/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault — Transcode Routes
 * API for derivative generation: queue jobs, check progress, list formats.
 */

const express = require('express');
const router = express.Router();
const TranscodeService = require('../services/TranscodeService');

// ═══════════════════════════════════════════
//  GET /api/transcode/formats — Available derivative presets
// ═══════════════════════════════════════════

router.get('/formats', (req, res) => {
    res.json(TranscodeService.getFormats());
});

// ═══════════════════════════════════════════
//  POST /api/transcode/queue — Queue a derivative job
// ═══════════════════════════════════════════

router.post('/queue', (req, res) => {
    const { sourceAssetId, formatKey, fps } = req.body;

    if (!sourceAssetId) return res.status(400).json({ error: 'sourceAssetId required' });
    if (!formatKey) return res.status(400).json({ error: 'formatKey required' });

    const formats = TranscodeService.getFormats();
    if (!formats[formatKey]) {
        return res.status(400).json({ error: `Unknown format: ${formatKey}. Available: ${Object.keys(formats).join(', ')}` });
    }

    const jobId = TranscodeService.queueDerivative(sourceAssetId, formatKey, { fps: fps || 24 });

    res.json({ jobId, message: `Queued ${formatKey} derivative for asset ${sourceAssetId}` });
});

// ═══════════════════════════════════════════
//  POST /api/transcode/queue-batch — Queue multiple derivatives at once
// ═══════════════════════════════════════════

router.post('/queue-batch', (req, res) => {
    const { sourceAssetIds, formatKeys, fps } = req.body;

    if (!Array.isArray(sourceAssetIds) || sourceAssetIds.length === 0) {
        return res.status(400).json({ error: 'sourceAssetIds array required' });
    }
    if (!Array.isArray(formatKeys) || formatKeys.length === 0) {
        return res.status(400).json({ error: 'formatKeys array required' });
    }

    const jobIds = [];
    for (const assetId of sourceAssetIds) {
        for (const fmt of formatKeys) {
            const jobId = TranscodeService.queueDerivative(assetId, fmt, { fps: fps || 24 });
            jobIds.push(jobId);
        }
    }

    res.json({
        jobIds,
        total: jobIds.length,
        message: `Queued ${jobIds.length} derivative job(s)`,
    });
});

// ═══════════════════════════════════════════
//  GET /api/transcode/status/:jobId — Check job progress
// ═══════════════════════════════════════════

router.get('/status/:jobId', (req, res) => {
    const job = TranscodeService.getJob(parseInt(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// ═══════════════════════════════════════════
//  GET /api/transcode/jobs — List all active + recent jobs
// ═══════════════════════════════════════════

router.get('/jobs', (req, res) => {
    const all = TranscodeService.getAllJobs();
    res.json(all);
});

// ═══════════════════════════════════════════
//  GET /api/transcode/active — Only queued/running jobs
// ═══════════════════════════════════════════

router.get('/active', (req, res) => {
    res.json(TranscodeService.getActiveJobs());
});

// ═══════════════════════════════════════════
//  POST /api/transcode/clear — Clear completed/failed jobs
// ═══════════════════════════════════════════

router.post('/clear', (req, res) => {
    TranscodeService.clearCompletedJobs();
    res.json({ message: 'Cleared completed jobs' });
});

module.exports = router;
