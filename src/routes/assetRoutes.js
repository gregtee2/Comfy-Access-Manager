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
const { generateVaultName, getVaultDirectory } = require('../utils/naming');

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

    let query = 'SELECT COUNT(*) as count, MAX(created_at) as latest FROM assets';
    const params = [];
    if (project_id) {
        query += ' WHERE project_id = ?';
        params.push(project_id);
    }

    const row = db.prepare(query).get(...params);
    res.json({ count: row.count || 0, latest: row.latest || null });
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

    query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const assets = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM assets').get();

    res.json({ assets, total: total.count });
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

    res.json({
        path: dir,
        parent: parentDir !== dir ? parentDir : null,
        entries,
    });
});


// ═══════════════════════════════════════════
//  PREVIEW NAME — preview what the rename would produce
//  MUST be above /:id to avoid wildcard match
// ═══════════════════════════════════════════

router.post('/preview-name', (req, res) => {
    const { originalName, projectCode, sequenceCode, shotCode, roleCode, takeNumber, customName, template } = req.body;

    if (!originalName || !projectCode) {
        return res.status(400).json({ error: 'originalName and projectCode required' });
    }

    const { type: mediaType } = detectMediaType(originalName);

    const { vaultName } = generateVaultName({
        originalName,
        projectCode,
        sequenceCode,
        shotCode,
        roleCode,
        takeNumber,
        mediaType,
        customName,
        template,
    });

    res.json({ vaultName, mediaType });
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

// GET /api/assets/compare-targets-by-path — Same as compare-targets but looks up asset by file_path
// Used by RV plugin to find compare targets for the currently loaded file
router.get('/compare-targets-by-path', (req, res) => {
    const db = getDb();
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Provide ?path= parameter' });

    // Normalize slashes for comparison (DB might store either format)
    const normalized = filePath.replace(/\\/g, '/');
    const asset = db.prepare(`
        SELECT id, shot_id, project_id, role_id, vault_name
        FROM assets
        WHERE replace(file_path, '\\', '/') = ?
    `).get(normalized);
    if (!asset) return res.status(404).json({ error: 'Asset not found in vault' });
    if (!asset.shot_id) return res.json({ asset: { id: asset.id, vault_name: asset.vault_name }, roles: [] });

    // Reuse the same sibling query
    const siblings = db.prepare(`
        SELECT a.id, a.vault_name, a.version, a.file_ext, a.media_type, a.file_size,
               a.file_path,
               a.role_id, r.name AS role_name, r.code AS role_code, r.icon AS role_icon, r.color AS role_color,
               r.sort_order AS role_sort
        FROM assets a
        LEFT JOIN roles r ON a.role_id = r.id
        WHERE a.shot_id = ? AND a.project_id = ? AND a.id != ?
        ORDER BY r.sort_order ASC, r.name ASC, a.version DESC
    `).all(asset.shot_id, asset.project_id, asset.id);

    const roleMap = new Map();
    for (const s of siblings) {
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
            id: s.id,
            vault_name: s.vault_name,
            version: s.version,
            file_ext: s.file_ext,
            file_path: s.file_path
        });
    }

    res.json({ asset: { id: asset.id, vault_name: asset.vault_name }, roles: [...roleMap.values()] });
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
    res.json(asset);
});


// ═══════════════════════════════════════════
//  IMPORT ASSETS
// ═══════════════════════════════════════════

