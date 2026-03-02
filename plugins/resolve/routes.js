/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * DaVinci Resolve Plugin - routes.js
 *
 * Phase 1: Push media from CAM to DaVinci Resolve's Media Pool.
 * Phase 2: Pull media pool from Resolve, reorganize in CAM, relink back.
 * Uses scripts/resolve_bridge.py to communicate with a running Resolve instance.
 *
 * Endpoints:
 *   GET  /api/resolve/status       - Check if Resolve is running/reachable
 *   POST /api/resolve/send         - Send assets to Resolve media pool bin
 *   GET  /api/resolve/bins         - List bins in current Resolve project
 *   GET  /api/resolve/projects     - List Resolve projects
 *   GET  /api/resolve/media-pool   - Pull all clips from Resolve's media pool
 *   POST /api/resolve/import-pool  - Import Resolve media pool clips as CAM assets
 *   POST /api/resolve/reorganize   - Move linked assets into vault + return relink map
 *   POST /api/resolve/relink       - Relink clips after reorganization
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BRIDGE_SCRIPT = path.join(__dirname, 'scripts', 'resolve_bridge.py');

// ─── Core API (injected by pluginLoader) ───────────────────────────────────────
let core = null;

function init(coreAPI) {
    core = coreAPI;
}

function _getDb() {
    return core.database.getDb();
}

function _getSetting(key) {
    return core.database.getSetting(key);
}

// ─── Python Bridge Helper ─────────────────────────────────────────────────────

/**
 * Execute a resolve_bridge.py command and return parsed JSON.
 */
function executeBridge(command, params = null) {
    return new Promise((resolve, reject) => {
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

        const args = [BRIDGE_SCRIPT, command];
        if (params) {
            args.push('--json', JSON.stringify(params));
        }

        // For Resolve scripting, we need the Modules path in PYTHONPATH
        const env = { ...process.env };
        const modulesPath = _getResolveModulesPath();
        if (modulesPath) {
            env.PYTHONPATH = (env.PYTHONPATH || '') + (env.PYTHONPATH ? path.delimiter : '') + modulesPath;
        }
        const libPath = _getResolveLibPath();
        if (libPath) {
            env.RESOLVE_SCRIPT_LIB = libPath;
        }

        const proc = spawn(pythonCmd, args, {
            cwd: path.dirname(BRIDGE_SCRIPT),
            env,
            timeout: 30000,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn Python: ${err.message}. Is Python installed and in PATH?`));
        });

        proc.on('close', (code) => {
            if (code !== 0 && !stdout.trim()) {
                return reject(new Error(stderr.trim() || `Bridge exited with code ${code}`));
            }

            try {
                const lines = stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const result = JSON.parse(lastLine);
                resolve(result);
            } catch (e) {
                reject(new Error(`Failed to parse bridge output: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
            }
        });
    });
}

