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
            const vaultBaseName = path.basename(nameResult.vaultName, nameResult.ext);
            const vaultExt = nameResult.ext;  // ".exr"

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
//  External Viewer helpers (mrViewer2 + RV)
// ═══════════════════════════════════════════

function findMrViewer2() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    if (isWin) {
        // Windows: check Program Files for vmrv2-*/mrv2 folders
        const candidates = [
            'C:\\Program Files\\vmrv2-v1.5.4\\bin\\mrv2.exe',
            'C:\\Program Files\\mrv2\\bin\\mrv2.exe',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        try {
            const progFiles = 'C:\\Program Files';
            const dirs = fs.readdirSync(progFiles).filter(d => d.startsWith('vmrv2') || d.startsWith('mrv2'));
            for (const d of dirs) {
                const exe = path.join(progFiles, d, 'bin', 'mrv2.exe');
                if (fs.existsSync(exe)) return exe;
            }
        } catch (e) { /* ignore */ }
    } else if (isMac) {
        // macOS: check /Applications for mrv2.app bundles
        const candidates = [
            '/Applications/mrv2.app/Contents/MacOS/mrv2',
            '/Applications/mrViewer2.app/Contents/MacOS/mrv2',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        try {
            const dirs = fs.readdirSync('/Applications').filter(d => d.toLowerCase().includes('mrv2') || d.toLowerCase().includes('mrviewer'));
            for (const d of dirs) {
                const exe = path.join('/Applications', d, 'Contents', 'MacOS', 'mrv2');
                if (fs.existsSync(exe)) return exe;
            }
        } catch (e) { /* ignore */ }
    } else {
        // Linux: check common install locations
        const candidates = [
            '/usr/local/bin/mrv2',
            '/usr/bin/mrv2',
            path.join(process.env.HOME || '', '.local', 'bin', 'mrv2'),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    }
    return null;
}

/**
 * Find RV (Autodesk/ShotGrid media viewer) executable on this machine.
 * Checks standard install locations per platform.
 */
function findRV() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

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
 * Launch file(s) in RV.
 * RV compare modes: -compare (A/B), -wipe (wipe), -tile (side by side)
 */
function launchInRV(exePath, filePaths, compareArgs) {
    const { execFile, execSync, spawnSync } = require('child_process');
    const cwd = path.dirname(exePath);

    // Kill existing RV instance so we reuse the window slot
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM rv.exe', { windowsHide: true, stdio: 'ignore' });
        } else {
            execSync('pkill -x RV || pkill -x rv || true', { stdio: 'ignore' });
        }
    } catch (e) { /* not running, that's fine */ }

    // Wait for process to fully die
    if (process.platform === 'win32') {
        spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { windowsHide: true });
    } else {
        spawnSync('sleep', ['0.3']);
    }

    const args = [...filePaths];
    if (compareArgs) args.push(...compareArgs);
    execFile(exePath, args, { cwd });
    console.log(`[RV] Launched: ${filePaths.length} file(s)${compareArgs ? ' (' + compareArgs[0].replace('-', '') + ' mode)' : ''}`);
}

/**
 * Capture mrViewer2 window position before killing it (Windows only).
 * Returns { left, top, width, height } or null.
 * On macOS/Linux, returns null (window position restore not supported yet).
 */
