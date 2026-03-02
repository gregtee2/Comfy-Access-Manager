/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault — Export Routes
 * Transcode/export assets to different resolutions and codecs via FFmpeg + NVENC.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { getDb, getSetting, logActivity } = require('../database');
const MediaInfoService = require('../services/MediaInfoService');
const ThumbnailService = require('../services/ThumbnailService');
const { resolveFilePath } = require('../utils/pathResolver');

// Resolve FFmpeg/FFprobe paths once at startup (use discovery, not bare commands)
const resolvedFFprobe = MediaInfoService.findFFprobe() || 'ffprobe';
const resolvedFFmpeg = ThumbnailService.findFFmpeg() || 'ffmpeg';

// ─── In-flight export jobs (id → job info) ───
const jobs = new Map();
let nextJobId = 1;

// ─── Resolution presets ───
const RESOLUTION_PRESETS = {
    original:  { label: 'Original', scale: null },
    '4k':      { label: '4K (3840×2160)',   scale: '3840:-2' },
    '1440p':   { label: '1440p (2560×1440)', scale: '2560:-2' },
    '1080p':   { label: '1080p (1920×1080)', scale: '1920:-2' },
    '720p':    { label: '720p (1280×720)',   scale: '1280:-2' },
    '540p':    { label: '540p (960×540)',    scale: '960:-2' },
    '480p':    { label: '480p (854×480)',    scale: '854:-2' },
};

// ─── Platform-aware GPU encoder selection ───
const IS_MAC = process.platform === 'darwin';
const GPU_H264  = IS_MAC ? 'h264_videotoolbox'  : 'h264_nvenc';
const GPU_H265  = IS_MAC ? 'hevc_videotoolbox'  : 'hevc_nvenc';
const GPU_LABEL = IS_MAC ? 'VideoToolbox GPU'   : 'NVENC GPU';

