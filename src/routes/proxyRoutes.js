/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Proxy Routes — Generate EXR proxy sequences for faster playback.
 *
 * Two modes:
 *   halfres  — FFmpeg: half resolution, half-float, ZIP16 compression (~5-10 MB/frame)
 *   fullres  — oiiotool: full resolution, DWAB lossy compression (~3-8 MB/frame)
 *
 * FFmpeg's EXR encoder only supports none/rle/zip1/zip16 — NO DWA/DWAB.
 * oiiotool (OpenImageIO, ASWF Apache 2.0) supports all EXR compressions including DWAB.
 *
 * Proxies are stored in data/proxies/<asset_id>/ using the same frame_pattern
 * as the original.
 *
 * Endpoints:
 *   POST   /api/proxy/generate/:id   — Queue proxy generation (body: { mode: 'halfres'|'fullres' })
 *   GET    /api/proxy/status/:jobId   — Poll job progress
 *   GET    /api/proxy/info/:id        — Check if proxy exists for an asset
 *   GET    /api/proxy/oiio-status     — Check if oiiotool is available
 *   DELETE /api/proxy/:id             — Delete proxy files and clear DB column
 */

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDb } = require('../database');
const { findFFmpeg } = require('../utils/ffmpegUtils');
const { findOiiotool, isOiiotoolAvailable } = require('../utils/oiioUtils');
const { resolveFilePath } = require('../utils/pathResolver');

// ═══════════════════════════════════════════
//  JOB QUEUE (in-memory, same pattern as TranscodeService)
// ═══════════════════════════════════════════

const jobs = new Map();
let nextJobId = 1;
let processing = false;
const queue = [];

/**
 * Get the root directory for proxy storage.
 * Respects CAM_DATA_DIR env var for spoke setups.
 */
function getProxyRoot() {
    const dataDir = process.env.CAM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
    return path.join(dataDir, 'proxies');
}

// ═══════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════

/**
 * POST /generate/:id — Queue proxy generation for an EXR sequence.
 * Body: { mode: 'halfres' | 'fullres' }  (default: 'halfres')
 *   - halfres: FFmpeg half-res, half-float, ZIP16  (~5-10 MB/frame)
 *   - fullres: oiiotool full-res, DWAB compression (~3-8 MB/frame)
 * Returns immediately with a jobId for polling.
 */
router.post('/generate/:id', (req, res) => {
    const db = getDb();
    const assetId = parseInt(req.params.id);
    if (isNaN(assetId)) return res.status(400).json({ error: 'Invalid asset ID' });

    const mode = (req.body?.mode === 'fullres') ? 'fullres' : 'halfres';

    // Validate oiiotool availability for fullres mode
    if (mode === 'fullres' && !isOiiotoolAvailable()) {
        return res.status(400).json({
            error: 'oiiotool not found. Full-res DWAB proxy requires OpenImageIO (oiiotool). Install via: brew install openimageio (Mac), apt install openimageio-tools (Linux), or the CAM installer (Windows).'
        });
    }

    const asset = db.prepare(
        'SELECT id, is_sequence, frame_pattern, frame_start, frame_end, frame_count, file_path, proxy_path, vault_name FROM assets WHERE id = ?'
    ).get(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.is_sequence) return res.status(400).json({ error: 'Proxy generation is only supported for image sequences' });
    if (!asset.frame_pattern) return res.status(400).json({ error: 'Asset has no frame pattern' });

    // Already generating?
    const existing = [...jobs.values()].find(
        j => j.assetId === assetId && (j.status === 'queued' || j.status === 'running')
    );
    if (existing) return res.json({ jobId: existing.id, status: existing.status, progress: existing.progress });

    // Proxy already exists?
    const proxyDir = path.join(getProxyRoot(), String(assetId));
    if (asset.proxy_path && fs.existsSync(proxyDir)) {
        // Quick sanity check — does the directory have any files?
        const files = fs.readdirSync(proxyDir).filter(f => f.endsWith('.exr'));
        if (files.length > 0) {
            return res.json({ jobId: null, status: 'exists', proxy_path: asset.proxy_path, frameCount: files.length });
        }
    }

    // Queue the job
    const jobId = nextJobId++;
    const job = {
        id: jobId,
        assetId,
        assetName: asset.vault_name || `asset_${assetId}`,
        mode,                   // 'halfres' or 'fullres'
        status: 'queued',       // queued | running | completed | failed
        progress: 0,            // 0-100
        progressText: 'Queued...',
        error: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
    };
    jobs.set(jobId, job);
    queue.push(jobId);
    console.log(`[Proxy] Queued job #${jobId}: asset ${assetId} (${asset.vault_name})`);

    // Kick off processing
    processNext();

    res.json({ jobId, status: 'queued' });
});

/**
 * GET /status/:jobId — Poll job progress.
 */
router.get('/status/:jobId', (req, res) => {
    const job = jobs.get(parseInt(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
        id: job.id,
        assetId: job.assetId,
        assetName: job.assetName,
        status: job.status,
        progress: job.progress,
        progressText: job.progressText,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
    });
});