// POST /api/assets/import — Import files from filesystem paths
// Supports: individual files, frame sequences (auto-detected), and derivative generation
router.post('/import', async (req, res) => {
    const { files, project_id, sequence_id, shot_id, role_id, take_number, custom_name, template } = req.body;

    if (!files || !files.length) {
        return res.status(400).json({ error: 'No files provided' });
    }
    if (!project_id) {
        return res.status(400).json({ error: 'Project ID required' });
    }

    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let sequence = null, shot = null, role = null;
    if (sequence_id) sequence = db.prepare('SELECT * FROM sequences WHERE id = ?').get(sequence_id);
    if (shot_id) shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(shot_id);
    if (role_id) role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);

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
    for (const seq of detectedSeqs) {
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
            } else {
                const naming = require('../utils/naming');
                const nameResult = naming.generateVaultName({
                    originalName: seqOriginalName,
                    projectCode: project.code,
                    sequenceCode: sequence?.code,
                    shotCode: shot?.code,
                    roleCode: role?.code,
                    takeNumber: take_number || 1,
                    mediaType,
                    customName: custom_name || null,
                    counter: 1,
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

                for (let fi = 0; fi < seq.files.length; fi++) {
                    const srcFrame = seq.files[fi];
                    const frameNum = seq.frameStart + fi;
                    const frameFilename = buildFrameFilename(vaultBaseName, frameNum, seq.digits, vaultExt);
                    const destPath = path.join(vaultDir, frameFilename);

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
                    is_sequence, frame_start, frame_end, frame_count, frame_pattern
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        }
    }

    // ── Step 3: Import remaining single files normally ──
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
                } else {
                    const naming = require('../utils/naming');
                    const nameResult = naming.generateVaultName({
                        originalName,
                        projectCode: project.code,
                        sequenceCode: sequence?.code,
                        shotCode: shot?.code,
                        roleCode: role?.code,
                        takeNumber: take_number || (i + 1),
                        customName: singles.length === 1 && !detectedSeqs.length ? custom_name : null,
                        counter: i + 1,
                    });
                    vaultName = nameResult.vaultName;
                }
            } else {
                const imported = FileService.importFile(filePath, {
                    projectCode: project.code,
                    sequenceCode: sequence?.code,
                    shotCode: shot?.code,
                    roleCode: role?.code,
                    takeNumber: take_number || (i + 1),
                    customName: singles.length === 1 && !detectedSeqs.length ? custom_name : null,
                    template,
                    counter: i + 1,
                    keepOriginals: !!req.body.keep_originals,
                    keepOriginalName: keepOriginalNames,
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
                    take_number, version, is_linked
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        }
    }

    // Update project timestamp
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(project.id);

    const sequenceCount = detectedSeqs.length;
    const singleCount = singles.length;

    res.json({
        imported: results.length,
        errors: errors.length,
        assets: results,
        errors_detail: errors,
        sequences_detected: sequenceCount,
        singles_imported: singleCount,
        derivative_jobs: derivativeJobIds,
    });
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
                    take_number, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const deleteFile = req.query.delete_file !== 'false'; // Default: delete physical file

    // Never delete the physical file for linked/referenced assets
    if (deleteFile && !asset.is_linked && fs.existsSync(asset.file_path)) {
        fs.unlinkSync(asset.file_path);
    }

    // Delete thumbnail
    ThumbnailService.deleteThumb(asset.id);

    db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
    logActivity('asset_deleted', 'asset', asset.id, { name: asset.vault_name });

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

    res.json({ success: true, updated: ids.length });
});