function _getResolveModulesPath() {
    if (process.platform === 'win32') {
        const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
        return path.join(programData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Scripting', 'Modules');
    } else if (process.platform === 'darwin') {
        return '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules';
    } else {
        return '/opt/resolve/Developer/Scripting/Modules';
    }
}

function _getResolveLibPath() {
    if (process.platform === 'win32') {
        const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
        return path.join(programFiles, 'Blackmagic Design', 'DaVinci Resolve', 'fusionscript.dll');
    } else if (process.platform === 'darwin') {
        return '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';
    } else {
        return '/opt/resolve/libs/Fusion/fusionscript.so';
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
    try {
        const result = await executeBridge('status');
        res.json(result);
    } catch (e) {
        res.json({
            success: true,
            running: false,
            message: `Cannot reach Resolve: ${e.message}`
        });
    }
});

router.post('/send', async (req, res) => {
    try {
        const { assetIds, binPath, createBins = true, autoBinByHierarchy = false } = req.body;

        if (!assetIds || !assetIds.length) {
            return res.status(400).json({ success: false, error: 'No assets specified' });
        }

        const db = _getDb();

        const placeholders = assetIds.map(() => '?').join(',');
        const assets = db.prepare(`
            SELECT a.id, a.file_path, a.original_name, a.vault_name, a.media_type,
                   p.name as project_name, p.code as project_code,
                   sq.name as sequence_name, sq.code as sequence_code,
                   sh.name as shot_name, sh.code as shot_code,
                   r.name as role_name, r.code as role_code
            FROM assets a
            LEFT JOIN projects p ON a.project_id = p.id
            LEFT JOIN sequences sq ON a.sequence_id = sq.id
            LEFT JOIN shots sh ON a.shot_id = sh.id
            LEFT JOIN roles r ON a.role_id = r.id
            WHERE a.id IN (${placeholders})
        `).all(...assetIds);

        if (!assets.length) {
            return res.status(404).json({ success: false, error: 'No matching assets found' });
        }

        const { resolveFilePath } = core.utils.pathResolver;
        const filePaths = [];
        const missingFiles = [];

        for (const asset of assets) {
            const resolved = resolveFilePath(asset.file_path);
            if (fs.existsSync(resolved)) {
                filePaths.push(resolved);
            } else {
                missingFiles.push({ id: asset.id, path: resolved, name: asset.vault_name || asset.original_name });
            }
        }

        if (!filePaths.length) {
            return res.status(400).json({
                success: false,
                error: 'None of the selected files exist on disk',
                missingFiles
            });
        }

        let targetBinPath = binPath || '';

        if (autoBinByHierarchy && assets[0]) {
            const a = assets[0];
            const parts = [];
            if (a.project_name || a.project_code) parts.push(a.project_name || a.project_code);
            if (a.sequence_name || a.sequence_code) parts.push(a.sequence_name || a.sequence_code);
            if (a.shot_name || a.shot_code) parts.push(a.shot_name || a.shot_code);
            if (parts.length) targetBinPath = parts.join('/');
        }

        const result = await executeBridge('send_to_bin', {
            files: filePaths,
            bin_path: targetBinPath,
            create_bins: createBins,
        });

        if (missingFiles.length) {
            result.warnings = {
                missingFiles,
                message: `${missingFiles.length} file(s) could not be found on disk and were skipped`
            };
        }

        res.json(result);
    } catch (e) {
        console.error('[Resolve] Send error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/bins', async (req, res) => {
    try {
        const result = await executeBridge('list_bins');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/projects', async (req, res) => {
    try {
        const result = await executeBridge('get_projects');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/media-pool', async (req, res) => {
    try {
        const result = await executeBridge('get_media_pool');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/import-pool', async (req, res) => {
    try {
        const { projectName, projectCode, clips } = req.body;

        if (!projectName || !clips || !clips.length) {
            return res.status(400).json({ success: false, error: 'projectName and clips are required' });
        }

        const db = _getDb();
        const { detectMediaType } = core.utils.mediaTypes;

        const code = projectCode || projectName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
        const existingProject = db.prepare('SELECT id FROM projects WHERE code = ?').get(code);
        let projectId;
        if (existingProject) {
            projectId = existingProject.id;
        } else {
            const result = db.prepare('INSERT INTO projects (name, code) VALUES (?, ?)').run(projectName, code);
            projectId = result.lastInsertRowid;
        }

        const imported = [];
        const errors = [];

        for (const clip of clips) {
            try {
                const filePath = clip.filePath;
                if (!filePath) {
                    errors.push({ name: clip.name, error: 'No file path' });
                    continue;
                }

                if (!fs.existsSync(filePath)) {
                    errors.push({ name: clip.name, error: 'File not found', path: filePath });
                    continue;
                }

                const existing = db.prepare('SELECT id FROM assets WHERE file_path = ?').get(filePath);
                if (existing) {
                    imported.push({ name: clip.name, id: existing.id, status: 'already_exists' });
                    continue;
                }

                const fileName = path.basename(filePath);
                const ext = path.extname(fileName).toLowerCase();
                const { type: mediaType } = detectMediaType(fileName);

                let sequenceId = null;
                let shotId = null;
                const binParts = (clip.binPath || '').split('/').filter(s => s.trim());
                const hierParts = binParts.length > 1 ? binParts.slice(1) : [];

                if (hierParts.length >= 1) {
                    const seqName = hierParts[0];
                    const seqCode = seqName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
                    let seq = db.prepare('SELECT id FROM sequences WHERE project_id = ? AND name = ?').get(projectId, seqName);
                    if (!seq) {
                        const sr = db.prepare('INSERT INTO sequences (project_id, name, code) VALUES (?, ?, ?)').run(projectId, seqName, seqCode || seqName);
                        sequenceId = sr.lastInsertRowid;
                    } else {
                        sequenceId = seq.id;
                    }

                    if (hierParts.length >= 2) {
                        const shotName = hierParts[1];
                        const shotCode = shotName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
                        let sh = db.prepare('SELECT id FROM shots WHERE sequence_id = ? AND project_id = ? AND name = ?').get(sequenceId, projectId, shotName);
                        if (!sh) {
                            const shr = db.prepare('INSERT INTO shots (sequence_id, project_id, name, code) VALUES (?, ?, ?, ?)').run(sequenceId, projectId, shotName, shotCode || shotName);
                            shotId = shr.lastInsertRowid;
                        } else {
                            shotId = sh.id;
                        }
                    }
                }

                const relativePath = fileName;
                const insertResult = db.prepare(`
                    INSERT INTO assets (project_id, sequence_id, shot_id, original_name, vault_name, file_path, relative_path, file_ext, media_type, is_linked, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
                `).run(projectId, sequenceId, shotId, fileName, fileName, filePath, relativePath, ext, mediaType);

                imported.push({
                    name: clip.name,
                    id: insertResult.lastInsertRowid,
                    status: 'registered',
                    binPath: clip.binPath
                });
            } catch (e) {
                errors.push({ name: clip.name, error: e.message });
            }
        }

        res.json({
            success: true,
            projectId,
            projectName,
            imported: imported.length,
            errors: errors.length,
            items: imported,
            errorDetails: errors.length ? errors : undefined
        });
    } catch (e) {
        console.error('[Resolve] Import pool error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/relink', async (req, res) => {
    try {
        const { relink_map } = req.body;

        if (!relink_map || !Object.keys(relink_map).length) {
            return res.status(400).json({ success: false, error: 'relink_map is required' });
        }

        const result = await executeBridge('relink_clips', { relink_map });
        res.json(result);
    } catch (e) {
        console.error('[Resolve] Relink error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/reorganize', async (req, res) => {
    try {
        const { projectId } = req.body;
        if (!projectId) {
            return res.status(400).json({ success: false, error: 'projectId is required' });
        }

        const db = _getDb();
        const FileService = core.services.FileService;
        const { generateVaultName, getVaultDirectory, generateFromConvention, getNextVersion, resolveCollision } = core.utils.naming;
        const { detectMediaType } = core.utils.mediaTypes;

        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        if (!project) {
            return res.status(404).json({ success: false, error: 'Project not found' });
        }

        const vaultRoot = _getSetting('vault_root');
        if (!vaultRoot) {
            return res.status(400).json({ success: false, error: 'Vault root not configured. Go to Settings.' });
        }

        let namingConvention = null;
        if (project.naming_convention) {
            try {
                namingConvention = JSON.parse(project.naming_convention);
            } catch { /* ignore */ }
        }

        const linkedAssets = db.prepare(
            'SELECT a.*, s.name as seq_name, s.code as seq_code, sh.name as shot_name, sh.code as shot_code, r.name as role_name, r.code as role_code ' +
            'FROM assets a ' +
            'LEFT JOIN sequences s ON a.sequence_id = s.id ' +
            'LEFT JOIN shots sh ON a.shot_id = sh.id ' +
            'LEFT JOIN roles r ON a.role_id = r.id ' +
            'WHERE a.project_id = ? AND a.is_linked = 1'
        ).all(projectId);

        if (!linkedAssets.length) {
            return res.json({ success: true, moved: 0, errors: 0, relinkMap: {} });
        }

        const relinkMap = {};
        let moved = 0;
        const errors = [];

        const versionTracker = {};

        for (const asset of linkedAssets) {
            try {
                const oldPath = asset.file_path;
                if (!oldPath || !fs.existsSync(oldPath)) {
                    errors.push({ id: asset.id, name: asset.original_name, error: 'File not found' });
                    continue;
                }

                const originalName = asset.original_name || path.basename(oldPath);
                const { type: mediaType } = detectMediaType(originalName);

                const vaultDir = getVaultDirectory(
                    vaultRoot, project.code, mediaType,
                    asset.seq_code, asset.shot_code
                );

                const vKey = `${asset.seq_code || ''}__${asset.role_code || ''}__${mediaType}`;
                if (!(vKey in versionTracker)) {
                    const seqOrProj = asset.seq_name || asset.seq_code || project.code;
                    const roleLC = (asset.role_code || '').toLowerCase();
                    const basePattern = roleLC ? `${seqOrProj}_${roleLC}_v` : '';
                    versionTracker[vKey] = getNextVersion(vaultDir, basePattern);
                }
                const autoVersion = versionTracker[vKey]++;

                let vaultName;
                if (namingConvention && namingConvention.length > 0) {
                    const convResult = generateFromConvention(namingConvention, {
                        project: project.code,
                        episode: project.episode,
                        sequence: asset.seq_name || asset.seq_code,
                        shot: asset.shot_name || asset.shot_code,
                        role: asset.role_code,
                        version: autoVersion,
                        take: 1,
                        counter: moved + 1,
                    }, path.extname(originalName));

                    if (convResult) {
                        vaultName = convResult.vaultName;
                    }
                }

                if (!vaultName) {
                    const nameResult = generateVaultName({
                        originalName,
                        projectCode: project.code,
                        sequenceCode: asset.seq_code,
                        shotCode: asset.shot_code,
                        roleCode: asset.role_code,
                        takeNumber: 1,
                        version: autoVersion,
                        mediaType,
                        counter: moved + 1,
                    });
                    vaultName = nameResult.vaultName;
                }

                FileService.ensureDir(vaultDir);

                let destPath = path.join(vaultDir, vaultName);

                if (fs.existsSync(destPath)) {
                    const resolved = resolveCollision(vaultDir, vaultName);
                    destPath = path.join(vaultDir, resolved);
                    vaultName = resolved;
                }

                fs.copyFileSync(oldPath, destPath);

                const relativePath = path.relative(vaultRoot, destPath);
                const finalVaultName = path.basename(destPath);

                db.prepare(
                    'UPDATE assets SET file_path = ?, vault_name = ?, relative_path = ?, is_linked = 0 WHERE id = ?'
                ).run(destPath, finalVaultName, relativePath, asset.id);

                relinkMap[oldPath] = destPath;
                moved++;

            } catch (e) {
                errors.push({ id: asset.id, name: asset.original_name, error: e.message });
            }
        }

        res.json({
            success: true,
            moved,
            errors: errors.length,
            errorDetails: errors.length ? errors : undefined,
            relinkMap
        });

    } catch (e) {
        console.error('[Resolve] Reorganize error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.init = init;
