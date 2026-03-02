/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM -- Overlay Preset Routes
 * CRUD for burn-in overlay presets and sample-frame extraction for the visual editor.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { getDb, logActivity } = require('../database');
const ThumbnailService = require('../services/ThumbnailService');
const MediaInfoService = require('../services/MediaInfoService');
const { resolveFilePath, getAllPathVariants } = require('../utils/pathResolver');

const resolvedFFmpeg = ThumbnailService.findFFmpeg() || 'ffmpeg';
const resolvedFFprobe = MediaInfoService.findFFprobe() || 'ffprobe';

// ═══════════════════════════════════════════
//  GET /api/overlay/presets -- List all overlay presets
// ═══════════════════════════════════════════

router.get('/presets', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM overlay_presets ORDER BY name ASC').all();
    res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })));
});

// ═══════════════════════════════════════════
//  GET /api/overlay/presets/:id -- Get single preset
// ═══════════════════════════════════════════

router.get('/presets/:id', (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM overlay_presets WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Preset not found' });
    res.json({ ...row, config: JSON.parse(row.config || '{}') });
});

// ═══════════════════════════════════════════
//  POST /api/overlay/presets -- Create new preset
// ═══════════════════════════════════════════

router.post('/presets', (req, res) => {
    const db = getDb();
    const { name, config } = req.body;
    if (!name || !config) return res.status(400).json({ error: 'name and config required' });

    const result = db.prepare(
        'INSERT INTO overlay_presets (name, config) VALUES (?, ?)'
    ).run(name, JSON.stringify(config));

    logActivity('overlay_preset_created', 'overlay_preset', result.lastInsertRowid, { name });
    res.json({ id: result.lastInsertRowid, name, config });
});

// ═══════════════════════════════════════════
//  PUT /api/overlay/presets/:id -- Update preset
// ═══════════════════════════════════════════