// POST /api/assets/bulk-delete — Delete multiple assets at once
router.post('/bulk-delete', (req, res) => {
    const db = getDb();
    const { ids, delete_files = true } = req.body;

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

    const { spawn } = require('child_process');
    const args = [
        '-i', asset.file_path,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        ...(scaleFilter ? ['-vf', `scale=${maxW}:-2`] : []),
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        '-f', 'mp4',
        '-'
    ];

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');

    const ffmpeg = spawn(ffmpegPath, args);
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

    // 2. Check MediaVault bundled RV (tools/rv/ — installed by install.bat)
    const bundledRv = path.join(__dirname, '..', '..', 'tools', 'rv', 'bin', isWin ? 'rv.exe' : 'rv');
    if (fs.existsSync(bundledRv)) return bundledRv;

    // 3. Check OpenRV local build (common for self-compiled OpenRV)
    const openrvBuild = 'C:\\OpenRV\\_build\\stage\\app\\bin\\rv.exe';
    if (isWin && fs.existsSync(openrvBuild)) return openrvBuild;

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
 * @param {string[]} compareArgs - Optional compare flags (e.g. ['-wipe'])
 * @returns {{ success: boolean, started: boolean }} - started=true if we had to launch a new RV
 */
function rvPush(pushExe, filePaths, mode = 'set', compareArgs = null) {
    const { spawnSync } = require('child_process');
    const cwd = path.dirname(pushExe);

    // Build rvpush arguments
    const args = [mode, ...filePaths];
    if (compareArgs) args.push(...compareArgs);

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
 * RV compare modes: -compare (A/B), -wipe (wipe), -tile (side by side)
 */
function launchInRV(exePath, filePaths, compareArgs) {
    const { execFile, spawnSync } = require('child_process');
    const cwd = path.dirname(exePath);
    const pushExe = findRvPush();

    // If rvpush is available, try pushing to a running session first
    if (pushExe) {
        const pushResult = rvPush(pushExe, filePaths, 'set', compareArgs);
        if (pushResult.success) return;
    }

    // No running RV (or no rvpush) — launch fresh with -network enabled
    const args = ['-network', ...filePaths];
    if (compareArgs) args.push(...compareArgs);
    execFile(exePath, args, { cwd });
    console.log(`[RV] Launched new session (-network): ${filePaths.length} file(s)${compareArgs ? ' (' + compareArgs[0].replace('-', '') + ' mode)' : ''}`);
}

// GET /api/assets/:id/compare-targets — Get sibling assets in the same shot, grouped by role
// Used by "Compare To →" context menu to show versions by role
router.get('/:id/compare-targets', (req, res) => {
    const db = getDb();
    const asset = db.prepare('SELECT id, shot_id, project_id, role_id FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.shot_id) return res.json({ roles: [] }); // No shot context → nothing to compare

    // Get all assets in the same shot (excluding the current one), with role info
    const siblings = db.prepare(`
        SELECT a.id, a.vault_name, a.version, a.file_ext, a.media_type, a.file_size,
               a.file_path,
               a.role_id, r.name AS role_name, r.code AS role_code, r.icon AS role_icon, r.color AS role_color,
               r.sort_order AS role_sort
        FROM assets a
        LEFT JOIN roles r ON a.role_id = r.id
        WHERE a.shot_id = ? AND a.project_id = ? AND a.id != ?
        ORDER BY r.sort_order ASC, r.name ASC, a.version DESC
    `).all(asset.shot_id, asset.project_id, asset.id);

    // Group by role
    const roleMap = new Map();
    for (const s of siblings) {
        const key = s.role_id || 0; // 0 = unassigned
        if (!roleMap.has(key)) {
            roleMap.set(key, {
                id: s.role_id,
                name: s.role_name || 'Unassigned',
                code: s.role_code || '',
                icon: s.role_icon || '📁',
                color: s.role_color || '#888888',
                assets: []
            });
        }
        roleMap.get(key).assets.push({
            id: s.id,
            vault_name: s.vault_name,
            version: s.version,
            file_ext: s.file_ext,
            media_type: s.media_type,
            file_size: s.file_size,
            file_path: s.file_path
        });
    }

    res.json({ roles: [...roleMap.values()] });
});

// POST /api/assets/rv-push — Push files to a running RV session (or start one)
// Body: { ids: [assetId, ...], mode: 'set'|'merge', compareArgs: ['-wipe'] }
//   mode 'set' = replace current media, 'merge' = add to sources
router.post('/rv-push', (req, res) => {
    const db = getDb();
    const { ids, mode, compareArgs } = req.body || {};
    if (!ids || !Array.isArray(ids) || ids.length < 1) {
        return res.status(400).json({ error: 'Provide an array of asset ids' });
    }

    const pushExe = findRvPush();
    const rvExe = findRV();
    if (!pushExe && !rvExe) {
        return res.status(404).json({ error: 'Neither rvpush nor RV found.' });
    }

    // Resolve file paths
    const filePaths = [];
    for (const id of ids) {
        const asset = db.prepare('SELECT file_path FROM assets WHERE id = ?').get(id);
        if (asset && fs.existsSync(asset.file_path)) {
            filePaths.push(asset.file_path);
        }
    }
    if (filePaths.length === 0) {
        return res.status(404).json({ error: 'No valid files found' });
    }

    const pushMode = mode === 'merge' ? 'merge' : 'set';

    // Try rvpush first
    if (pushExe) {
        const result = rvPush(pushExe, filePaths, pushMode, compareArgs || null);
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
        launchInRV(rvExe, filePaths, compareArgs || null);
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

// POST /api/assets/open-compare — Open multiple files in RV for A/B compare
router.post('/open-compare', (req, res) => {
    const db = getDb();
    const { ids } = req.body || {};
    if (!ids || !Array.isArray(ids) || ids.length < 1) {
        return res.status(400).json({ error: 'Provide an array of asset ids' });
    }

    // Look up file paths for all requested assets
    const filePaths = [];
    for (const id of ids) {
        const asset = db.prepare('SELECT file_path, vault_name FROM assets WHERE id = ?').get(id);
        if (asset && fs.existsSync(asset.file_path)) {
            filePaths.push(asset.file_path);
        }
    }
    if (filePaths.length === 0) {
        return res.status(404).json({ error: 'No valid files found' });
    }

    const exePath = findRV();
    if (!exePath) {
        return res.status(404).json({ error: 'RV not found. Install OpenRV or Autodesk RV.' });
    }
    // RV: all files then -wipe flag for 2+ files
    const compareArgs = filePaths.length >= 2 ? ['-wipe'] : null;
    launchInRV(exePath, filePaths, compareArgs);
    console.log(`[RV] Compare: ${filePaths.length} files`);
    res.json({ success: true, count: filePaths.length, viewer: 'rv' });
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
        // No overlays selected — just open normally
        launchInRV(exePath, [asset.file_path]);
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
    const asset = db.prepare('SELECT file_path, vault_name FROM assets WHERE id = ?').get(req.params.id);
    if (!asset || !fs.existsSync(asset.file_path)) {
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
        execFile(exePath, [asset.file_path], { cwd: path.dirname(exePath) });
        playerName = path.basename(exePath);
    } else if (player === 'rv') {
        exePath = findRV();
        if (!exePath) {
            return res.status(404).json({ error: 'RV not found. Install Autodesk RV / ShotGrid RV.' });
        }
        launchInRV(exePath, [asset.file_path]);
        playerName = 'RV';
    } else {
        // RV (default)
        exePath = findRV();
        if (!exePath) {
            return res.status(404).json({ error: 'RV not found. Install OpenRV or set path in Settings.' });
        }
        launchInRV(exePath, [asset.file_path]);
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

module.exports = router;
