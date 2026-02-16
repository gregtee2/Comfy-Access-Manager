/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Settings Routes
 * App configuration, watch folders, and system info
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getAllSettings, setSetting, getSetting, getRecentActivity, getDb, DB_PATH, DATA_DIR, closeDb, initDb, loadConfig, saveConfig, resolveDbPath, reloadFromDisk } = require('../database');
const multer = require('multer');
const http = require('http');
const https = require('https');
const WatcherService = require('../services/WatcherService');
const FileService = require('../services/FileService');
const MediaInfoService = require('../services/MediaInfoService');
const ThumbnailService = require('../services/ThumbnailService');
const RVPluginSync = require('../services/RVPluginSync');
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
//  SHARED DATABASE CONFIG
// ═══════════════════════════════════════════

// GET /api/settings/db-config — Current shared DB configuration
router.get('/db-config', (req, res) => {
    const config = loadConfig();
    const os = require('os');
    const resolved = resolveDbPath();
    const isShared = config.shared_db_path && resolved !== path.join(DATA_DIR, 'mediavault.db');
    let sharedAccessible = false;
    if (config.shared_db_path) {
        try { sharedAccessible = fs.existsSync(config.shared_db_path); } catch (_) {}
    }
    res.json({
        shared_db_path: config.shared_db_path || '',
        active_db_path: resolved,
        is_shared: isShared,
        shared_accessible: sharedAccessible,
        hostname: os.hostname(),
    });
});

