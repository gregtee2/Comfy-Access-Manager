/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault — Transcode Service
 * Background FFmpeg job queue for generating derivative formats.
 * Supports: image sequence → video, video → image sequence, sequence → sequence.
 * Uses NVENC GPU acceleration when available with CPU fallback.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDb, getSetting, logActivity } = require('../database');
const MediaInfoService = require('./MediaInfoService');
const ThumbnailService = require('./ThumbnailService');
const { generateVaultName, getVaultDirectory, resolveCollision } = require('../utils/naming');
const { detectMediaType } = require('../utils/mediaTypes');

const resolvedFFmpeg = ThumbnailService.findFFmpeg() || 'ffmpeg';
const IS_MAC = process.platform === 'darwin';

// ═══════════════════════════════════════════
//  DERIVATIVE FORMAT PRESETS
// ═══════════════════════════════════════════

const DERIVATIVE_FORMATS = {
    h264_mov: {
        label: 'H.264 MOV (review/playback)',
        ext: '.mov',
        targetMediaType: 'video',
        outputIsSequence: false,
        buildArgs: (inputInfo) => {
            // Platform-aware GPU encoder: VideoToolbox on Mac, NVENC on Windows/Linux
            if (IS_MAC) {
                return [
                    '-c:v', 'h264_videotoolbox',
                    '-q:v', '65',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                ];
            }
            return [
                '-c:v', 'h264_nvenc',
                '-preset', 'p4',
                '-cq', '18',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
            ];
        },
        buildCpuFallbackArgs: () => [
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
        ],
    },
    png_sequence: {
        label: 'PNG Sequence (lossless)',
        ext: '.png',
        targetMediaType: 'image',
        outputIsSequence: true,
        buildArgs: () => ['-pix_fmt', 'rgba'],
        buildCpuFallbackArgs: () => ['-pix_fmt', 'rgba'],
    },
};


// ═══════════════════════════════════════════
//  JOB QUEUE
// ═══════════════════════════════════════════

const jobs = new Map();
let nextJobId = 1;
let processing = false;
const queue = [];


class TranscodeService {

    /**
     * Get available derivative format presets
     */
    static getFormats() {
        return Object.fromEntries(
            Object.entries(DERIVATIVE_FORMATS).map(([key, v]) => [key, {
                label: v.label,
                ext: v.ext,
                outputIsSequence: v.outputIsSequence,
            }])
        );
    }

    /**
     * Queue a derivative generation job
     * @param {number} sourceAssetId - ID of the source asset
     * @param {string} formatKey - 'h264_mov' or 'png_sequence'
     * @param {object} opts - { fps: 24 }
     * @returns {number} jobId
     */
    static queueDerivative(sourceAssetId, formatKey, opts = {}) {
        const jobId = nextJobId++;
        const job = {
            id: jobId,
            sourceAssetId,
            formatKey,
            status: 'queued',    // queued | running | completed | failed
            progress: 0,         // 0-100
            progressText: '',
            error: null,
            resultAssetId: null,
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            opts,
        };
        jobs.set(jobId, job);
        queue.push(jobId);
        console.log(`[Transcode] Queued job #${jobId}: asset ${sourceAssetId} → ${formatKey}`);

        // Kick off processing
        this._processNext();

        return jobId;
    }