function getMrv2WindowRect() {
    if (process.platform !== 'win32') return null;

    const { spawnSync } = require('child_process');
    // C# helper that enumerates all windows for mrv2 PIDs and returns the largest
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class MrvWinHelper {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWinProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    delegate bool EnumWinProc(IntPtr h, IntPtr lp);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static string GetLargestRect(string procName) {
        var procs = Process.GetProcessesByName(procName);
        if (procs.Length == 0) return "NO_PROCESS";
        var pids = new HashSet<uint>();
        foreach (var p in procs) pids.Add((uint)p.Id);

        string best = "NONE";
        int bestArea = 0;
        EnumWindows((h, lp) => {
            uint wp; GetWindowThreadProcessId(h, out wp);
            if (pids.Contains(wp) && IsWindowVisible(h)) {
                RECT r; GetWindowRect(h, out r);
                int w = r.Right - r.Left, ht = r.Bottom - r.Top;
                int area = w * ht;
                if (w > 200 && ht > 200 && area > bestArea) {
                    bestArea = area;
                    best = r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
                }
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
'@
Write-Output ([MrvWinHelper]::GetLargestRect("mrv2"))
`;
    try {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
            windowsHide: true, encoding: 'utf-8', timeout: 8000
        });
        const output = (result.stdout || '').trim();
        if (output && output !== 'NONE' && output !== 'NO_PROCESS' && output.includes(',')) {
            const [left, top, right, bottom] = output.split(',').map(Number);
            const width = right - left, height = bottom - top;
            if (!isNaN(left) && !isNaN(top) && width > 200 && height > 200) {
                return { left, top, width, height };
            }
        }
        if (result.stderr) console.log(`[mrViewer2] GetRect stderr: ${result.stderr.trim().slice(0, 200)}`);
    } catch (e) { console.log(`[mrViewer2] GetRect error: ${e.message}`); }
    return null;
}

/**
 * Move mrViewer2 window to a saved position (Windows only).
 * Retries up to 10 times (every 800ms) waiting for the main window to appear.
 */
function restoreMrv2Position(rect, attempt = 1) {
    if (process.platform !== 'win32') return;  // Only supported on Windows
    if (attempt > 10) {
        console.log(`[mrViewer2] Could not restore position after ${attempt - 1} attempts`);
        return;
    }
    const { spawnSync } = require('child_process');
    // Find largest mrv2 window and move it
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class MrvWinMover {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWinProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    delegate bool EnumWinProc(IntPtr h, IntPtr lp);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static string MoveMainWindow(string procName, int tx, int ty, int tw, int th) {
        var procs = Process.GetProcessesByName(procName);
        if (procs.Length == 0) return "NO_PROCESS";
        var pids = new HashSet<uint>();
        foreach (var p in procs) pids.Add((uint)p.Id);

        IntPtr bestHwnd = IntPtr.Zero;
        int bestArea = 0;
        EnumWindows((h, lp) => {
            uint wp; GetWindowThreadProcessId(h, out wp);
            if (pids.Contains(wp) && IsWindowVisible(h)) {
                RECT r; GetWindowRect(h, out r);
                int w = r.Right - r.Left, ht2 = r.Bottom - r.Top;
                int area = w * ht2;
                if (w > 200 && ht2 > 200 && area > bestArea) {
                    bestArea = area;
                    bestHwnd = h;
                }
            }
            return true;
        }, IntPtr.Zero);

        if (bestHwnd != IntPtr.Zero) {
            MoveWindow(bestHwnd, tx, ty, tw, th, true);
            SetForegroundWindow(bestHwnd);
            return "ok";
        }
        return "WAIT";
    }
}
'@
Write-Output ([MrvWinMover]::MoveMainWindow("mrv2", ${rect.left}, ${rect.top}, ${rect.width}, ${rect.height}))
`;
    try {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
            windowsHide: true, encoding: 'utf-8', timeout: 8000
        });
        const out = (result.stdout || '').trim();
        if (out === 'ok') {
            console.log(`[mrViewer2] Restored position: ${rect.left},${rect.top} ${rect.width}x${rect.height} (attempt ${attempt})`);
            return;
        }
        console.log(`[mrViewer2] Restore attempt ${attempt}: ${out}`);
    } catch (e) { /* */ }
    // Window not ready yet — retry
    setTimeout(() => restoreMrv2Position(rect, attempt + 1), 800);
}

/**
 * Launch file(s) in mrViewer2.
 * Captures window position, kills existing instance, launches new one,
 * then restores the window to the same monitor/position.
 */
function launchInMrv2(exePath, filePaths, compareArgs) {
    const { execFile, execSync, spawnSync } = require('child_process');
    const cwd = path.dirname(exePath);

    // Capture window position before killing (Windows only)
    const savedRect = getMrv2WindowRect();
    if (savedRect) {
        console.log(`[mrViewer2] Saved position: ${savedRect.left},${savedRect.top} ${savedRect.width}x${savedRect.height}`);
    } else {
        console.log(`[mrViewer2] No existing window found — will open at default position`);
    }

    // Kill existing mrViewer2 (cross-platform)
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /F /IM mrv2.exe', { windowsHide: true, stdio: 'ignore' });
        } else {
            execSync('pkill -f mrv2 || true', { stdio: 'ignore' });
        }
    } catch (e) { /* not running, that's fine */ }

    // Wait for process to fully die before launching new one
    if (process.platform === 'win32') {
        spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { windowsHide: true });
    } else {
        spawnSync('sleep', ['0.3']);
    }

    const args = [];
    // For single image files, use -s (single/still) to prevent mrv2 from
    // scanning for version sequences (its version_regex:_v matches our _vNNN
    // vault naming, causing "Cannot open" errors for deleted prior versions)
    if (!compareArgs && filePaths.length === 1) {
        const ext = path.extname(filePaths[0]).toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.exr', '.tif', '.tiff', '.bmp', '.tga', '.hdr', '.webp', '.gif'];
        if (imageExts.includes(ext)) {
            args.push('-s');
        }
    }
    args.push(...filePaths);
    if (compareArgs) args.push(...compareArgs);
    execFile(exePath, args, { cwd });
    console.log(`[mrViewer2] Launched: ${filePaths.length} file(s)${args.includes('-s') ? ' (single/still mode)' : ''}`);

    // Restore window to previous position/monitor after it opens
    if (savedRect) {
        setTimeout(() => restoreMrv2Position(savedRect), 2000);
    }
}

