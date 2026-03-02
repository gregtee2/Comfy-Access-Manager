/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * FlowService — Bridge between CAM (Node.js) and Flow Production Tracking (Python)
 *
 * Spawns the Python flow_bridge.py script and parses JSON output.
 * Handles sync operations: Projects, Sequences, Shots, Pipeline Steps → Roles
 * And publish operations: CAM assets → Flow Versions
 */

const { spawn } = require('child_process');
const path = require('path');

const BRIDGE_SCRIPT = path.join(__dirname, '..', 'scripts', 'flow_bridge.py');

// Injected database module (set by routes.js init)
let _db = null;

class FlowService {

    /**
     * Set the database module (dependency injection from plugin loader).
     * @param {object} database - The core database module (with getDb, getSetting, etc.)
     */
    static setDatabase(database) {
        _db = database;
    }

    /** @returns {object} The database wrapper */
    static _getDb() {
        if (!_db) throw new Error('FlowService: database not initialized (call setDatabase first)');
        return _db.getDb();
    }

    /** @returns {string|null} A setting value */
    static _getSetting(key) {
        if (!_db) throw new Error('FlowService: database not initialized');
        return _db.getSetting(key);
    }

    /**
     * Get Flow connection credentials from settings.
     */
    static getCredentials() {
        return {
            site: this._getSetting('flow_site_url') || '',
            scriptName: this._getSetting('flow_script_name') || '',
            apiKey: this._getSetting('flow_api_key') || '',
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

    // ─── High-Level Sync Operations ───

    static async testConnection() {
        return this.execute('test_connection');
    }

    static async syncProjects() {
        const result = await this.execute('sync_projects');
        const db = this._getDb();
        let created = 0, updated = 0;

        for (const proj of result.projects) {
            const existing = db.prepare(
                'SELECT id FROM projects WHERE flow_id = ?'
            ).get(proj.flow_id);

            if (existing) {
                db.prepare(
                    'UPDATE projects SET name = ?, description = ?, updated_at = datetime("now") WHERE flow_id = ?'
                ).run(proj.name, proj.description, proj.flow_id);
                updated++;
            } else {
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

    static async syncSequences(flowProjectId, localProjectId) {
        const result = await this.execute('sync_sequences', { project_id: flowProjectId });
        const db = this._getDb();
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

    static async syncShots(flowProjectId, localProjectId) {
        const result = await this.execute('sync_shots', { project_id: flowProjectId });
        const db = this._getDb();
        let created = 0, updated = 0;

        for (const shot of result.shots) {
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
                    if (!localSeqId) continue;
                    db.prepare(
                        'INSERT INTO shots (project_id, sequence_id, name, code, description, flow_id) VALUES (?, ?, ?, ?, ?, ?)'
                    ).run(localProjectId, localSeqId, shot.name, shot.code, shot.description, shot.flow_id);
                    created++;
                }
            }
        }

        return { success: true, created, updated, total: result.count };
    }

    static async syncSteps() {
        const result = await this.execute('sync_steps');
        const db = this._getDb();
        let created = 0, updated = 0;

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

    static async publishVersion(params) {
        const db = this._getDb();

        const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(params.assetId);
        if (!asset) throw new Error(`Asset ${params.assetId} not found`);

        const publishParams = {
            project_id: params.flowProjectId,
            code: params.code || asset.vault_name,
            description: params.description || 'Published from Comfy Asset Manager',
            path_to_frames: asset.file_path,
            status: params.status || 'rev',
        };

        if (params.flowShotId) {
            publishParams.shot_id = params.flowShotId;
        }

        if (params.flowTaskId) {
            publishParams.task_id = params.flowTaskId;
        }

        // Include movie path for review media
        if (params.moviePath) {
            publishParams.path_to_movie = params.moviePath;
        }

        const result = await this.execute('publish_version', publishParams);

        if (result.version && result.version.flow_id) {
            db.prepare(
                'UPDATE assets SET metadata = json_set(COALESCE(metadata, "{}"), "$.flow_version_id", ?) WHERE id = ?'
            ).run(result.version.flow_id, params.assetId);

            // Auto-upload thumbnail if asset has one
            if (params.uploadThumbnail !== false) {
                try {
                    const thumbPath = asset.thumbnail_path || asset.file_path;
                    if (thumbPath) {
                        await this.uploadThumbnail(result.version.flow_id, thumbPath);
                    }
                } catch (thumbErr) {
                    console.warn(`[Flow] Auto-thumbnail upload failed: ${thumbErr.message}`);
                }
            }

            // Auto-upload media for Screening Room if a movie file exists
            if (params.uploadMedia && params.moviePath) {
                try {
                    await this.uploadMedia(result.version.flow_id, params.moviePath);
                } catch (mediaErr) {
                    console.warn(`[Flow] Media upload failed: ${mediaErr.message}`);
                }
            }

            // Update linked task status to 'rev' (pending review) if specified
            if (params.flowTaskId && params.updateTaskStatus !== false) {
                try {
                    await this.updateTaskStatus(params.flowTaskId, params.taskStatus || 'rev');
                } catch (taskErr) {
                    console.warn(`[Flow] Task status update failed: ${taskErr.message}`);
                }
            }
        }

        return result;
    }

    /**
     * Create a Note in Flow with an optional image attachment.
     * Used for exporting annotated review frames to ShotGrid.
     */
    static async createNote(params) {
        const noteParams = {
            project_id: params.flowProjectId,
            subject: params.subject,
            body: params.body || '',
        };

        if (params.flowShotId) noteParams.shot_id = params.flowShotId;
        if (params.flowVersionId) noteParams.version_id = params.flowVersionId;
        if (params.addresseeIds) noteParams.addressee_ids = params.addresseeIds;
        if (params.attachmentPath) noteParams.attachment_path = params.attachmentPath;

        const result = await this.execute('create_note', noteParams);

        // Store the flow_note_id back on the review_note if provided
        if (result.note && result.note.flow_id && params.reviewNoteId) {
            const db = this._getDb();
            try {
                db.prepare(
                    `UPDATE review_notes SET flow_note_id = ? WHERE id = ?`
                ).run(result.note.flow_id, params.reviewNoteId);
            } catch { /* column may not exist yet — migration will add it */ }
        }

        return result;
    }

    static async uploadThumbnail(flowVersionId, thumbnailPath) {
        return this.execute('upload_thumbnail', {
            version_id: flowVersionId,
            path: thumbnailPath,
        });
    }

    static async uploadMedia(flowVersionId, mediaPath, field = 'sg_uploaded_movie') {
        return this.execute('upload_media', {
            version_id: flowVersionId,
            path: mediaPath,
            field,
        });
    }

    static async updateTaskStatus(flowTaskId, status) {
        return this.execute('update_task_status', {
            task_id: flowTaskId,
            status,
        });
    }

    static async syncTasks(flowProjectId, localProjectId) {
        const result = await this.execute('sync_tasks', { project_id: flowProjectId });
        const db = this._getDb();
        let created = 0, updated = 0;

        for (const task of result.tasks) {
            const existing = db.prepare(
                'SELECT id FROM flow_tasks WHERE flow_id = ?'
            ).get(task.flow_id);

            const assigneesJson = JSON.stringify(task.assignees || []);

            if (existing) {
                db.prepare(`
                    UPDATE flow_tasks SET
                        content = ?, status = ?, description = ?,
                        step_flow_id = ?, step_name = ?,
                        entity_type = ?, entity_flow_id = ?, entity_name = ?,
                        assignees = ?, start_date = ?, due_date = ?,
                        est_minutes = ?, logged_minutes = ?,
                        updated_at = datetime('now')
                    WHERE id = ?
                `).run(
                    task.content, task.status, task.description,
                    task.step_id, task.step_name,
                    task.entity_type, task.entity_id, task.entity_name,
                    assigneesJson, task.start_date, task.due_date,
                    task.est_minutes, task.logged_minutes,
                    existing.id
                );
                updated++;
            } else {
                db.prepare(`
                    INSERT INTO flow_tasks (
                        flow_id, project_id, content, status, description,
                        step_flow_id, step_name, entity_type, entity_flow_id,
                        entity_name, assignees, start_date, due_date,
                        est_minutes, logged_minutes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    task.flow_id, localProjectId, task.content, task.status,
                    task.description, task.step_id, task.step_name,
                    task.entity_type, task.entity_id, task.entity_name,
                    assigneesJson, task.start_date, task.due_date,
                    task.est_minutes, task.logged_minutes
                );
                created++;
            }
        }

        return { success: true, created, updated, total: result.count };
    }

    static async fullSync(flowProjectId, localProjectId) {
        const results = {
            steps: await this.syncSteps(),
            sequences: await this.syncSequences(flowProjectId, localProjectId),
        };
        results.shots = await this.syncShots(flowProjectId, localProjectId);
        results.tasks = await this.syncTasks(flowProjectId, localProjectId);

        return {
            success: true,
            steps: results.steps,
            sequences: results.sequences,
            shots: results.shots,
            tasks: results.tasks,
        };
    }

    static getProjectMappings() {
        const db = this._getDb();
        return db.prepare(
            'SELECT id, name, code, flow_id FROM projects WHERE flow_id IS NOT NULL'
        ).all();
    }

    /**
     * Get tasks for a project, optionally filtered by entity (shot/asset).
     */
    static getTasks(localProjectId, opts = {}) {
        const db = this._getDb();
        let sql = 'SELECT * FROM flow_tasks WHERE project_id = ?';
        const params = [localProjectId];

        if (opts.entityType) {
            sql += ' AND entity_type = ?';
            params.push(opts.entityType);
        }
        if (opts.entityFlowId) {
            sql += ' AND entity_flow_id = ?';
            params.push(opts.entityFlowId);
        }
        if (opts.status) {
            sql += ' AND status = ?';
            params.push(opts.status);
        }

        sql += ' ORDER BY step_name, content';

        const tasks = db.prepare(sql).all(...params);
        // Parse assignees JSON
        return tasks.map(t => ({
            ...t,
            assignees: JSON.parse(t.assignees || '[]'),
        }));
    }
}

module.exports = FlowService;
