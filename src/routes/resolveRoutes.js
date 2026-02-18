/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * resolveRoutes.js - DaVinci Resolve Integration API
 *
 * Phase 1: Push media from CAM to DaVinci Resolve's Media Pool.
 * Uses scripts/resolve_bridge.py to communicate with a running Resolve instance.
 *
 * Endpoints:
 *   GET  /api/resolve/status       - Check if Resolve is running/reachable
 *   POST /api/resolve/send         - Send assets to Resolve media pool bin
 *   GET  /api/resolve/bins         - List bins in current Resolve project
 *   GET  /api/resolve/projects     - List Resolve projects
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const { getDb, getSetting } = require('../database');

const BRIDGE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'resolve_bridge.py');

// ─── Python Bridge Helper ─────────────────────────────────────────────────────

/**
 * Execute a resolve_bridge.py command and return parsed JSON.
 * @param {string} command - Bridge command (status, send_to_bin, list_bins, get_projects)
 * @param {object} [params] - Optional JSON params
 * @returns {Promise<object>} - Parsed JSON result
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
            timeout: 30000, // 30 second timeout
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
                // Parse last JSON line from stdout (earlier lines may be debug output)
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

/**
 * Get the path to DaVinci Resolve's Scripting/Modules directory.
 */
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

/**
 * Get the path to DaVinci Resolve's fusionscript library.
 */
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

/**
 * GET /api/resolve/status
 * Check if DaVinci Resolve is running and reachable via scripting API.
 */
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

/**
 * POST /api/resolve/send
 * Send assets from CAM to DaVinci Resolve's media pool.
 *
 * Body:
 *   assetIds: number[]       - Array of asset IDs to send
 *   binPath: string          - Target bin path in Resolve (e.g. "ProjectName/Comp")
 *   createBins: boolean      - Whether to create missing bins (default true)
 *   autoBinByHierarchy: bool - Auto-build bin path from CAM project/seq/shot hierarchy
 */
router.post('/send', async (req, res) => {
    try {
        const { assetIds, binPath, createBins = true, autoBinByHierarchy = false } = req.body;

        if (!assetIds || !assetIds.length) {
            return res.status(400).json({ success: false, error: 'No assets specified' });
        }

        const db = getDb();

        // Resolve file paths for all assets
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

        // Resolve file paths (apply path mappings for cross-platform)
        const { resolveFilePath } = require('../utils/pathResolver');
        const filePaths = [];
        const missingFiles = [];

        for (const asset of assets) {
            const resolved = resolveFilePath(asset.file_path);
            const fs = require('fs');
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

        // Determine bin path
        let targetBinPath = binPath || '';

        if (autoBinByHierarchy && assets[0]) {
            // Auto-build: Project / Sequence / Shot (use names, fallback to codes)
            const a = assets[0];
            const parts = [];
            if (a.project_name || a.project_code) parts.push(a.project_name || a.project_code);
            if (a.sequence_name || a.sequence_code) parts.push(a.sequence_name || a.sequence_code);
            if (a.shot_name || a.shot_code) parts.push(a.shot_name || a.shot_code);
            if (parts.length) targetBinPath = parts.join('/');
        }

        // Call bridge to send files to Resolve
        const result = await executeBridge('send_to_bin', {
            files: filePaths,
            bin_path: targetBinPath,
            create_bins: createBins,
        });

        // Include any warnings about missing files
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

/**
 * GET /api/resolve/bins
 * List all bins (folders) in the current Resolve project's media pool.
 */
router.get('/bins', async (req, res) => {
    try {
        const result = await executeBridge('list_bins');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/resolve/projects
 * List all projects in Resolve's current database.
 */
router.get('/projects', async (req, res) => {
    try {
        const result = await executeBridge('get_projects');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