    /**
     * Process the next job in the queue
     */
    static async _processNext() {
        if (processing || queue.length === 0) return;
        processing = true;

        const jobId = queue.shift();
        const job = jobs.get(jobId);
        if (!job) {
            processing = false;
            this._processNext();
            return;
        }

        try {
            job.status = 'running';
            job.startedAt = Date.now();
            job.progressText = 'Loading source asset...';

            const db = getDb();
            const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(job.sourceAssetId);
            if (!asset) throw new Error('Source asset not found');

            const format = DERIVATIVE_FORMATS[job.formatKey];
            if (!format) throw new Error(`Unknown format: ${job.formatKey}`);

            console.log(`[Transcode] Starting job #${jobId}: ${asset.vault_name} → ${job.formatKey}`);

            const result = await this._transcode(asset, format, job);

            job.resultAssetId = result.assetId;
            job.status = 'completed';
            job.progress = 100;
            job.progressText = 'Done';

            console.log(`[Transcode] ✅ Job #${jobId} completed → asset ${result.assetId}`);

        } catch (err) {
            job.status = 'failed';
            job.error = err.message;
            job.progressText = `Error: ${err.message}`;
            console.error(`[Transcode] ❌ Job #${jobId} failed:`, err.message);
        }

        job.finishedAt = Date.now();
        processing = false;
        this._processNext();
    }