/**
 * GET /info/:id — Check proxy status for an asset.
 * Returns { hasProxy, proxy_path, frameCount, totalSize }.
 */
router.get('/info/:id', (req, res) => {
    const db = getDb();
    const assetId = parseInt(req.params.id);
    const asset = db.prepare('SELECT proxy_path, is_sequence FROM assets WHERE id = ?').get(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const proxyDir = path.join(getProxyRoot(), String(assetId));
    if (asset.proxy_path && fs.existsSync(proxyDir)) {
        const files = fs.readdirSync(proxyDir).filter(f => f.endsWith('.exr'));
        if (files.length > 0) {
            const totalSize = files.reduce((sum, f) => {
                try { return sum + fs.statSync(path.join(proxyDir, f)).size; } catch { return sum; }
            }, 0);
            return res.json({ hasProxy: true, proxy_path: asset.proxy_path, frameCount: files.length, totalSize });
        }
    }

    // Check if generation is in progress
    const activeJob = [...jobs.values()].find(
        j => j.assetId === assetId && (j.status === 'queued' || j.status === 'running')
    );
    res.json({
        hasProxy: false,
        proxy_path: null,
        generating: !!activeJob,
        jobId: activeJob?.id || null,
        progress: activeJob?.progress || 0,
    });
});

/**
 * DELETE /:id — Delete proxy files and clear the proxy_path column.
 */
router.delete('/:id', (req, res) => {
    const db = getDb();
    const assetId = parseInt(req.params.id);
    const asset = db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const proxyDir = path.join(getProxyRoot(), String(assetId));
    if (fs.existsSync(proxyDir)) {
        fs.rmSync(proxyDir, { recursive: true, force: true });
        console.log(`[Proxy] Deleted proxy directory: ${proxyDir}`);
    }

    db.prepare('UPDATE assets SET proxy_path = NULL WHERE id = ?').run(assetId);
    res.json({ success: true, message: 'Proxy deleted' });
});

/**
 * GET /oiio-status — Check if oiiotool is available for full-res DWAB proxy.
 */
router.get('/oiio-status', (_req, res) => {
    const oiioPath = findOiiotool();
    res.json({ available: !!oiioPath, path: oiioPath || null });
});

/**
 * GET /jobs — List all active/recent proxy jobs.
 */
router.get('/jobs', (_req, res) => {
    const all = [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);
    res.json(all);
});

// ═══════════════════════════════════════════
//  JOB PROCESSOR
// ═══════════════════════════════════════════

async function processNext() {
    if (processing || queue.length === 0) return;
    processing = true;

    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (!job) {
        processing = false;
        processNext();
        return;
    }

    try {
        job.status = 'running';
        job.startedAt = Date.now();
        job.progressText = 'Loading asset info...';

        const db = getDb();
        const asset = db.prepare(
            'SELECT id, file_path, is_sequence, frame_pattern, frame_start, frame_end, frame_count, vault_name FROM assets WHERE id = ?'
        ).get(job.assetId);
        if (!asset) throw new Error('Asset not found');
        if (!asset.is_sequence || !asset.frame_pattern) throw new Error('Asset is not an image sequence');

        // Resolve the source directory (cross-platform path mapping)
        const resolvedPath = resolveFilePath(asset.file_path);
        const srcDir = path.dirname(resolvedPath);
        const inputPattern = path.join(srcDir, asset.frame_pattern);

        // Verify at least the first frame exists
        const padMatch = asset.frame_pattern.match(/%0(\d+)d/);
        const digits = padMatch ? parseInt(padMatch[1], 10) : 4;
        const firstFrameName = asset.frame_pattern.replace(/%0\d+d/, String(asset.frame_start || 1).padStart(digits, '0'));
        const firstFramePath = path.join(srcDir, firstFrameName);
        if (!fs.existsSync(firstFramePath)) {
            throw new Error(`Source frame not found: ${firstFramePath}`);
        }

        // Create proxy output directory
        const proxyDir = path.join(getProxyRoot(), String(asset.id));
        if (!fs.existsSync(proxyDir)) {
            fs.mkdirSync(proxyDir, { recursive: true });
        }

        const outputPattern = path.join(proxyDir, asset.frame_pattern);
        const totalFrames = asset.frame_count || ((asset.frame_end || 0) - (asset.frame_start || 1) + 1);

        if (job.mode === 'fullres') {
            // ═══ FULL-RES DWAB MODE (oiiotool) ═══
            // oiiotool processes one image at a time, so we loop through frames.
            // Command: oiiotool input.exr --compression dwab -o output.exr
            const oiioPath = findOiiotool();
            if (!oiioPath) throw new Error('oiiotool not found — cannot generate full-res DWAB proxy');

            console.log(`[Proxy] Starting job #${jobId}: ${asset.vault_name} FULLRES DWAB (${totalFrames} frames)`);
            console.log(`[Proxy] oiiotool: ${oiioPath}`);
            job.progressText = `Generating full-res DWAB proxy (0 / ${totalFrames})...`;

            const startFrame = asset.frame_start || 1;
            const endFrame = startFrame + totalFrames - 1;

            for (let frame = startFrame; frame <= endFrame; frame++) {
                const frameName = asset.frame_pattern.replace(/%0(\d+)d/, (_, w) => String(frame).padStart(parseInt(w, 10), '0'));
                const inputPath = path.join(srcDir, frameName);
                const outputPath = path.join(proxyDir, frameName);

                if (!fs.existsSync(inputPath)) {
                    console.warn(`[Proxy] Skipping missing frame: ${inputPath}`);
                    continue;
                }

                const oiioArgs = [inputPath, '--compression', 'dwab', '-o:openexr:strict_aces=0', outputPath];
                await runProcess(oiioPath, oiioArgs);

                const done = frame - startFrame + 1;
                job.progress = Math.min(95, Math.round((done / totalFrames) * 100));
                job.progressText = `DWAB proxy: frame ${done} / ${totalFrames}`;
            }

        } else {
            // ═══ HALF-RES ZIP16 MODE (FFmpeg) ═══
            // FFmpeg encodes the whole sequence in one pass.
            const ffmpegPath = findFFmpeg() || 'ffmpeg';

            // Build FFmpeg command:
            //   - Half resolution (scale=iw/2:ih/2 with Lanczos for quality)
            //   - Half-float (16-bit) for HDR/linear fidelity
            //   - ZIP16 compression (best lossless option in FFmpeg's EXR encoder)
            const args = [
                '-y',
                '-start_number', String(asset.frame_start || 1),
                '-i', inputPattern,
                '-vf', 'scale=iw/2:ih/2:flags=lanczos',
                '-c:v', 'exr',
                '-format', 'half',
                '-compression', 'zip16',
                '-start_number', String(asset.frame_start || 1),
                outputPattern,
            ];

            console.log(`[Proxy] Starting job #${jobId}: ${asset.vault_name} HALFRES ZIP16 (${totalFrames} frames)`);
            console.log(`[Proxy] FFmpeg: ${ffmpegPath} ${args.slice(0, 10).join(' ')}...`);
            job.progressText = `Generating half-res proxy (0 / ${totalFrames})...`;

            await runFFmpeg(ffmpegPath, args, job, totalFrames);
        }

        // Update DB with proxy path
        db.prepare('UPDATE assets SET proxy_path = ? WHERE id = ?').run(proxyDir, asset.id);

        // Count output frames and calculate sizes
        const outputFiles = fs.readdirSync(proxyDir).filter(f => f.endsWith('.exr'));
        const totalSize = outputFiles.reduce((sum, f) => {
            try { return sum + fs.statSync(path.join(proxyDir, f)).size; } catch { return sum; }
        }, 0);

        job.status = 'completed';
        job.progress = 100;
        job.progressText = `Proxy ready: ${outputFiles.length} frames (${formatBytes(totalSize)})`;
        console.log(`[Proxy] Job #${jobId} completed: ${outputFiles.length} frames, ${formatBytes(totalSize)}`);

    } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        job.progressText = `Error: ${err.message}`;
        console.error(`[Proxy] Job #${jobId} failed:`, err.message);

        // Clean up partial output on failure
        const proxyDir = path.join(getProxyRoot(), String(job.assetId));
        if (fs.existsSync(proxyDir)) {
            try { fs.rmSync(proxyDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    job.finishedAt = Date.now();
    processing = false;
    processNext();
}

/**
 * Run a generic process (used for oiiotool per-frame calls).
 * Returns a promise that resolves when the process exits successfully.
 */
function runProcess(binPath, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(binPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${path.basename(binPath)} exited with code ${code}: ${stderr.trim().substring(0, 500)}`));
        });
        proc.on('error', (err) => reject(new Error(`Failed to start ${path.basename(binPath)}: ${err.message}`)));
    });
}

/**
 * Run FFmpeg as a child process with progress tracking.
 */
function runFFmpeg(ffmpegPath, args, job, totalFrames) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stderr = '';

        ffmpeg.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;

            // Parse progress from FFmpeg output
            const frameMatch = chunk.match(/frame=\s*(\d+)/);
            if (frameMatch) {
                const frame = parseInt(frameMatch[1]);
                job.progressText = `Proxy: frame ${frame} / ${totalFrames}`;
                if (totalFrames > 0) {
                    job.progress = Math.min(95, Math.round((frame / totalFrames) * 100));
                }
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                const lines = stderr.split('\n').filter(l => l.trim());
                const errMsg = lines.slice(-5).join(' ').substring(0, 500);
                reject(new Error(`FFmpeg exited with code ${code}: ${errMsg}`));
            }
        });

        ffmpeg.on('error', (err) => {
            reject(new Error(`Failed to start FFmpeg: ${err.message}`));
        });
    });
}

/**
 * Format bytes into human-readable string.
 */
function formatBytes(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

module.exports = router;