// POST /api/settings/db-config — Set shared DB path (requires restart)
router.post('/db-config', (req, res) => {
    const { shared_db_path } = req.body;
    const config = loadConfig();

    if (!shared_db_path) {
        // Clear shared path — revert to local DB
        delete config.shared_db_path;
        saveConfig(config);
        return res.json({ success: true, message: 'Reverted to local database', restart_required: true });
    }

    // Validate the path exists or can be created
    try {
        if (!fs.existsSync(shared_db_path)) {
            fs.mkdirSync(shared_db_path, { recursive: true });
        }
    } catch (e) {
        return res.status(400).json({ error: `Cannot access or create folder: ${e.message}` });
    }

    config.shared_db_path = shared_db_path;
    saveConfig(config);

    res.json({ success: true, message: 'Shared database path saved', restart_required: true });
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

// POST /api/settings/sync-rv-plugin — Force re-deploy MediaVault plugin to all RV installations
router.post('/sync-rv-plugin', (req, res) => {
    try {
        RVPluginSync.sync();
        const targets = RVPluginSync.findRVInstalls();
        res.json({
            success: true,
            message: `Plugin synced to ${targets.length} target(s)`,
            targets,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════
//  DATABASE EXPORT / IMPORT / PULL
// ═══════════════════════════════════════════

// GET /api/settings/export-db — Download the database file
router.get('/export-db', (req, res) => {
    try {
        if (!fs.existsSync(DB_PATH)) {
            return res.status(404).json({ error: 'No database file found' });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Disposition', `attachment; filename="mediavault-${timestamp}.db"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        const stream = fs.createReadStream(DB_PATH);
        stream.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/settings/db-info — Quick stats about the current database
router.get('/db-info', (req, res) => {
    try {
        const db = getDb();
        const projects = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
        const assets = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
        const sequences = db.prepare('SELECT COUNT(*) as c FROM sequences').get().c;
        const shots = db.prepare('SELECT COUNT(*) as c FROM shots').get().c;
        const stat = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
        res.json({
            projects, assets, sequences, shots,
            fileSize: stat ? stat.size : 0,
            modified: stat ? stat.mtime.toISOString() : null,
            path: DB_PATH,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/settings/import-db — Upload and replace the database file
const dbUpload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 500 * 1024 * 1024 } });
router.post('/import-db', dbUpload.single('database'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No database file uploaded' });
    }
    const uploadedPath = req.file.path;
    try {
        // Back up current database
        if (fs.existsSync(DB_PATH)) {
            const backupPath = DB_PATH + '.backup-' + Date.now();
            fs.copyFileSync(DB_PATH, backupPath);
            console.log(`[DB Import] Backed up current DB to ${backupPath}`);
        }

        // Close current database, replace file, re-init
        closeDb();
        fs.copyFileSync(uploadedPath, DB_PATH);
        fs.unlinkSync(uploadedPath);
        await initDb();

        const db = getDb();
        const projects = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
        const assets = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;

        console.log(`[DB Import] Imported database with ${projects} projects, ${assets} assets`);
        res.json({
            success: true,
            message: `Database imported: ${projects} projects, ${assets} assets`,
            projects, assets,
        });
    } catch (err) {
        // Try to recover from backup
        try {
            const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('mediavault.db.backup-')).sort().reverse();
            if (backups.length > 0) {
                fs.copyFileSync(path.join(DATA_DIR, backups[0]), DB_PATH);
                await initDb();
                console.log('[DB Import] Recovered from backup after failed import');
            }
        } catch (recoverErr) {
            console.error('[DB Import] Recovery failed:', recoverErr.message);
        }
        if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
        res.status(500).json({ error: `Import failed: ${err.message}` });
    }
});

// POST /api/settings/pull-db — Pull database from a remote MediaVault instance
router.post('/pull-db', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'Remote server URL is required' });
    }

    try {
        // Normalize URL — ensure it ends with /api/settings/export-db
        let remoteUrl = url.replace(/\/+$/, '');
        if (!remoteUrl.includes('/api/settings/export-db')) {
            remoteUrl += '/api/settings/export-db';
        }

        console.log(`[DB Pull] Pulling database from ${remoteUrl}`);

        // Download the remote database
        const tmpPath = path.join(DATA_DIR, 'pull-tmp-' + Date.now() + '.db');
        await new Promise((resolve, reject) => {
            const proto = remoteUrl.startsWith('https') ? https : http;
            const request = proto.get(remoteUrl, { timeout: 30000 }, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Remote server returned ${response.statusCode}`));
                    return;
                }
                const file = fs.createWriteStream(tmpPath);
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', reject);
            });
            request.on('error', (err) => reject(new Error(`Connection failed: ${err.message}`)));
            request.on('timeout', () => { request.destroy(); reject(new Error('Connection timed out')); });
        });

        // Validate it's a real SQLite file
        const header = Buffer.alloc(16);
        const fd = fs.openSync(tmpPath, 'r');
        fs.readSync(fd, header, 0, 16, 0);
        fs.closeSync(fd);
        if (header.toString('ascii', 0, 6) !== 'SQLite') {
            fs.unlinkSync(tmpPath);
            return res.status(400).json({ error: 'Downloaded file is not a valid SQLite database' });
        }

        // Backup current, replace, re-init
        if (fs.existsSync(DB_PATH)) {
            const backupPath = DB_PATH + '.backup-' + Date.now();
            fs.copyFileSync(DB_PATH, backupPath);
            console.log(`[DB Pull] Backed up current DB to ${backupPath}`);
        }

        closeDb();
        fs.renameSync(tmpPath, DB_PATH);
        await initDb();

        const db = getDb();
        const projects = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
        const assets = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;

        console.log(`[DB Pull] Imported remote database with ${projects} projects, ${assets} assets`);
        res.json({
            success: true,
            message: `Database pulled: ${projects} projects, ${assets} assets`,
            projects, assets,
        });
    } catch (err) {
        // Try to recover
        try {
            const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('mediavault.db.backup-')).sort().reverse();
            if (backups.length > 0 && !getDb()) {
                fs.copyFileSync(path.join(DATA_DIR, backups[0]), DB_PATH);
                await initDb();
            }
        } catch (_) {}
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GITHUB TOKEN (for private repo auto-updates)
// ═══════════════════════════════════════════════════════════════════

// GET /api/settings/github-token — Check if a PAT is configured (does NOT return token)
router.get('/github-token', (req, res) => {
    const config = loadConfig();
    const token = config.github_pat || '';
    res.json({
        configured: !!token,
        masked: token ? `${token.slice(0, 8)}${'•'.repeat(Math.max(0, token.length - 12))}${token.slice(-4)}` : ''
    });
});

// POST /api/settings/github-token — Save a GitHub PAT to config.json
router.post('/github-token', (req, res) => {
    const { token } = req.body;
    const config = loadConfig();

    if (!token || !token.trim()) {
        delete config.github_pat;
        saveConfig(config);
        return res.json({ success: true, configured: false, message: 'GitHub token removed.' });
    }

    config.github_pat = token.trim();
    saveConfig(config);

    res.json({
        success: true,
        configured: true,
        masked: `${token.slice(0, 8)}${'•'.repeat(Math.max(0, token.length - 12))}${token.slice(-4)}`,
        message: 'GitHub token saved. Update checks will now authenticate.'
    });
});

module.exports = router;
