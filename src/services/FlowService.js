/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * FlowService - Bridge between MediaVault (Node.js) and Flow Production Tracking (Python)
 * 
 * Spawns the Python flow_bridge.py script and parses JSON output.
 * Handles sync operations: Projects, Sequences, Shots, Pipeline Steps → Roles
 * And publish operations: MediaVault assets → Flow Versions
 */

const { spawn } = require('child_process');
const path = require('path');
const { getSetting, getDb } = require('../database');

const BRIDGE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'flow_bridge.py');

class FlowService {

    /**
     * Get Flow connection credentials from settings.
     */
    static getCredentials() {
        return {
            site: getSetting('flow_site_url') || '',
            scriptName: getSetting('flow_script_name') || '',
            apiKey: getSetting('flow_api_key') || '',
        };
    }

    /**
     * Check if Flow is configured (all 3 credentials present).
     */
    static isConfigured() {
        const { site, scriptName, apiKey } = this.getCredentials();
        return !!(site && scriptName && apiKey);
    }

    /**
     * Execute a Python bridge command and return parsed JSON.
     * @param {string} command - Command name (test_connection, sync_projects, etc.)
     * @param {object} [params] - Optional JSON params for the command
     * @returns {Promise<object>} - Parsed JSON result
     */
    static async execute(command, params = null) {
        const { site, scriptName, apiKey } = this.getCredentials();

        if (!site || !scriptName || !apiKey) {
            throw new Error('Flow not configured. Set site URL, script name, and API key in Settings.');
        }

        const args = [
            BRIDGE_SCRIPT,
            command,
            '--site', site,
            '--script-name', scriptName,
            '--api-key', apiKey,
        ];

        if (params) {
            args.push('--json', JSON.stringify(params));
        }

        return new Promise((resolve, reject) => {
            // Use system Python (shotgun_api3 should be installed there)
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            const proc = spawn(pythonCmd, args, {
                cwd: path.dirname(BRIDGE_SCRIPT),
                env: { ...process.env },
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code !== 0 && !stdout.trim()) {
                    return reject(new Error(stderr.trim() || `Bridge exited with code ${code}`));
                }

                try {
                    // Parse last line of stdout (may have debug output before it)
                    const lines = stdout.trim().split('\n');
                    const lastLine = lines[lines.length - 1];
                    const result = JSON.parse(lastLine);

                    if (!result.success) {
                        return reject(new Error(result.error || 'Unknown bridge error'));
                    }

                    resolve(result);
                } catch (e) {
                    reject(new Error(`Failed to parse bridge output: ${e.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
                }
            });

            proc.on('error', (err) => {
                reject(new Error(`Failed to spawn Python bridge: ${err.message}. Is Python installed?`));
            });
        });
    }

    // ─── High-Level Sync Operations ───────────────────────

    /**
     * Test the Flow connection.
     */
    static async testConnection() {
        return this.execute('test_connection');
    }

    /**
     * Sync projects from Flow → MediaVault.
     * Creates new projects or updates existing ones (matched by flow_id).
     * @returns {{ created: number, updated: number, projects: array }}
     */
    static async syncProjects() {
        const result = await this.execute('sync_projects');
        const db = getDb();
        let created = 0, updated = 0;

        for (const proj of result.projects) {
            // Check if project with this flow_id already exists
            const existing = db.prepare(
                'SELECT id FROM projects WHERE flow_id = ?'
            ).get(proj.flow_id);

            if (existing) {
                db.prepare(
                    'UPDATE projects SET name = ?, description = ?, updated_at = datetime("now") WHERE flow_id = ?'
                ).run(proj.name, proj.description, proj.flow_id);
                updated++;
            } else {
                // Check if project with same code exists (link it)
                const byCode = db.prepare(
                    'SELECT id FROM projects WHERE code = ?'
                ).get(proj.code);

                if (byCode) {
                    db.prepare(
                        'UPDATE projects SET flow_id = ?, description = ?, updated_at = datetime("now") WHERE id = ?'
                    ).run(proj.flow_id, proj.description, byCode.id);
                    updated++;
                } else {
                    db.prepare(
                        'INSERT INTO projects (name, code, type, description, flow_id) VALUES (?, ?, ?, ?, ?)'
                    ).run(proj.name, proj.code, 'vfx', proj.description, proj.flow_id);
                    created++;
                }
            }
        }

        return { success: true, created, updated, total: result.count };
    }

    /**
     * Sync sequences from Flow → MediaVault for a specific project.
     * @param {number} flowProjectId - Flow project ID
     * @param {number} localProjectId - Local MediaVault project ID
     */
    static async syncSequences(flowProjectId, localProjectId) {
        const result = await this.execute('sync_sequences', { project_id: flowProjectId });
        const db = getDb();
        let created = 0, updated = 0;

        for (const seq of result.sequences) {
            const existing = db.prepare(
                'SELECT id FROM sequences WHERE flow_id = ? AND project_id = ?'
            ).get(seq.flow_id, localProjectId);

            if (existing) {
                db.prepare(
                    'UPDATE sequences SET name = ?, code = ?, description = ? WHERE id = ?'
                ).run(seq.name, seq.code, seq.description, existing.id);
                updated++;
            } else {
                const byCode = db.prepare(
                    'SELECT id FROM sequences WHERE code = ? AND project_id = ?'
                ).get(seq.code, localProjectId);

                if (byCode) {
                    db.prepare(
                        'UPDATE sequences SET flow_id = ?, description = ? WHERE id = ?'
                    ).run(seq.flow_id, seq.description, byCode.id);
                    updated++;
                } else {
                    db.prepare(
                        'INSERT INTO sequences (project_id, name, code, description, flow_id) VALUES (?, ?, ?, ?, ?)'
                    ).run(localProjectId, seq.name, seq.code, seq.description, seq.flow_id);
                    created++;
                }
            }
        }

        return { success: true, created, updated, total: result.count };
    }

    /**
     * Sync shots from Flow → MediaVault for a specific project.
     * @param {number} flowProjectId - Flow project ID
     * @param {number} localProjectId - Local MediaVault project ID
     */
    static async syncShots(flowProjectId, localProjectId) {
        const result = await this.execute('sync_shots', { project_id: flowProjectId });
        const db = getDb();
        let created = 0, updated = 0;

        for (const shot of result.shots) {
            // Resolve local sequence_id from flow_id
            let localSeqId = null;
            if (shot.sequence_flow_id) {
                const seq = db.prepare(
                    'SELECT id FROM sequences WHERE flow_id = ? AND project_id = ?'
                ).get(shot.sequence_flow_id, localProjectId);
                localSeqId = seq ? seq.id : null;
            }

            const existing = db.prepare(
                'SELECT id FROM shots WHERE flow_id = ? AND project_id = ?'
            ).get(shot.flow_id, localProjectId);

            if (existing) {
                db.prepare(
                    'UPDATE shots SET name = ?, code = ?, description = ?, sequence_id = ? WHERE id = ?'
                ).run(shot.name, shot.code, shot.description, localSeqId, existing.id);
                updated++;
            } else {
                const byCode = db.prepare(
                    'SELECT id FROM shots WHERE code = ? AND project_id = ?'
                ).get(shot.code, localProjectId);

                if (byCode) {
                    db.prepare(
                        'UPDATE shots SET flow_id = ?, description = ?, sequence_id = ? WHERE id = ?'
                    ).run(shot.flow_id, shot.description, localSeqId, byCode.id);
                    updated++;
                } else {
                    if (!localSeqId) {
                        // Can't create shot without a sequence - skip
                        continue;
                    }
                    db.prepare(
                        'INSERT INTO shots (project_id, sequence_id, name, code, description, flow_id) VALUES (?, ?, ?, ?, ?, ?)'
                    ).run(localProjectId, localSeqId, shot.name, shot.code, shot.description, shot.flow_id);
                    created++;
                }
            }
        }

        return { success: true, created, updated, total: result.count };
    }

    /**
     * Sync pipeline steps from Flow → MediaVault roles.
     * Pipeline Steps in Flow map to Roles in MediaVault.
     */
    static async syncSteps() {
        const result = await this.execute('sync_steps');
        const db = getDb();
        let created = 0, updated = 0;

        // Default icons for common step names
        const STEP_ICONS = {
            'comp': '🎨', 'compositing': '🎨',
            'light': '💡', 'lighting': '💡', 'lgt': '💡',
            'anim': '🏃', 'animation': '🏃',
            'fx': '✨', 'effects': '✨', 'cfx': '✨',
            'layout': '📐', 'lo': '📐',
            'matchmove': '📍', 'mm': '📍', 'tracking': '📍',
            'roto': '✂️', 'rotoscope': '✂️',
            'model': '🧊', 'modeling': '🧊', 'mdl': '🧊',
            'texture': '🖌️', 'texturing': '🖌️', 'tex': '🖌️',
            'rig': '🦴', 'rigging': '🦴',
            'lookdev': '👁️', 'look': '👁️',
            'previz': '📽️', 'previs': '📽️',
        };

        for (const step of result.steps) {
            const codeLower = (step.code || step.name || '').toLowerCase();
            const icon = STEP_ICONS[codeLower] || '🎭';

            const existing = db.prepare(
                'SELECT id FROM roles WHERE flow_id = ?'
            ).get(step.flow_id);

            if (existing) {
                db.prepare(
                    'UPDATE roles SET name = ?, color = ?, sort_order = ? WHERE id = ?'
                ).run(step.name, step.color, step.sort_order, existing.id);
                updated++;
            } else {
                // Check if role with same code already exists
                const byCode = db.prepare(
                    'SELECT id FROM roles WHERE code = ?'
                ).get(step.code.toUpperCase());

                if (byCode) {
                    db.prepare(
                        'UPDATE roles SET flow_id = ?, color = ?, sort_order = ? WHERE id = ?'
                    ).run(step.flow_id, step.color, step.sort_order, byCode.id);
                    updated++;
                } else {
                    db.prepare(
                        'INSERT INTO roles (name, code, color, icon, sort_order, flow_id) VALUES (?, ?, ?, ?, ?, ?)'
                    ).run(step.name, step.code.toUpperCase(), step.color, icon, step.sort_order, step.flow_id);
                    created++;
                }
            }
        }

        return { success: true, created, updated, total: result.count };
    }

    /**
     * Publish a MediaVault asset as a Version in Flow.
     * @param {object} params - { assetId, flowProjectId, flowShotId, code, description }
     */
    static async publishVersion(params) {
        const db = getDb();
        
        // Get asset info
        const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(params.assetId);
        if (!asset) throw new Error(`Asset ${params.assetId} not found`);

        const publishParams = {
            project_id: params.flowProjectId,
            code: params.code || asset.vault_name,
            description: params.description || `Published from Digital Media Vault`,
            path_to_frames: asset.file_path,
            status: params.status || 'rev',
        };

        if (params.flowShotId) {
            publishParams.shot_id = params.flowShotId;
        }

        const result = await this.execute('publish_version', publishParams);

        // Store flow_version_id on the asset for tracking
        if (result.version && result.version.flow_id) {
            db.prepare(
                'UPDATE assets SET metadata = json_set(COALESCE(metadata, "{}"), "$.flow_version_id", ?) WHERE id = ?'
            ).run(result.version.flow_id, params.assetId);
        }

        return result;
    }

    /**
     * Upload a thumbnail from MediaVault to a Flow Version.
     */
    static async uploadThumbnail(flowVersionId, thumbnailPath) {
        return this.execute('upload_thumbnail', {
            version_id: flowVersionId,
            path: thumbnailPath,
        });
    }

    /**
     * Full sync: Projects → Sequences → Shots → Steps for a specific project.
     */
    static async fullSync(flowProjectId, localProjectId) {
        const results = {
            steps: await this.syncSteps(),
            sequences: await this.syncSequences(flowProjectId, localProjectId),
        };
        // Shots depend on sequences being synced first
        results.shots = await this.syncShots(flowProjectId, localProjectId);
        
        return {
            success: true,
            steps: results.steps,
            sequences: results.sequences,
            shots: results.shots,
        };
    }

    /**
     * Get mapping of local projects to Flow projects.
     */
    static getProjectMappings() {
        const db = getDb();
        return db.prepare(
            'SELECT id, name, code, flow_id FROM projects WHERE flow_id IS NOT NULL'
        ).all();
    }
}

module.exports = FlowService;
