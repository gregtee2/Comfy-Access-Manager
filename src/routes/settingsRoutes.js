/**
 * MediaVault - Settings Routes
 * App configuration, watch folders, and system info
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getAllSettings, setSetting, getSetting, getRecentActivity, getDb } = require('../database');
const WatcherService = require('../services/WatcherService');
const FileService = require('../services/FileService');
const MediaInfoService = require('../services/MediaInfoService');
const ThumbnailService = require('../services/ThumbnailService');
const { detectMediaType } = require('../utils/mediaTypes');

// GET /api/settings — All settings
router.get('/', (req, res) => {
    const settings = getAllSettings();
    res.json(settings);
});

// POST /api/settings — Update settings
router.post('/', (req, res) => {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
        setSetting(key, value);
    }

    // If vault_root changed, create it
    if (updates.vault_root) {
        FileService.ensureDir(updates.vault_root);
    }

    // If ComfyUI watch toggle changed, start/stop watcher
    if (updates.comfyui_watch_enabled !== undefined) {
        const comfyPath = getSetting('comfyui_output_path');
        if (updates.comfyui_watch_enabled === 'true' && comfyPath) {
            // Start watching ComfyUI output
            try {
                WatcherService.watchFolder(comfyPath, null, 'comfyui');
            } catch {}
        } else if (comfyPath) {
            WatcherService.unwatchFolder(comfyPath);
        }
    }

    res.json({ success: true, settings: getAllSettings() });
});

// GET /api/settings/status — System status info
router.get('/status', (req, res) => {
    const db = getDb();
    const projectCount = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
    const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets').get().count;
    const watchCount = db.prepare('SELECT COUNT(*) as count FROM watch_folders WHERE auto_import = 1').get().count;
    
    const vaultRoot = getSetting('vault_root');
    let vaultExists = false;
    let vaultSize = null;

    if (vaultRoot && fs.existsSync(vaultRoot)) {
        vaultExists = true;
    }

    res.json({
        version: require('../../package.json').version,
        projects: projectCount,
        assets: assetCount,
        watchFolders: watchCount,
        vaultRoot,
        vaultConfigured: !!vaultRoot && vaultExists,
        ffmpegAvailable: !!require('../services/ThumbnailService').findFFmpeg(),
    });
});

// POST /api/settings/setup-vault — First-time vault setup
router.post('/setup-vault', (req, res) => {
    const { path: vaultPath } = req.body;
    if (!vaultPath) return res.status(400).json({ error: 'Path required' });

    try {
        FileService.ensureDir(vaultPath);
        setSetting('vault_root', vaultPath);
        res.json({ success: true, path: vaultPath });
    } catch (err) {
        res.status(500).json({ error: `Failed to create vault: ${err.message}` });
    }
});

// POST /api/settings/migrate-vault — Move all vault files to a new location
router.post('/migrate-vault', async (req, res) => {
    // Allow up to 30 minutes for large vaults
    req.setTimeout(30 * 60 * 1000);
    res.setTimeout(30 * 60 * 1000);
    const { oldRoot, newRoot } = req.body;
    if (!oldRoot || !newRoot) return res.status(400).json({ error: 'oldRoot and newRoot required' });
    if (path.resolve(oldRoot) === path.resolve(newRoot)) return res.status(400).json({ error: 'Old and new roots are the same' });
    if (!fs.existsSync(oldRoot)) return res.status(400).json({ error: `Old vault not found: ${oldRoot}` });

    try {
        // 1. Ensure new root exists
        FileService.ensureDir(newRoot);

        // 2. Recursively copy all contents from old vault to new vault
        const copyDir = (src, dest) => {
            let count = 0;
            FileService.ensureDir(dest);
            const entries = fs.readdirSync(src, { withFileTypes: true });
            for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    count += copyDir(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                    count++;
                }
            }
            return count;
        };

        // Only copy vault content directories (project folders, thumbnails, etc.)
        // Skip the database file and app code
        const oldNorm = path.resolve(oldRoot);
        const appDir = path.resolve(__dirname, '..', '..');
        let filesCopied = 0;

        const topEntries = fs.readdirSync(oldRoot, { withFileTypes: true });
        for (const entry of topEntries) {
            const srcFull = path.join(oldRoot, entry.name);
            const destFull = path.join(newRoot, entry.name);
            // Skip if it's the app directory itself (e.g. vault is inside app folder)
            if (path.resolve(srcFull) === appDir) continue;
            // Skip node_modules, src, public, package.json etc
            if (['node_modules', 'src', 'public', 'comfyui', 'package.json', 'package-lock.json', 'start.bat', 'start.sh', '.git', '.gitignore'].includes(entry.name)) continue;

            if (entry.isDirectory()) {
                filesCopied += copyDir(srcFull, destFull);
            } else {
                FileService.ensureDir(newRoot);
                fs.copyFileSync(srcFull, destFull);
                filesCopied++;
            }
        }

        // 3. Update all database paths
        const db = getDb();
        const oldPrefix = oldNorm.replace(/\\/g, '\\');
        const newPrefix = path.resolve(newRoot).replace(/\\/g, '\\');

        // Assets: file_path and thumbnail_path
        const assets = db.prepare('SELECT id, file_path, thumbnail_path FROM assets').all();
        const updateAsset = db.prepare('UPDATE assets SET file_path = ?, thumbnail_path = ? WHERE id = ?');
        let pathsUpdated = 0;
        for (const a of assets) {
            let fp = a.file_path;
            let tp = a.thumbnail_path;
            let changed = false;
            if (fp && fp.startsWith(oldPrefix)) {
                fp = newPrefix + fp.slice(oldPrefix.length);
                changed = true;
            }
            if (tp && tp.startsWith(oldPrefix)) {
                tp = newPrefix + tp.slice(oldPrefix.length);
                changed = true;
            }
            if (changed) {
                updateAsset.run(fp, tp, a.id);
                pathsUpdated++;
            }
        }

        // ComfyUI mappings: file_path
        const mappings = db.prepare('SELECT id, file_path FROM comfyui_mappings').all();
        const updateMapping = db.prepare('UPDATE comfyui_mappings SET file_path = ? WHERE id = ?');
        for (const m of mappings) {
            if (m.file_path && m.file_path.startsWith(oldPrefix)) {
                updateMapping.run(newPrefix + m.file_path.slice(oldPrefix.length), m.id);
            }
        }

        // 4. Update vault_root setting
        setSetting('vault_root', newRoot);

        // 5. Remove old vault directory contents (only the stuff we copied)
        let cleaned = 0;
        const removeDir = (dir) => {
            let c = 0;
            if (!fs.existsSync(dir)) return c;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    c += removeDir(fullPath);
                    fs.rmdirSync(fullPath);
                } else {
                    fs.unlinkSync(fullPath);
                    c++;
                }
            }
            return c;
        };

        for (const entry of topEntries) {
            if (['node_modules', 'src', 'public', 'comfyui', 'package.json', 'package-lock.json', 'start.bat', 'start.sh', '.git', '.gitignore'].includes(entry.name)) continue;
            const srcFull = path.join(oldRoot, entry.name);
            if (path.resolve(srcFull) === appDir) continue;
            if (!fs.existsSync(srcFull)) continue;

            if (entry.isDirectory()) {
                cleaned += removeDir(srcFull);
                try { fs.rmdirSync(srcFull); } catch {}
            } else {
                fs.unlinkSync(srcFull);
                cleaned++;
            }
        }

        res.json({
            success: true,
            filesCopied,
            pathsUpdated,
            cleaned,
            newRoot,
        });

    } catch (err) {
        console.error('Migration error:', err);
        res.status(500).json({ error: `Migration failed: ${err.message}` });
    }
});

// ═══════════════════════════════════════════
//  WATCH FOLDERS
// ═══════════════════════════════════════════

// GET /api/settings/watches
router.get('/watches', (req, res) => {
    const watches = WatcherService.getAll();
    res.json(watches);
});

// POST /api/settings/watches
router.post('/watches', (req, res) => {
    const { path: folderPath, project_id, auto_import = false } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'Path required' });
    if (!fs.existsSync(folderPath)) return res.status(400).json({ error: 'Folder does not exist' });

    try {
        const id = WatcherService.addWatch(folderPath, project_id, auto_import);
        res.status(201).json({ id, path: folderPath });
    } catch (err) {
        res.status(409).json({ error: err.message });
    }
});

// DELETE /api/settings/watches/:id
router.delete('/watches/:id', (req, res) => {
    WatcherService.removeWatch(parseInt(req.params.id));
    res.json({ success: true });
});

// ═══════════════════════════════════════════
//  ACTIVITY LOG
// ═══════════════════════════════════════════

router.get('/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const activity = getRecentActivity(limit);
    res.json(activity);
});

// ═══════════════════════════════════════════
//  FILE BROWSER (for vault setup / folder picking)
// ═══════════════════════════════════════════

router.get('/browse-folders', (req, res) => {
    const { dir } = req.query;

    if (!dir) {
        const drives = FileService.getDrives();
        res.json({ path: '', entries: drives.map(d => ({ name: d, path: d, isDirectory: true })) });
        return;
    }

    try {
        const entries = FileService.browseDirectory(dir)
            .filter(e => e.isDirectory); // Only show folders for path picker
        const parentDir = path.dirname(dir);
        res.json({
            path: dir,
            parent: parentDir !== dir ? parentDir : null,
            entries,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/settings/rebuild-vault — Re-scan vault files and rebuild database records
router.post('/rebuild-vault', async (req, res) => {
    req.setTimeout(30 * 60 * 1000);
    res.setTimeout(30 * 60 * 1000);

    const vaultRoot = getSetting('vault_root');
    if (!vaultRoot || !fs.existsSync(vaultRoot)) {
        return res.status(400).json({ error: 'Vault root not set or not found' });
    }

    const SKIP_DIRS = new Set(['thumbnails', 'data', '.git', 'node_modules']);
    const db = getDb();

    try {
        // 1. Discover project folders (top-level dirs in vault)
        const topEntries = fs.readdirSync(vaultRoot, { withFileTypes: true });
        const projectDirs = topEntries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name));

        let totalFiles = 0;
        let processed = 0;
        let errors = 0;
        const projectsCreated = [];

        // Pre-count files for progress
        for (const pDir of projectDirs) {
            const pPath = path.join(vaultRoot, pDir.name);
            const countFiles = (dir) => {
                let count = 0;
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
                    else count++;
                }
                return count;
            };
            totalFiles += countFiles(pPath);
        }

        console.log(`[Rebuild] Starting vault rebuild: ${projectDirs.length} projects, ${totalFiles} files`);

        for (const pDir of projectDirs) {
            const projectCode = pDir.name;
            const projectPath = path.join(vaultRoot, projectCode);

            // Create project if not exists
            let project = db.prepare('SELECT * FROM projects WHERE code = ?').get(projectCode);
            if (!project) {
                db.prepare('INSERT INTO projects (name, code, type) VALUES (?, ?, ?)').run(projectCode, projectCode, 'flexible');
                project = db.prepare('SELECT * FROM projects WHERE code = ?').get(projectCode);
            }
            projectsCreated.push({ code: projectCode, id: project.id });

            // Recursively scan project directory for media files
            const scanDir = async (dir, seqCode, shotCode) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });

                // Process subdirectories first (might be type folders like image/video/threed, or seq/shot folders)
                const subDirs = entries.filter(e => e.isDirectory());
                const files = entries.filter(e => !e.isDirectory());

                for (const sub of subDirs) {
                    await scanDir(path.join(dir, sub.name), seqCode, shotCode);
                }

                // Process files in this directory
                for (const file of files) {
                    const filePath = path.join(dir, file.name);
                    const ext = path.extname(file.name).toLowerCase();
                    const { type: mediaType } = detectMediaType(file.name);
                    if (mediaType === 'document') { processed++; continue; } // Skip non-media

                    try {
                        // Parse naming convention: {CODE}_{type}_{counter}_v{version}.ext
                        // Or: {CODE}_{seq}_{type}_{counter}_v{version}.ext
                        const baseName = path.basename(file.name, ext);
                        const parts = baseName.split('_');
                        let version = 1;
                        let counter = null;

                        // Extract version from last part (v001, v002, etc.)
                        const lastPart = parts[parts.length - 1];
                        if (lastPart && /^v\d+$/i.test(lastPart)) {
                            version = parseInt(lastPart.substring(1));
                        }

                        // Extract counter (the numeric part before version)
                        for (let i = parts.length - 2; i >= 0; i--) {
                            if (/^\d{3,}$/.test(parts[i])) {
                                counter = parseInt(parts[i]);
                                break;
                            }
                        }

                        const relativePath = path.relative(vaultRoot, filePath);

                        // Check if asset already exists (by file_path or vault_name)
                        const existing = db.prepare('SELECT id FROM assets WHERE file_path = ? OR vault_name = ?').get(filePath, file.name);
                        if (existing) { processed++; continue; }

                        // Probe metadata
                        const info = await MediaInfoService.probe(filePath);

                        // Insert asset
                        const result = db.prepare(`
                            INSERT INTO assets (
                                project_id, sequence_id, shot_id,
                                original_name, vault_name, file_path, relative_path,
                                media_type, file_ext, file_size,
                                width, height, duration, fps, codec,
                                take_number, version
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            project.id, null, null,
                            file.name, file.name, filePath, relativePath,
                            mediaType, ext,
                            info.fileSize || 0,
                            info.width, info.height, info.duration, info.fps, info.codec,
                            counter || (processed + 1),
                            version
                        );

                        const assetId = result.lastInsertRowid;

                        // Generate thumbnail
                        try {
                            const thumbPath = await ThumbnailService.generate(filePath, assetId);
                            if (thumbPath) {
                                db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, assetId);
                            }
                        } catch (thumbErr) {
                            // Non-fatal: just skip thumbnail
                        }

                        processed++;
                        if (processed % 50 === 0) {
                            console.log(`[Rebuild] Progress: ${processed}/${totalFiles}`);
                        }
                    } catch (fileErr) {
                        console.error(`[Rebuild] Error processing ${file.name}: ${fileErr.message}`);
                        errors++;
                        processed++;
                    }
                }
            };

            await scanDir(projectPath, null, null);
        }

        const assetCount = db.prepare('SELECT COUNT(*) as cnt FROM assets').get().cnt;
        console.log(`[Rebuild] Complete: ${assetCount} assets in database, ${errors} errors`);

        res.json({
            success: true,
            projects: projectsCreated,
            totalFiles,
            processed,
            errors,
            assetsInDb: assetCount,
        });
    } catch (err) {
        console.error(`[Rebuild] Fatal error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