router.put('/presets/:id', (req, res) => {
    const db = getDb();
    const { name, config } = req.body;
    const existing = db.prepare('SELECT id FROM overlay_presets WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Preset not found' });

    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (config !== undefined) { updates.push('config = ?'); params.push(JSON.stringify(config)); }
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    db.prepare(`UPDATE overlay_presets SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
});

// ═══════════════════════════════════════════
//  DELETE /api/overlay/presets/:id -- Delete preset
// ═══════════════════════════════════════════

router.delete('/presets/:id', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM overlay_presets WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Preset not found' });

    db.prepare('DELETE FROM overlay_presets WHERE id = ?').run(req.params.id);
    logActivity('overlay_preset_deleted', 'overlay_preset', req.params.id, {});
    res.json({ success: true });
});

// ═══════════════════════════════════════════
//  GET /api/overlay/sample-frame/:assetId -- Extract a sample frame for preview
//  Returns a JPEG image, scaled to maxWidth (default 960px)
// ═══════════════════════════════════════════

router.get('/sample-frame/:assetId', (req, res) => {
    const db = getDb();
    const asset = db.prepare(
        'SELECT file_path, vault_name, media_type, width, height, is_sequence, frame_start, frame_pattern FROM assets WHERE id = ?'
    ).get(req.params.assetId);

    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    asset.file_path = resolveFilePath(asset.file_path);

    const maxWidth = parseInt(req.query.maxw) || 960;
    const isImage = asset.media_type === 'image';
    const isVideo = asset.media_type === 'video';
    const isSeq = asset.is_sequence === 1;

    // For single images, serve scaled via Sharp if possible, else raw
    if (isImage && !isSeq) {
        if (!fs.existsSync(asset.file_path)) return res.status(404).json({ error: 'File not found on disk' });

        try {
            const sharp = require('sharp');
            sharp(asset.file_path)
                .resize({ width: maxWidth, withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer()
                .then(buf => {
                    res.setHeader('Content-Type', 'image/jpeg');
                    res.setHeader('Cache-Control', 'public, max-age=300');
                    res.send(buf);
                })
                .catch(() => {
                    // Fallback: use FFmpeg for formats Sharp can't handle (EXR, BMP, DPX)
                    extractFrameWithFFmpeg(asset.file_path, maxWidth, res);
                });
        } catch {
            extractFrameWithFFmpeg(asset.file_path, maxWidth, res);
        }
        return;
    }

    // For sequences, grab first frame file
    if (isSeq) {
        const frameDir = asset.file_path; // Sequences store directory path
        if (!fs.existsSync(frameDir)) return res.status(404).json({ error: 'Sequence dir not found' });

        // Find first actual frame file
        const frames = fs.readdirSync(frameDir)
            .filter(f => /\.(exr|dpx|png|jpg|jpeg|tiff?|bmp)$/i.test(f))
            .sort();
        if (frames.length === 0) return res.status(404).json({ error: 'No frames in sequence' });

        const firstFrame = path.join(frameDir, frames[0]);
        extractFrameWithFFmpeg(firstFrame, maxWidth, res);
        return;
    }

    // For video, extract frame at 1 second (or first frame if shorter)
    if (isVideo) {
        if (!fs.existsSync(asset.file_path)) return res.status(404).json({ error: 'File not found on disk' });

        const args = [
            '-ss', '1',           // Seek to 1 second
            '-i', asset.file_path,
            '-frames:v', '1',
            '-vf', `scale='min(${maxWidth},iw)':-2`,
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-q:v', '3',
            '-'
        ];

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=300');

        const ff = spawn(resolvedFFmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        ff.stdout.pipe(res);
        ff.stderr.on('data', () => {}); // Swallow
        ff.on('error', () => res.status(500).end());
        res.on('close', () => ff.kill('SIGTERM'));
        return;
    }

    res.status(400).json({ error: 'Unsupported media type for overlay preview' });
});

// ═══════════════════════════════════════════
//  GET /api/overlay/asset-info/:assetId -- Get hierarchy + metadata for token resolution
// ═══════════════════════════════════════════

router.get('/asset-info/:assetId', (req, res) => {
    const db = getDb();
    const row = db.prepare(`
        SELECT
            a.vault_name, a.width, a.height, a.fps, a.duration, a.media_type,
            a.frame_start, a.frame_end, a.frame_count,
            p.code AS project_code, p.name AS project_name,
            sq.code AS sequence_code, sq.name AS sequence_name,
            sh.code AS shot_code, sh.name AS shot_name,
            r.code AS role_code, r.name AS role_name
        FROM assets a
        LEFT JOIN projects  p  ON a.project_id  = p.id
        LEFT JOIN sequences sq ON a.sequence_id = sq.id
        LEFT JOIN shots     sh ON a.shot_id     = sh.id
        LEFT JOIN roles     r  ON a.role_id     = r.id
        WHERE a.id = ?
    `).get(req.params.assetId);

    if (!row) return res.status(404).json({ error: 'Asset not found' });
    res.json(row);
});

// ═══════════════════════════════════════════
//  GET /api/overlay/font-path -- Get the resolved font file path
// ═══════════════════════════════════════════

router.get('/font-path', (req, res) => {
    const fontPath = findFontFile();
    res.json({ fontPath: fontPath || null });
});

// ═══════════════════════════════════════════
//  INTERNAL HELPERS
// ═══════════════════════════════════════════

function extractFrameWithFFmpeg(filePath, maxWidth, res) {
    const args = [
        '-i', filePath,
        '-frames:v', '1',
        '-vf', `scale='min(${maxWidth},iw)':-2`,
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '3',
        '-'
    ];

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');

    const ff = spawn(resolvedFFmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {});
    ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    res.on('close', () => ff.kill('SIGTERM'));
}

/**
 * Find a usable font file for FFmpeg drawtext (same logic as assetRoutes).
 */
function findFontFile() {
    const isWin = process.platform === 'win32';
    const candidates = isWin ? [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/calibri.ttf',
    ] : [
        '/System/Library/Fonts/Helvetica.ttc',
        '/System/Library/Fonts/SFNSText.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
    ];
    for (const f of candidates) {
        if (fs.existsSync(f)) return f.replace(/\\/g, '/').replace(/:/g, '\\:');
    }
    return null;
}

/**
 * Build FFmpeg drawtext filter chain from an overlay preset config.
 * Called by exportRoutes when an overlay is applied during export.
 *
 * @param {Object} config - Overlay preset config with elements array
 * @param {Object} hierarchy - Asset hierarchy {project_code, sequence_name, shot_name, role_code}
 * @param {string} vaultName - Asset vault_name (for {filename} token)
 * @returns {string} FFmpeg filter string e.g. "drawtext=...,drawtext=..."
 */
function buildDrawtextFilters(config, hierarchy, vaultName) {
    if (!config || !Array.isArray(config.elements) || config.elements.length === 0) return '';

    const fontPath = findFontFile();
    const fontParam = fontPath ? `fontfile='${fontPath}'` : 'font=Arial';
    const filters = [];

    for (const el of config.elements) {
        if (!el.enabled) continue;

        // Resolve text content
        const text = resolveFFmpegText(el, hierarchy, vaultName);
        if (!text) continue;

        // Build position expressions
        const pos = buildFFmpegPosition(el);

        // FFmpeg drawtext filter
        let filter = `drawtext=${fontParam}`;
        filter += `:text='${escapeFFmpegText(text)}'`;
        filter += `:fontsize=${el.fontSize || 24}`;
        filter += `:fontcolor=${hexToFFmpegColor(el.fontColor || '#ffffff', el.fontOpacity ?? 1.0)}`;
        filter += `:x=${pos.x}:y=${pos.y}`;

        if (el.bgEnabled) {
            filter += ':box=1';
            filter += `:boxcolor=${hexToFFmpegColor(el.bgColor || '#000000', el.bgOpacity ?? 0.5)}`;
            filter += `:boxborderw=${el.bgPadding || 6}`;
        }

        filters.push(filter);
    }

    return filters.join(',');
}

/**
 * Resolve element text -- static tokens are replaced here,
 * dynamic ones (frame number, timecode) use FFmpeg expressions.
 */
function resolveFFmpegText(el, hierarchy, vaultName) {
    const h = hierarchy || {};
    switch (el.type) {
        case 'shot_name':
            return h.shot_name || h.shot_code || 'SHOT';
        case 'sequence_name':
            return h.sequence_name || h.sequence_code || 'SEQ';
        case 'project_name':
            return h.project_code || h.project_name || 'PROJECT';
        case 'role':
            return h.role_code || h.role_name || 'ROLE';
        case 'filename':
            return (vaultName || 'file').replace(/\.[^.]+$/, '');
        case 'frame_number':
            return '%{frame_num}';
        case 'timecode':
            return '%{pts\\:hms}';
        case 'date':
            return new Date().toISOString().slice(0, 10);
        case 'custom':
            return el.text || '';
        case 'shot_and_frame':
            return (h.shot_name || h.shot_code || 'SHOT') + '  %{frame_num}';
        default:
            return el.text || '';
    }
}

/**
 * Compute FFmpeg x/y position expressions from anchor + offset.
 */
function buildFFmpegPosition(el) {
    const ox = el.offsetX || 20;
    const oy = el.offsetY || 20;

    switch (el.anchor) {
        case 'top-left':
            return { x: `${ox}`, y: `${oy}` };
        case 'top-center':
            return { x: `(w-text_w)/2`, y: `${oy}` };
        case 'top-right':
            return { x: `w-text_w-${ox}`, y: `${oy}` };
        case 'bottom-left':
            return { x: `${ox}`, y: `h-text_h-${oy}` };
        case 'bottom-center':
            return { x: `(w-text_w)/2`, y: `h-text_h-${oy}` };
        case 'bottom-right':
            return { x: `w-text_w-${ox}`, y: `h-text_h-${oy}` };
        case 'center':
            return { x: `(w-text_w)/2`, y: `(h-text_h)/2` };
        default:
            return { x: `${ox}`, y: `${oy}` };
    }
}

/**
 * Escape text for FFmpeg drawtext (single quotes, colons, backslashes).
 */
function escapeFFmpegText(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\\\\\''")
        .replace(/:/g, '\\:')
        .replace(/%/g, '%%')
        // But preserve FFmpeg expressions like %{frame_num}
        .replace(/%%%%{/g, '%{');
}

/**
 * Convert hex color + opacity to FFmpeg color format: 0xRRGGBB@opacity
 */
function hexToFFmpegColor(hex, opacity) {
    const clean = hex.replace('#', '');
    const alpha = opacity !== undefined ? opacity : 1.0;
    return `0x${clean}@${alpha}`;
}

// ═══════════════════════════════════════════
//  GET /api/overlay/preset-for-path -- Return overlay preset + hierarchy for RV plugin
//  Query: ?path=<filepath>&preset_id=<optional>
//  Returns combined preset config + resolved text values for each element type
// ═══════════════════════════════════════════

router.get('/preset-for-path', (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'path required' });

        const db = getDb();

        // --- Find asset by path (try all platform variants) ---
        const variants = getAllPathVariants(filePath);
        let asset = null;
        for (const v of variants) {
            asset = db.prepare(`
                SELECT a.*, r.name AS role_name, r.code AS role_code,
                       p.name AS project_name, p.code AS project_code,
                       seq.name AS sequence_name, seq.code AS sequence_code,
                       sh.name AS shot_name, sh.code AS shot_code
                FROM assets a
                LEFT JOIN roles r ON a.role_id = r.id
                LEFT JOIN projects p ON a.project_id = p.id
                LEFT JOIN sequences seq ON a.sequence_id = seq.id
                LEFT JOIN shots sh ON a.shot_id = sh.id
                WHERE a.file_path = ?
            `).get(v);
            if (asset) break;
        }

        if (!asset) return res.json({ found: false });

        // --- Get overlay preset (specific or default or first) ---
        let preset = null;
        if (req.query.preset_id) {
            preset = db.prepare('SELECT * FROM overlay_presets WHERE id = ?').get(req.query.preset_id);
        }
        if (!preset) {
            preset = db.prepare('SELECT * FROM overlay_presets WHERE is_default = 1 LIMIT 1').get();
        }
        if (!preset) {
            preset = db.prepare('SELECT * FROM overlay_presets ORDER BY id LIMIT 1').get();
        }
        if (!preset) return res.json({ found: true, preset: null });

        // --- Parse preset config ---
        let config;
        try { config = JSON.parse(preset.config); } catch (e) { config = { elements: [] }; }

        // --- Build resolved text values for each element type ---
        const hierarchy = {
            shot_name: asset.shot_name || asset.shot_code || '',
            sequence_name: asset.sequence_name || asset.sequence_code || '',
            project_name: asset.project_name || asset.project_code || '',
            role: asset.role_name || asset.role_code || '',
            filename: asset.vault_name || asset.original_name || '',
            status: asset.status || 'WIP',
            date: new Date().toISOString().slice(0, 10)
        };

        res.json({
            found: true,
            hierarchy,
            preset: {
                id: preset.id,
                name: preset.name,
                config
            }
        });
    } catch (e) {
        console.error('preset-for-path error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
module.exports.buildDrawtextFilters = buildDrawtextFilters;
module.exports.findFontFile = findFontFile;