// GET /api/assets/viewer-status — Which external viewers are installed
router.get('/viewer-status', (req, res) => {
    res.json({
        mrviewer2: !!findMrViewer2(),
        rv: !!findRV(),
    });
});

// POST /api/assets/open-compare — Open multiple files in external viewer for A/B compare
// Accepts optional `viewer` body param: 'mrviewer2' (default) or 'rv'
router.post('/open-compare', (req, res) => {
    const db = getDb();
    const { ids, viewer } = req.body || {};
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

    if (viewer === 'rv') {
        // RV compare mode
        const exePath = findRV();
        if (!exePath) {
            return res.status(404).json({ error: 'RV not found. Install Autodesk RV / ShotGrid RV.' });
        }
        // RV: all files then -wipe flag
        const compareArgs = filePaths.length >= 2 ? ['-wipe'] : null;
        launchInRV(exePath, filePaths, compareArgs);
        console.log(`[RV] Compare: ${filePaths.length} files`);
        res.json({ success: true, count: filePaths.length, viewer: 'rv' });
    } else {
        // mrViewer2 compare mode (default)
        const exePath = findMrViewer2();
        if (!exePath) {
            return res.status(404).json({ error: 'mrViewer2 not found. Install from https://mrv2.sourceforge.io/' });
        }
        let compareArgs = null;
        if (filePaths.length >= 2) {
            const bFile = filePaths.pop();
            compareArgs = ['-compare', bFile, '-compareMode', 'Wipe'];
        }
        launchInMrv2(exePath, filePaths, compareArgs);
        console.log(`[mrViewer2] Compare: ${filePaths.length + (compareArgs ? 1 : 0)} files`);
        res.json({ success: true, count: filePaths.length + (compareArgs ? 1 : 0), viewer: 'mrviewer2' });
    }
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
        // mrViewer2 (default)
        exePath = findMrViewer2();
        if (!exePath) {
            return res.status(404).json({ error: 'mrViewer2 not found. Install from https://mrv2.sourceforge.io/' });
        }
        launchInMrv2(exePath, [asset.file_path]);
        playerName = 'mrViewer2';
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