// ─── Codec presets ───
const CODEC_PRESETS = {
    [GPU_H264]:   { label: `H.264 (${GPU_LABEL})`,       ext: '.mp4',  args: IS_MAC
        ? ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-c:a', 'aac', '-b:a', '192k']
        : ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', '-c:a', 'aac', '-b:a', '192k'] },
    [GPU_H265]:   { label: `H.265/HEVC (${GPU_LABEL})`,   ext: '.mp4',  args: IS_MAC
        ? ['-c:v', 'hevc_videotoolbox', '-q:v', '65', '-c:a', 'aac', '-b:a', '192k']
        : ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-cq', '22', '-c:a', 'aac', '-b:a', '192k'] },
    libx264:      { label: 'H.264 (CPU)',              ext: '.mp4',  args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k'] },
    libx265:      { label: 'H.265/HEVC (CPU)',         ext: '.mp4',  args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '22', '-c:a', 'aac', '-b:a', '192k'] },
    prores_ks:    { label: 'ProRes 422 HQ',            ext: '.mov',  args: ['-c:v', 'prores_ks', '-profile:v', '3', '-c:a', 'pcm_s16le'] },
    prores_lt:    { label: 'ProRes 422 LT',            ext: '.mov',  args: ['-c:v', 'prores_ks', '-profile:v', '1', '-c:a', 'pcm_s16le'] },
    prores_proxy: { label: 'ProRes 422 Proxy',         ext: '.mov',  args: ['-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le'] },
    copy:         { label: 'Copy (no re-encode)',      ext: null,    args: ['-c', 'copy'] },

    // ─── Image Sequence presets ───
    seq_exr:      { label: 'EXR Sequence',             ext: '.exr',  args: ['-compression', 'zip1'], isSequence: true },
    seq_png:      { label: 'PNG Sequence (lossless)',   ext: '.png',  args: [],                       isSequence: true },
    seq_tiff:     { label: 'TIFF Sequence (16-bit)',    ext: '.tiff', args: ['-pix_fmt', 'rgb48le'],  isSequence: true },
    seq_dpx:      { label: 'DPX Sequence (10-bit)',     ext: '.dpx',  args: ['-pix_fmt', 'gbrp10le'], isSequence: true },
    seq_jpg:      { label: 'JPEG Sequence',             ext: '.jpg',  args: ['-q:v', '2'],            isSequence: true },
};

// Map common FFmpeg codec names → our preset keys for "match source" detection
const CODEC_NAME_MAP = {
    h264: GPU_H264,
    hevc: GPU_H265,
    h265: GPU_H265,
    prores: 'prores_ks',
    vp9: 'libx264',    // Fallback — no GPU VP9 encoder
    av1: 'libx264',    // Fallback
    mpeg4: GPU_H264,
};

// ═══════════════════════════════════════════
//  GET /api/export/presets — List available resolutions & codecs
// ═══════════════════════════════════════════

router.get('/presets', (req, res) => {
    res.json({
        resolutions: RESOLUTION_PRESETS,
        codecs: Object.fromEntries(
            Object.entries(CODEC_PRESETS).map(([k, v]) => [k, { label: v.label, ext: v.ext, isSequence: !!v.isSequence }])
        ),
    });
});

// ═══════════════════════════════════════════
//  GET /api/export/probe/:id — Get source media info via ffprobe
// ═══════════════════════════════════════════

router.get('/probe/:id', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT file_path, vault_name, media_type FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.media_type !== 'video') return res.status(400).json({ error: 'Only video assets can be exported' });
    asset.file_path = resolveFilePath(asset.file_path);
    if (!fs.existsSync(asset.file_path)) return res.status(404).json({ error: 'Source file not found on disk' });

    // Look up the asset's hierarchy (project/sequence/shot/role)
    const hierarchy = getAssetHierarchy(db, req.params.id);

    const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        asset.file_path,
    ];

    execFile(resolvedFFprobe, args, { maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return res.status(500).json({ error: 'ffprobe failed: ' + err.message });

        try {
            const info = JSON.parse(stdout);
            const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
            const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');

            if (!videoStream) return res.status(400).json({ error: 'No video stream found' });

            // Suggest a matching codec preset
            const sourceCodec = (videoStream.codec_name || '').toLowerCase();
            const suggestedCodec = CODEC_NAME_MAP[sourceCodec] || GPU_H264;

            res.json({
                width: videoStream.width,
                height: videoStream.height,
                codec: videoStream.codec_name,
                codec_long: videoStream.codec_long_name,
                fps: eval(videoStream.r_frame_rate) || null,  // e.g. "24000/1001"
                duration: parseFloat(info.format?.duration) || null,
                bitrate: parseInt(info.format?.bit_rate) || null,
                pixel_format: videoStream.pix_fmt,
                audio_codec: audioStream?.codec_name || null,
                audio_channels: audioStream?.channels || 0,
                file_size: parseInt(info.format?.size) || 0,
                vault_name: asset.vault_name,
                suggestedCodec,
                hierarchy,
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse ffprobe output' });
        }
    });
});

// ═══════════════════════════════════════════
//  POST /api/export/start — Start an export job
// ═══════════════════════════════════════════

router.post('/start', (req, res) => {
    const db = getDb();
    const { assetIds, resolution, codec, outputName, destination, overlayPresetId } = req.body;

    if (!Array.isArray(assetIds) || assetIds.length === 0) {
        return res.status(400).json({ error: 'assetIds array required' });
    }

    const codecPreset = CODEC_PRESETS[codec];
    if (!codecPreset && codec !== 'match_source') {
        return res.status(400).json({ error: `Unknown codec: ${codec}` });
    }

    const resPreset = RESOLUTION_PRESETS[resolution];
    if (!resPreset && resolution !== 'custom') {
        return res.status(400).json({ error: `Unknown resolution: ${resolution}` });
    }

    // Determine destination folder
    let destDir = destination;
    if (!destDir) {
        const vaultRoot = getSetting('vault_root');
        destDir = vaultRoot ? path.join(vaultRoot, 'exports') : path.join(__dirname, '..', '..', 'exports');
    }
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    // Build queue of exports (with hierarchy info for folder structure)
    const assets = [];
    for (const id of assetIds) {
        const asset = db.prepare('SELECT id, file_path, vault_name, media_type, width, height FROM assets WHERE id = ?').get(id);
        if (!asset) continue;
        if (asset.media_type !== 'video') continue;
        asset.file_path = resolveFilePath(asset.file_path);
        if (!fs.existsSync(asset.file_path)) continue;
        asset.hierarchy = getAssetHierarchy(db, id);
        assets.push(asset);
    }

    if (assets.length === 0) {
        return res.status(400).json({ error: 'No valid video assets found' });
    }

    const jobId = nextJobId++;
    const job = {
        id: jobId,
        status: 'running',
        total: assets.length,
        completed: 0,
        failed: 0,
        current: null,
        results: [],
        startedAt: Date.now(),
        codec,
        resolution,
    };
    jobs.set(jobId, job);

    // Process sequentially in background
    (async () => {
        for (const asset of assets) {
            try {
                job.current = asset.vault_name;
                const result = await exportSingleAsset(asset, { resolution, codec, outputName, destDir, overlayPresetId });
                job.results.push({ id: asset.id, name: asset.vault_name, success: true, outputPath: result.outputPath, outputName: result.outputName, newAssetId: result.newAssetId || null });
                job.completed++;
            } catch (err) {
                job.results.push({ id: asset.id, name: asset.vault_name, success: false, error: err.message });
                job.failed++;
                job.completed++;
            }
        }
        job.status = job.failed > 0 ? 'completed_with_errors' : 'completed';
        job.current = null;
        job.finishedAt = Date.now();
    })();

    res.json({ jobId, total: assets.length, message: `Export started for ${assets.length} asset(s)` });
});

// ═══════════════════════════════════════════
//  GET /api/export/status/:jobId — Check export progress
// ═══════════════════════════════════════════

router.get('/status/:jobId', (req, res) => {
    const job = jobs.get(parseInt(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// ═══════════════════════════════════════════
//  GET /api/export/jobs — List all recent jobs
// ═══════════════════════════════════════════

router.get('/jobs', (req, res) => {
    const all = [];
    for (const [id, job] of jobs) {
        all.push({ id, status: job.status, total: job.total, completed: job.completed, failed: job.failed, startedAt: job.startedAt, finishedAt: job.finishedAt });
    }
    res.json(all);
});

// ═══════════════════════════════════════════
//  INTERNAL: Export a single asset
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
//  INTERNAL: Get an asset's full hierarchy (project/sequence/shot/role codes)
// ═══════════════════════════════════════════

function getAssetHierarchy(db, assetId) {
    const row = db.prepare(`
        SELECT
            a.project_id,
            a.sequence_id,
            a.shot_id,
            a.role_id,
            p.code   AS project_code,
            p.name   AS project_name,
            sq.code  AS sequence_code,
            sq.name  AS sequence_name,
            sh.code  AS shot_code,
            sh.name  AS shot_name,
            r.code   AS role_code,
            r.name   AS role_name
        FROM assets a
        LEFT JOIN projects  p  ON a.project_id  = p.id
        LEFT JOIN sequences sq ON a.sequence_id = sq.id
        LEFT JOIN shots     sh ON a.shot_id     = sh.id
        LEFT JOIN roles     r  ON a.role_id     = r.id
        WHERE a.id = ?
    `).get(assetId);
    return row || {};
}

// ═══════════════════════════════════════════
//  INTERNAL: Build subdirectory path from hierarchy
//  e.g. "DD/AP1/eda1500/COMP"
// ═══════════════════════════════════════════

function buildHierarchyPath(hierarchy) {
    const parts = [];
    // Use names for project/sequence/shot (matches what user sees in the UI)
    // Use code for role (short, filesystem-friendly: COMP, ANIM, FX, etc.)
    if (hierarchy.project_code)   parts.push(hierarchy.project_code);
    if (hierarchy.sequence_name)  parts.push(hierarchy.sequence_name);
    if (hierarchy.shot_name)      parts.push(hierarchy.shot_name);
    if (hierarchy.role_code)      parts.push(hierarchy.role_code);
    return parts.length > 0 ? path.join(...parts) : '';
}

// ═══════════════════════════════════════════
//  INTERNAL: Export a single asset
// ═══════════════════════════════════════════

function exportSingleAsset(asset, opts) {
    return new Promise((resolve, reject) => {
        const { resolution, codec, outputName, destDir, overlayPresetId } = opts;

        // Load overlay preset if requested
        let overlayFilters = '';
        if (overlayPresetId) {
            try {
                const presetRow = getDb().prepare('SELECT config FROM overlay_presets WHERE id = ?').get(overlayPresetId);
                if (presetRow) {
                    const { buildDrawtextFilters } = require('./overlayRoutes');
                    const config = JSON.parse(presetRow.config || '{}');
                    overlayFilters = buildDrawtextFilters(config, asset.hierarchy || {}, asset.vault_name);
                }
            } catch (err) {
                console.error('[Export] Failed to load overlay preset:', err.message);
            }
        }

        // Resolve codec args — if "match_source", probe first then pick
        let codecKey = codec;
        if (codec === 'match_source') {
            // Sync probe to determine source codec
            const { execFileSync } = require('child_process');
            try {
                const probeOut = execFileSync(resolvedFFprobe, [
                    '-v', 'quiet', '-print_format', 'json', '-show_streams', asset.file_path
                ], { maxBuffer: 1024 * 1024 }).toString();
                const probeInfo = JSON.parse(probeOut);
                const vs = (probeInfo.streams || []).find(s => s.codec_type === 'video');
                const srcCodec = (vs?.codec_name || '').toLowerCase();
                codecKey = CODEC_NAME_MAP[srcCodec] || GPU_H264;
            } catch {
                codecKey = GPU_H264; // Safe fallback
            }
        }

        const preset = CODEC_PRESETS[codecKey];
        if (!preset) return reject(new Error(`No codec preset for: ${codecKey}`));

        const resPreset = RESOLUTION_PRESETS[resolution] || RESOLUTION_PRESETS.original;

        // Build hierarchy subdirectory (Project/Sequence/Shot/Role)
        const hierarchy = asset.hierarchy || {};
        const subDir = buildHierarchyPath(hierarchy);
        const finalDestDir = subDir ? path.join(destDir, subDir) : destDir;

        // Ensure the hierarchy folder exists
        if (!fs.existsSync(finalDestDir)) {
            fs.mkdirSync(finalDestDir, { recursive: true });
        }

        // Build output filename
        const baseName = path.basename(asset.vault_name, path.extname(asset.vault_name));
        const ext = preset.ext || path.extname(asset.vault_name);
        let finalName;

        if (outputName) {
            // Apply template tokens
            finalName = outputName
                .replace(/{original}/g, baseName)
                .replace(/{resolution}/g, resolution || 'original')
                .replace(/{codec}/g, codecKey)
                .replace(/{role}/g, hierarchy.role_code || '')
                .replace(/{date}/g, new Date().toISOString().slice(0, 10));
            // Ensure extension
            if (!path.extname(finalName)) finalName += ext;
        } else {
            finalName = `${baseName}_${resolution || 'original'}${ext}`;
        }

        const outputPath = path.join(finalDestDir, finalName);

        // Don't overwrite existing files — add suffix
        let safePath = outputPath;
        let counter = 1;
        while (fs.existsSync(safePath)) {
            const dir = path.dirname(outputPath);
            const name = path.basename(outputPath, path.extname(outputPath));
            safePath = path.join(dir, `${name}_${counter}${path.extname(outputPath)}`);
            counter++;
        }

        // Build FFmpeg args
        const isSeq = preset.isSequence === true;

        if (isSeq) {
            // image sequence: create subfolder, output as frame pattern
            const seqDir = path.join(path.dirname(safePath), path.basename(safePath, path.extname(safePath)));
            if (!fs.existsSync(seqDir)) fs.mkdirSync(seqDir, { recursive: true });
            const framePattern = path.join(seqDir, `${path.basename(safePath, path.extname(safePath))}.%04d${ext}`);

            const args = ['-y', '-i', asset.file_path];
            // Combine scale + overlay filters
            const vfParts = [];
            if (resPreset.scale) vfParts.push(`scale=${resPreset.scale}`);
            if (overlayFilters) vfParts.push(overlayFilters);
            if (vfParts.length > 0) args.push('-vf', vfParts.join(','));
            args.push(...preset.args);
            args.push(framePattern);

            // Override safePath so downstream registration points at the folder
            safePath = seqDir;

            const ffmpeg = spawn(resolvedFFmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            let stderr = '';
            ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
            ffmpeg.on('close', async (code) => {
                if (code === 0) {
                    logActivity('export', 'asset', asset.id, {
                        outputPath: seqDir, resolution, codec: codecKey,
                        hierarchy: asset.hierarchy || {}, type: 'image_sequence',
                    });
                    // Count exported frames
                    const frames = fs.readdirSync(seqDir).filter(f => f.endsWith(ext));
                    resolve({ outputPath: seqDir, outputName: path.basename(seqDir), frameCount: frames.length });
                } else {
                    const lines = stderr.split('\n').filter(l => l.trim());
                    reject(new Error(`FFmpeg exited with code ${code}: ${lines.slice(-3).join(' ').substring(0, 200)}`));
                }
            });
            ffmpeg.on('error', (err) => reject(new Error(`Failed to start FFmpeg: ${err.message}`)));
            return; // Exit early — skip the normal video export path below
        }

        const args = [
            '-y',
            '-i', asset.file_path,
        ];

        // Scale + overlay filters
        const vfParts = [];
        if (resPreset.scale) vfParts.push(`scale=${resPreset.scale}`);
        if (overlayFilters) vfParts.push(overlayFilters);
        if (vfParts.length > 0) {
            args.push('-vf', vfParts.join(','));
        }

        // Codec args
        args.push(...preset.args);

        // Faststart for MP4
        if (ext === '.mp4') {
            args.push('-movflags', '+faststart');
        }

        args.push(safePath);

        // Run FFmpeg
        const ffmpeg = spawn(resolvedFFmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

        let stderr = '';
        ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });

        ffmpeg.on('close', async (code) => {
            if (code === 0) {
                logActivity('export', 'asset', asset.id, {
                    outputPath: safePath,
                    resolution,
                    codec: codecKey,
                    hierarchy: asset.hierarchy || {},
                });

                // Register the exported file as a new asset in the database
                let newAssetId = null;
                try {
                    newAssetId = await registerExportedAsset(asset, safePath, codecKey, resolution);
                } catch (regErr) {
                    console.error(`[Export] Failed to register exported asset:`, regErr.message);
                }

                resolve({ outputPath: safePath, outputName: path.basename(safePath), newAssetId });
            } else {
                // GPU encoder failed — retry with CPU fallback if applicable
                const isGpuCodec = [GPU_H264, GPU_H265].includes(codecKey);
                if (isGpuCodec) {
                    const cpuCodec = codecKey.includes('hevc') || codecKey.includes('h265') ? 'libx265' : 'libx264';
                    const cpuPreset = CODEC_PRESETS[cpuCodec];
                    console.log(`[Export] GPU encoder (${codecKey}) failed, retrying with CPU (${cpuCodec})...`);

                    const cpuArgs = ['-y', '-i', asset.file_path];
                    const cpuVfParts = [];
                    if (resPreset.scale) cpuVfParts.push(`scale=${resPreset.scale}`);
                    if (overlayFilters) cpuVfParts.push(overlayFilters);
                    if (cpuVfParts.length > 0) cpuArgs.push('-vf', cpuVfParts.join(','));
                    cpuArgs.push(...cpuPreset.args);
                    if (ext === '.mp4') cpuArgs.push('-movflags', '+faststart');
                    cpuArgs.push(safePath);

                    const cpuFfmpeg = spawn(resolvedFFmpeg, cpuArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
                    let cpuStderr = '';
                    cpuFfmpeg.stderr.on('data', (d) => { cpuStderr += d.toString(); });
                    cpuFfmpeg.on('close', async (cpuCode) => {
                        if (cpuCode === 0) {
                            logActivity('export', 'asset', asset.id, { outputPath: safePath, resolution, codec: cpuCodec, hierarchy: asset.hierarchy || {} });
                            let newAssetId = null;
                            try { newAssetId = await registerExportedAsset(asset, safePath, cpuCodec, resolution); }
                            catch (regErr) { console.error(`[Export] Failed to register exported asset:`, regErr.message); }
                            resolve({ outputPath: safePath, outputName: path.basename(safePath), newAssetId });
                        } else {
                            const lines = cpuStderr.split('\n').filter(l => l.trim());
                            reject(new Error(`FFmpeg CPU fallback exited with code ${cpuCode}: ${lines.slice(-3).join(' ').substring(0, 200)}`));
                        }
                    });
                    cpuFfmpeg.on('error', (err) => reject(new Error(`Failed to start FFmpeg (CPU fallback): ${err.message}`)));
                } else {
                    const lines = stderr.split('\n').filter(l => l.trim());
                    const errMsg = lines.slice(-3).join(' ').substring(0, 200);
                    reject(new Error(`FFmpeg exited with code ${code}: ${errMsg}`));
                }
            }
        });

        ffmpeg.on('error', (err) => {
            reject(new Error(`Failed to start FFmpeg: ${err.message}`));
        });
    });
}

// ═══════════════════════════════════════════
//  INTERNAL: Register an exported file as a new asset in the DB
// ═══════════════════════════════════════════

async function registerExportedAsset(sourceAsset, exportedFilePath, codecKey, resolution) {
    const db = getDb();
    const hierarchy = sourceAsset.hierarchy || {};

    // Probe the exported file for accurate metadata
    const info = await MediaInfoService.probe(exportedFilePath);

    // Compute relative path from vault root
    const vaultRoot = getSetting('vault_root') || '';
    const relativePath = vaultRoot ? path.relative(vaultRoot, exportedFilePath) : path.basename(exportedFilePath);
    const vaultName = path.basename(exportedFilePath);
    const fileExt = path.extname(exportedFilePath).toLowerCase();

    // Insert new asset with same hierarchy as source
    const result = db.prepare(`
        INSERT INTO assets (
            project_id, sequence_id, shot_id, role_id,
            original_name, vault_name, file_path, relative_path,
            media_type, file_ext, file_size,
            width, height, duration, fps, codec,
            take_number, version,
            notes, metadata, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
        hierarchy.project_id  ?? sourceAsset.project_id  ?? null,
        hierarchy.sequence_id ?? sourceAsset.sequence_id ?? null,
        hierarchy.shot_id     ?? sourceAsset.shot_id     ?? null,
        hierarchy.role_id     ?? sourceAsset.role_id     ?? null,
        vaultName,
        vaultName,
        exportedFilePath,
        relativePath,
        'video',
        fileExt,
        info.fileSize || 0,
        info.width, info.height, info.duration, info.fps, info.codec,
        null,  // take_number
        1,     // version
        `Exported from ${sourceAsset.vault_name} (${resolution}, ${codecKey})`,
        JSON.stringify({ source_asset_id: sourceAsset.id, export_resolution: resolution, export_codec: codecKey })
    );

    const newAssetId = result.lastInsertRowid;

    // Generate thumbnail for the new asset
    try {
        const thumbPath = await ThumbnailService.generate(exportedFilePath, newAssetId);
        if (thumbPath) {
            db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, newAssetId);
        }
    } catch (thumbErr) {
        console.error(`[Export] Thumbnail failed for exported asset ${newAssetId}:`, thumbErr.message);
    }

    logActivity('asset_created', 'asset', newAssetId, {
        source: 'export',
        source_asset_id: sourceAsset.id,
        resolution,
        codec: codecKey,
    });

    return newAssetId;
}

module.exports = router;