    /**
     * Execute a single transcode job
     * @param {object} sourceAsset - Full asset row from DB
     * @param {object} format - Format preset from DERIVATIVE_FORMATS
     * @param {object} job - Job object (for progress updates)
     * @returns {{ assetId: number, outputPath: string }}
     */
    static async _transcode(sourceAsset, format, job) {
        const db = getDb();
        const fps = job.opts.fps || 24;

        // Determine source type
        const isSourceSequence = !!sourceAsset.is_sequence;

        // Get source hierarchy for output folder
        const hierarchy = this._getHierarchy(db, sourceAsset.id);

        // Build output vault directory
        const vaultRoot = getSetting('vault_root');
        if (!vaultRoot) throw new Error('Vault root not configured');

        const outputDir = getVaultDirectory(
            vaultRoot,
            hierarchy.project_code || 'UNSET',
            format.targetMediaType,
            hierarchy.sequence_code || undefined,
            hierarchy.shot_code || undefined,
        );

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Build output name: same base name as source, different extension
        const sourceBase = path.basename(sourceAsset.vault_name, path.extname(sourceAsset.vault_name));
        const outputExt = format.ext;

        let outputPath, outputVaultName, outputFramePattern;
        let outputIsSequence = format.outputIsSequence;
        let outputFrameStart, outputFrameEnd, outputFrameCount;

        if (outputIsSequence) {
            // Output is a frame sequence
            const digits = isSourceSequence ? (sourceAsset.frame_pattern?.match(/%0(\d+)d/)?.[1] || '4') : '4';
            outputFramePattern = `${sourceBase}.%0${digits}d${outputExt}`;
            outputPath = path.join(outputDir, outputFramePattern); // used for FFmpeg output
            outputVaultName = `${sourceBase}${outputExt}`;          // representative name
            outputFrameStart = isSourceSequence ? sourceAsset.frame_start : 1;
            // frameEnd/Count set after transcode completes
        } else {
            // Output is a single file (MOV, MP4)
            outputVaultName = `${sourceBase}${outputExt}`;
            outputPath = path.join(outputDir, outputVaultName);

            // Handle collision — version-aware (v002→v003) or suffix fallback (_02, _03)
            if (fs.existsSync(outputPath)) {
                const resolved = resolveCollision(outputDir, outputVaultName);
                outputPath = path.join(outputDir, resolved);
                outputVaultName = resolved;
            }
        }

        // Build FFmpeg command
        const args = ['-y'];

        // INPUT
        if (isSourceSequence && sourceAsset.frame_pattern) {
            // Image sequence input
            args.push('-framerate', String(fps));
            args.push('-start_number', String(sourceAsset.frame_start || 1));
            // Build full input pattern path
            const patternDir = path.dirname(sourceAsset.file_path);
            const inputPattern = path.join(patternDir, sourceAsset.frame_pattern);
            args.push('-i', inputPattern);
        } else {
            // Single file input (video or single image)
            args.push('-i', sourceAsset.file_path);
        }

        // OUTPUT CODEC ARGS
        const codecArgs = format.buildArgs({ fps });
        args.push(...codecArgs);

        // OUTPUT PATH
        if (outputIsSequence) {
            // Sequence output: use the printf pattern
            const seqOutputPath = path.join(outputDir, outputFramePattern);
            args.push(seqOutputPath);
        } else {
            args.push(outputPath);
        }

        job.progressText = `Transcoding → ${job.formatKey}...`;

        // Run FFmpeg
        try {
            await this._runFFmpeg(args, job);
        } catch (err) {
            // If GPU encoder failed (NVENC or VideoToolbox), try CPU fallback
            if (err.message.includes('nvenc') || err.message.includes('No NVENC') ||
                err.message.includes('videotoolbox') || err.message.includes('VideoToolbox') ||
                err.message.includes('not found') || err.message.includes('Unknown encoder')) {
                console.log(`[Transcode] GPU encoder failed, falling back to CPU encoder...`);
                job.progressText = 'NVENC unavailable, using CPU encoder...';

                // Rebuild with CPU fallback args
                const fallbackArgs = ['-y'];
                if (isSourceSequence && sourceAsset.frame_pattern) {
                    fallbackArgs.push('-framerate', String(fps), '-start_number', String(sourceAsset.frame_start || 1));
                    const patternDir = path.dirname(sourceAsset.file_path);
                    fallbackArgs.push('-i', path.join(patternDir, sourceAsset.frame_pattern));
                } else {
                    fallbackArgs.push('-i', sourceAsset.file_path);
                }
                fallbackArgs.push(...format.buildCpuFallbackArgs());
                if (outputIsSequence) {
                    fallbackArgs.push(path.join(outputDir, outputFramePattern));
                } else {
                    fallbackArgs.push(outputPath);
                }
                await this._runFFmpeg(fallbackArgs, job);
            } else {
                throw err;
            }
        }

        // Post-transcode: gather metadata
        job.progressText = 'Registering derivative asset...';

        let fileSize = 0;
        let width, height, duration, fpsOut, codec;

        if (outputIsSequence) {
            // Count output frames and total size
            const files = fs.readdirSync(outputDir)
                .filter(f => f.startsWith(sourceBase + '.') && f.endsWith(outputExt))
                .sort();

            outputFrameCount = files.length;
            outputFrameEnd = (outputFrameStart || 1) + outputFrameCount - 1;
            fileSize = files.reduce((sum, f) => sum + fs.statSync(path.join(outputDir, f)).size, 0);

            // Probe first frame for dimensions
            if (files.length > 0) {
                const firstFrame = path.join(outputDir, files[0]);
                const info = await MediaInfoService.probe(firstFrame);
                width = info.width;
                height = info.height;
                codec = info.codec;
            }

            // file_path points to first frame for thumbnail/probe
            if (files.length > 0) {
                outputPath = path.join(outputDir, files[0]);
            }
        } else {
            // Single file: probe it
            const info = await MediaInfoService.probe(outputPath);
            fileSize = info.fileSize || fs.statSync(outputPath).size;
            width = info.width;
            height = info.height;
            duration = info.duration;
            fpsOut = info.fps;
            codec = info.codec;
        }

        // Register as new asset
        const relativePath = vaultRoot ? path.relative(vaultRoot, outputPath) : path.basename(outputPath);

        const result = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size,
                width, height, duration, fps, codec,
                version, parent_asset_id, is_derivative,
                is_sequence, frame_start, frame_end, frame_count, frame_pattern,
                notes, metadata, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
            sourceAsset.project_id,
            sourceAsset.sequence_id || null,
            sourceAsset.shot_id || null,
            sourceAsset.role_id || null,
            outputVaultName,
            outputVaultName,
            outputPath,
            relativePath,
            format.targetMediaType,
            outputExt,
            fileSize,
            width || null, height || null, duration || null, fpsOut || null, codec || null,
            sourceAsset.version || 1,
            sourceAsset.id,   // parent_asset_id
            1,                // is_derivative
            outputIsSequence ? 1 : 0,
            outputIsSequence ? (outputFrameStart || null) : null,
            outputIsSequence ? (outputFrameEnd || null) : null,
            outputIsSequence ? (outputFrameCount || null) : null,
            outputIsSequence ? outputFramePattern : null,
            `Derivative of ${sourceAsset.vault_name} (${job.formatKey})`,
            JSON.stringify({ source_asset_id: sourceAsset.id, format: job.formatKey, fps })
        );

        const newAssetId = result.lastInsertRowid;

        // Generate thumbnail
        try {
            const thumbPath = await ThumbnailService.generate(outputPath, newAssetId);
            if (thumbPath) {
                db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, newAssetId);
            }
        } catch (thumbErr) {
            console.error(`[Transcode] Thumbnail failed for derivative ${newAssetId}:`, thumbErr.message);
        }

        logActivity('derivative_created', 'asset', newAssetId, {
            source_asset_id: sourceAsset.id,
            format: job.formatKey,
            source_name: sourceAsset.vault_name,
        });

        return { assetId: newAssetId, outputPath };
    }

    /**
     * Run FFmpeg as a child process with progress tracking
     */
    static _runFFmpeg(args, job) {
        return new Promise((resolve, reject) => {
            console.log(`[Transcode] FFmpeg: ${resolvedFFmpeg} ${args.join(' ').substring(0, 200)}...`);

            const ffmpeg = spawn(resolvedFFmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderr += chunk;

                // Parse progress from FFmpeg output (frame= or time=)
                const frameMatch = chunk.match(/frame=\s*(\d+)/);
                const timeMatch = chunk.match(/time=(\d+):(\d+):(\d+)/);

                if (frameMatch) {
                    const frame = parseInt(frameMatch[1]);
                    job.progressText = `Encoding frame ${frame}...`;
                    // Estimate progress if we know total frames
                    if (job.opts._totalFrames) {
                        job.progress = Math.min(95, Math.round((frame / job.opts._totalFrames) * 100));
                    }
                } else if (timeMatch) {
                    const secs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
                    job.progressText = `Encoding... ${timeMatch[0]}`;
                    if (job.opts._totalDuration) {
                        job.progress = Math.min(95, Math.round((secs / job.opts._totalDuration) * 100));
                    }
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    const lines = stderr.split('\n').filter(l => l.trim());
                    const errMsg = lines.slice(-3).join(' ').substring(0, 300);
                    reject(new Error(`FFmpeg exited with code ${code}: ${errMsg}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`Failed to start FFmpeg: ${err.message}`));
            });
        });
    }

    /**
     * Get asset hierarchy for folder structure
     */
    static _getHierarchy(db, assetId) {
        return db.prepare(`
            SELECT
                a.project_id, a.sequence_id, a.shot_id, a.role_id,
                p.code AS project_code, sq.code AS sequence_code,
                sh.code AS shot_code, r.code AS role_code
            FROM assets a
            LEFT JOIN projects p ON a.project_id = p.id
            LEFT JOIN sequences sq ON a.sequence_id = sq.id
            LEFT JOIN shots sh ON a.shot_id = sh.id
            LEFT JOIN roles r ON a.role_id = r.id
            WHERE a.id = ?
        `).get(assetId) || {};
    }


    // ═══════════════════════════════════════════
    //  PUBLIC JOB QUERY API
    // ═══════════════════════════════════════════

    static getJob(jobId) {
        return jobs.get(jobId) || null;
    }

    static getAllJobs() {
        return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    static getActiveJobs() {
        return [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running');
    }

    static getJobsForAsset(assetId) {
        return [...jobs.values()].filter(j => j.sourceAssetId === assetId);
    }

    static clearCompletedJobs() {
        for (const [id, job] of jobs) {
            if (job.status === 'completed' || job.status === 'failed') {
                jobs.delete(id);
            }
        }
    }
}

module.exports = TranscodeService;
