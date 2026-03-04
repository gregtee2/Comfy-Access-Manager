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
                windowsHide: true,
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
                    "UPDATE projects SET name = ?, description = ?, updated_at = datetime('now') WHERE flow_id = ?"
                ).run(proj.name, proj.description, proj.flow_id);
                updated++;
            } else {
                const byCode = db.prepare(
                    'SELECT id FROM projects WHERE code = ?'
                ).get(proj.code);

                if (byCode) {
                    db.prepare(
                        "UPDATE projects SET flow_id = ?, description = ?, updated_at = datetime('now') WHERE id = ?"
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

    static async syncShots(flowProjectId, localProjectId, opts = {}) {
        const params = { project_id: flowProjectId };
        if (opts.since) params.since = opts.since;
        const result = await this.execute('sync_shots', params);
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
                    'UPDATE shots SET name = ?, code = ?, description = ?, sequence_id = ?, flow_status = ? WHERE id = ?'
                ).run(shot.name, shot.code, shot.description, localSeqId, shot.status || null, existing.id);
                updated++;
            } else {
                const byCode = db.prepare(
                    'SELECT id FROM shots WHERE code = ? AND project_id = ?'
                ).get(shot.code, localProjectId);

                if (byCode) {
                    db.prepare(
                        'UPDATE shots SET flow_id = ?, description = ?, sequence_id = ?, flow_status = ? WHERE id = ?'
                    ).run(shot.flow_id, shot.description, localSeqId, shot.status || null, byCode.id);
                    updated++;
                } else {
                    if (!localSeqId) continue;
                    db.prepare(
                        'INSERT INTO shots (project_id, sequence_id, name, code, description, flow_id, flow_status) VALUES (?, ?, ?, ?, ?, ?, ?)'
                    ).run(localProjectId, localSeqId, shot.name, shot.code, shot.description, shot.flow_id, shot.status || null);
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

    static async syncTasks(flowProjectId, localProjectId, opts = {}) {
        const params = { project_id: flowProjectId };
        if (opts.since) params.since = opts.since;
        const result = await this.execute('sync_tasks', params);
        const db = this._getDb();
        let created = 0, updated = 0;

        for (const task of result.tasks) {
            const existing = db.prepare(
                'SELECT id FROM flow_tasks WHERE flow_id = ?'
            ).get(task.flow_id);

            const assigneesJson = JSON.stringify(task.assignees || []);
            const taskContent = task.content || '';

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
                    taskContent, task.status, task.description,
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
                    task.flow_id, localProjectId, taskContent, task.status,
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

    /**
     * Fetch Versions from Flow for a project, find their file paths on disk,
     * and register them in-place (is_linked = 1) in the CAM database.
     *
     * Each Version is assigned to the correct project/sequence/shot/role
     * based on the entity link (Shot) and task step from ShotGrid.
     *
     * @param {number} flowProjectId — ShotGrid project ID
     * @param {number} localProjectId — CAM project ID
     * @param {object} [opts] — { source: 'versions'|'published_files'|'both', statuses: string[], onProgress: function }
     * @returns {object} — { registered, skipped, missing, errors, total }
     */
    static async syncVersions(flowProjectId, localProjectId, opts = {}) {
        const onProgress = opts.onProgress || (() => {});
        const path = require('path');
        const fs = require('fs');
        const { isMediaFile, detectMediaType } = require('../../../src/utils/mediaTypes');
        const { resolveFilePath } = require('../../../src/utils/pathResolver');

        const db = this._getDb();
        const source = opts.source || 'both';

        // Collect all items (versions + published files)
        onProgress({ phase: 'fetching', message: 'Fetching versions from ShotGrid...' });
        let items = [];

        if (source === 'versions' || source === 'both') {
            try {
                const vResult = await this.execute('sync_versions', {
                    project_id: flowProjectId,
                    statuses: opts.statuses || null,
                    since: opts.since || null,
                });
                if (vResult.versions) {
                    items.push(...vResult.versions.map(v => ({ ...v, _source: 'version' })));
                }
            } catch (err) {
                console.warn('[Flow] Version fetch failed:', err.message);
            }
        }

        if (source === 'published_files' || source === 'both') {
            try {
                const pfResult = await this.execute('sync_published_files', {
                    project_id: flowProjectId,
                    since: opts.since || null,
                });
                if (pfResult.published_files) {
                    items.push(...pfResult.published_files.map(pf => ({ ...pf, _source: 'published_file' })));
                }
            } catch (err) {
                console.warn('[Flow] PublishedFile fetch failed:', err.message);
            }
        }

        if (items.length === 0) {
            onProgress({ phase: 'done', message: 'No versions found', registered: 0, total: 0 });
            return { success: true, registered: 0, skipped: 0, missing: 0, errors: 0, total: 0, message: 'No versions or published files found in Flow' };
        }

        onProgress({ phase: 'processing', message: `Processing ${items.length} versions...`, current: 0, total: items.length });

        // Build lookup maps for shots and roles by flow_id
        const shotsByFlowId = new Map();
        db.prepare('SELECT id, flow_id, sequence_id FROM shots WHERE project_id = ?').all(localProjectId)
            .forEach(s => shotsByFlowId.set(s.flow_id, s));

        const rolesByFlowId = new Map();
        db.prepare('SELECT id, flow_id FROM roles WHERE flow_id IS NOT NULL').all()
            .forEach(r => rolesByFlowId.set(r.flow_id, r));

        // Existing file paths in DB to skip duplicates
        const existingPaths = new Set(
            db.prepare('SELECT file_path FROM assets WHERE project_id = ?').all(localProjectId)
                .map(a => a.file_path)
        );

        // Also track by flow_version_id to skip re-importing same version
        const existingFlowIds = new Set();
        try {
            db.prepare("SELECT json_extract(metadata, '$.flow_version_id') as fv FROM assets WHERE project_id = ? AND metadata IS NOT NULL")
                .all(localProjectId)
                .forEach(a => { if (a.fv) existingFlowIds.add(a.fv); });
        } catch { /* metadata column may not have json_extract */ }

        const insertAsset = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size,
                is_linked, status, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
        `);

        // Separate insert for frame sequences — includes is_sequence columns
        const insertSequenceAsset = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size,
                is_linked, status, metadata,
                is_sequence, frame_start, frame_end, frame_count, frame_pattern
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, 1, ?, ?, ?, ?)
        `);

        const { detectSequences } = require('../../../src/utils/sequenceDetector');

        let registered = 0, skipped = 0, missing = 0, errors = 0;
        const ThumbnailService = require('../../../src/services/ThumbnailService');
        const newAssetIds = [];
        const newFlowMap = [];  // { flowId, assetId, source } for thumbnail fetch

        /**
         * Resolve a ShotGrid frame-sequence path pattern to actual files on disk.
         * SG stores paths like "X:\...\render.####.exr" or "X:\...\render.%04d.exr"
         * which aren't real files — we need to scan the directory for matching frames.
         *
         * @param {string} rawPath - Path that may contain ####, %0Nd, or $F padding notation
         * @returns {{ files: string[], dir: string }|null} - Array of matching file paths, or null
         */
        function resolveFrameSequencePath(rawPath) {
            if (!rawPath) return null;

            // Detect frame padding patterns in filename:
            //   #### or ######              → ShotGrid/Houdini style
            //   %04d or %0Nd                → printf/Nuke style
            //   $F or $F4                   → Houdini style
            const fileName = path.basename(rawPath);
            const dirPath = path.dirname(rawPath);

            // Match patterns and convert to regex for scanning
            let fileRegex = null;
            let paddingDigits = 4;  // default

            // Pattern 1: #### notation (e.g. render.####.exr → render.\d{4}.exr)
            const hashMatch = fileName.match(/(#+)/);
            if (hashMatch) {
                paddingDigits = hashMatch[1].length;
                const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regexStr = escaped.replace(/#+/, `\\d{${paddingDigits},}`);
                fileRegex = new RegExp(`^${regexStr}$`);
            }

            // Pattern 2: %04d or %0Nd notation (e.g. render.%04d.exr)
            if (!fileRegex) {
                const printfMatch = fileName.match(/%0?(\d*)d/);
                if (printfMatch) {
                    paddingDigits = parseInt(printfMatch[1]) || 1;
                    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regexStr = escaped.replace(/%0?\d*d/, `\\d{${paddingDigits},}`);
                    fileRegex = new RegExp(`^${regexStr}$`);
                }
            }

            // Pattern 3: $F or $F4 notation (Houdini)
            if (!fileRegex) {
                const houdiniMatch = fileName.match(/\$F(\d*)/);
                if (houdiniMatch) {
                    paddingDigits = parseInt(houdiniMatch[1]) || 1;
                    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regexStr = escaped.replace(/\\\$F\d*/, `\\d{${paddingDigits},}`);
                    fileRegex = new RegExp(`^${regexStr}$`);
                }
            }

            if (!fileRegex) return null;

            // Check if the directory exists (try direct and cross-platform resolved)
            let resolvedDir = dirPath;
            if (!fs.existsSync(resolvedDir)) {
                try {
                    const mapped = resolveFilePath(resolvedDir);
                    if (mapped && fs.existsSync(mapped)) {
                        resolvedDir = mapped;
                    } else {
                        return null;
                    }
                } catch {
                    return null;
                }
            }

            // Scan directory for matching files
            try {
                const dirContents = fs.readdirSync(resolvedDir);
                const matchingFiles = dirContents
                    .filter(f => fileRegex.test(f))
                    .sort()
                    .map(f => path.join(resolvedDir, f));

                if (matchingFiles.length >= 2) {
                    return { files: matchingFiles, dir: resolvedDir };
                }
            } catch {}

            return null;
        }

        const CHUNK_SIZE = 50;
        const registerChunk = db.transaction((batchItems, chunkOffset) => {
            for (let idx = 0; idx < batchItems.length; idx++) {
                const item = batchItems[idx];
                try {
                    // Skip if we already imported this flow version
                    if (existingFlowIds.has(item.flow_id)) {
                        skipped++;
                        continue;
                    }

                    // Try each path variant until we find one that exists on disk
                    let resolvedPath = null;
                    let frameSeqResult = null;  // for frame sequence paths
                    for (const rawPath of (item.paths || [])) {
                        // Try the path as-is first (works for .mov, single files)
                        if (fs.existsSync(rawPath)) {
                            resolvedPath = rawPath;
                            break;
                        }
                        // Try cross-platform path resolution
                        try {
                            const mapped = resolveFilePath(rawPath);
                            if (mapped && fs.existsSync(mapped)) {
                                resolvedPath = mapped;
                                break;
                            }
                        } catch {}

                        // If path has frame padding notation (####, %04d, $F),
                        // try resolving as a frame sequence by scanning the directory
                        if (!frameSeqResult) {
                            frameSeqResult = resolveFrameSequencePath(rawPath);
                        }
                    }

                    // ── Frame sequence registration ──
                    if (!resolvedPath && frameSeqResult) {
                        const { files, dir } = frameSeqResult;

                        // Use sequence detector to group frames properly
                        const { sequences } = detectSequences(files);
                        if (sequences.length > 0) {
                            const seq = sequences[0];  // one SG version = one sequence
                            const firstFrame = seq.files[0];

                            // Skip if first frame already registered
                            if (existingPaths.has(firstFrame)) {
                                skipped++;
                                continue;
                            }

                            const seqFileName = path.basename(firstFrame);
                            const seqExt = path.extname(seqFileName).toLowerCase();
                            const { type: seqMediaType } = detectMediaType(seqFileName);

                            // Compute total file size
                            let totalSize = 0;
                            for (const f of seq.files) {
                                try { totalSize += fs.statSync(f).size; } catch {}
                            }

                            // Resolve shot + sequence from entity link
                            let shotId = null, sequenceId = null;
                            if (item.entity_type === 'Shot' && item.entity_id) {
                                const shot = shotsByFlowId.get(item.entity_id);
                                if (shot) {
                                    shotId = shot.id;
                                    sequenceId = shot.sequence_id;
                                }
                            }

                            let roleId = null;
                            if (item.step_id) {
                                const role = rolesByFlowId.get(item.step_id);
                                if (role) roleId = role.id;
                            }

                            const metadata = JSON.stringify({
                                flow_version_id: item.flow_id,
                                flow_source: item._source,
                                flow_code: item.code,
                            });

                            // frame_pattern: printf-style FILENAME only (no directory)
                            // e.g. "AL_049_GWH_0005_comp_v012.%04d.exr"
                            // rvFinder.js and reviewRoutes.js join this with path.dirname(file_path)
                            const framePattern = seq.ffmpegPattern;

                            const result = insertSequenceAsset.run(
                                localProjectId, sequenceId, shotId, roleId,
                                `${seq.baseName}${seq.ext} [${seq.frameStart}-${seq.frameEnd}]`,   // original_name
                                item.code || `${seq.baseName}${seq.ext}`,   // vault_name
                                firstFrame,            // file_path (first frame)
                                firstFrame,            // relative_path
                                seqMediaType,          // media_type (usually 'exr')
                                seqExt,                // file_ext
                                totalSize,             // total size of all frames
                                metadata,
                                seq.frameStart,        // frame_start
                                seq.frameEnd,          // frame_end
                                seq.frameCount,        // frame_count
                                framePattern           // frame_pattern (printf-style full path)
                            );

                            existingPaths.add(firstFrame);
                            registered++;
                            if (result.lastInsertRowid) {
                                newAssetIds.push(result.lastInsertRowid);
                                newFlowMap.push({ flowId: item.flow_id, assetId: result.lastInsertRowid, source: item._source });
                            }
                            continue;
                        }
                    }

                    if (!resolvedPath) {
                        missing++;
                        continue;
                    }

                    // Skip if this exact path is already registered
                    if (existingPaths.has(resolvedPath)) {
                        skipped++;
                        continue;
                    }

                    const fileName = path.basename(resolvedPath);

                    // Skip non-media files
                    if (!isMediaFile(fileName)) {
                        skipped++;
                        continue;
                    }

                    const ext = path.extname(fileName).toLowerCase();
                    const { type: mediaType } = detectMediaType(fileName);

                    // Skip non-viewable types (3D caches, documents, etc.)
                    // CAM is a media viewer — .abc, .fbx, .obj, .pdf etc. just clutter the UI
                    if (mediaType === 'threed' || mediaType === 'document' || mediaType === 'other') {
                        skipped++;
                        continue;
                    }

                    let fileSize = 0;
                    try { fileSize = fs.statSync(resolvedPath).size; } catch {}

                    // Resolve shot + sequence from entity link
                    let shotId = null, sequenceId = null;
                    if (item.entity_type === 'Shot' && item.entity_id) {
                        const shot = shotsByFlowId.get(item.entity_id);
                        if (shot) {
                            shotId = shot.id;
                            sequenceId = shot.sequence_id;
                        }
                    }

                    // Resolve role from step link
                    let roleId = null;
                    if (item.step_id) {
                        const role = rolesByFlowId.get(item.step_id);
                        if (role) roleId = role.id;
                    }

                    // Store flow metadata
                    const metadata = JSON.stringify({
                        flow_version_id: item.flow_id,
                        flow_source: item._source,
                        flow_code: item.code,
                    });

                    const result = insertAsset.run(
                        localProjectId, sequenceId, shotId, roleId,
                        fileName,       // original_name
                        item.code || fileName,  // vault_name (use SG version code)
                        resolvedPath,   // file_path (absolute)
                        resolvedPath,   // relative_path
                        mediaType,
                        ext,
                        fileSize,
                        metadata
                    );

                    existingPaths.add(resolvedPath);
                    registered++;
                    if (result.lastInsertRowid) {
                        newAssetIds.push(result.lastInsertRowid);
                        newFlowMap.push({ flowId: item.flow_id, assetId: result.lastInsertRowid, source: item._source });
                    }
                } catch (err) {
                    errors++;
                }
            }
        });

        // Process items in chunks with progress reporting between each
        for (let chunkStart = 0; chunkStart < items.length; chunkStart += CHUNK_SIZE) {
            const chunk = items.slice(chunkStart, chunkStart + CHUNK_SIZE);
            registerChunk(chunk, chunkStart);
            onProgress({
                phase: 'processing',
                message: `Processing versions...`,
                current: Math.min(chunkStart + CHUNK_SIZE, items.length),
                total: items.length,
                registered,
                skipped,
                missing,
            });
        }

        onProgress({ phase: 'thumbnails', message: `Fetching thumbnails for ${newAssetIds.length} new assets...`, registered, total: items.length });

        // ─── Thumbnails: prefer ShotGrid thumbnails, FFmpeg fallback ───
        if (newAssetIds.length > 0) {
            const pathMod = require('path');
            const https = require('https');
            const http = require('http');
            const thumbDir = pathMod.join(__dirname, '..', '..', '..', 'thumbnails');
            if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

            const downloadImage = (url, destPath) => {
                return new Promise((resolve, reject) => {
                    const client = url.startsWith('https') ? https : http;
                    const req = client.get(url, { timeout: 15000 }, (res) => {
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                            downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
                            return;
                        }
                        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                        const fileStream = fs.createWriteStream(destPath);
                        res.pipe(fileStream);
                        fileStream.on('finish', () => { fileStream.close(); resolve(); });
                        fileStream.on('error', reject);
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                });
            };

            const fetchSgThumbnails = async () => {
                // Group by source type (Version vs PublishedFile IDs can overlap)
                const versionFlowIds = newFlowMap.filter(m => m.source === 'version').map(m => m.flowId);
                const pfFlowIds = newFlowMap.filter(m => m.source === 'published_file').map(m => m.flowId);
                const flowIdToAssetIds = new Map();
                for (const m of newFlowMap) {
                    const key = `${m.source}:${m.flowId}`;
                    if (!flowIdToAssetIds.has(key)) flowIdToAssetIds.set(key, []);
                    flowIdToAssetIds.get(key).push(m.assetId);
                }

                // Fetch SG thumbnail URLs for newly registered items
                const urlMap = new Map();  // 'source:flowId' → url
                const BATCH_SIZE = 500;
                try {
                    if (versionFlowIds.length > 0) {
                        for (let i = 0; i < versionFlowIds.length; i += BATCH_SIZE) {
                            const batch = versionFlowIds.slice(i, i + BATCH_SIZE);
                            const result = await this.execute('fetch_thumbnail_urls', {
                                project_id: flowProjectId, source: 'versions', flow_ids: batch,
                            });
                            for (const t of (result.thumbnails || [])) {
                                urlMap.set(`version:${t.flow_id}`, t.url);
                            }
                        }
                    }
                    if (pfFlowIds.length > 0) {
                        for (let i = 0; i < pfFlowIds.length; i += BATCH_SIZE) {
                            const batch = pfFlowIds.slice(i, i + BATCH_SIZE);
                            const result = await this.execute('fetch_thumbnail_urls', {
                                project_id: flowProjectId, source: 'published_files', flow_ids: batch,
                            });
                            for (const t of (result.thumbnails || [])) {
                                urlMap.set(`published_file:${t.flow_id}`, t.url);
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[Flow] Failed to fetch SG thumbnail URLs: ${err.message}`);
                }

                // Download SG thumbnails with concurrency limit
                let sgDownloaded = 0, sgMissing = 0;
                const DL_CONCURRENCY = 6;
                const entries = [...flowIdToAssetIds.entries()];

                for (let i = 0; i < entries.length; i += DL_CONCURRENCY) {
                    const batch = entries.slice(i, i + DL_CONCURRENCY);
                    await Promise.allSettled(batch.map(async ([key, assetIds]) => {
                        const url = urlMap.get(key);
                        if (!url) { sgMissing++; return; }
                        try {
                            const primaryPath = pathMod.join(thumbDir, `thumb_${assetIds[0]}.jpg`);
                            await downloadImage(url, primaryPath);
                            db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(primaryPath, assetIds[0]);
                            for (let j = 1; j < assetIds.length; j++) {
                                const copyPath = pathMod.join(thumbDir, `thumb_${assetIds[j]}.jpg`);
                                try { fs.copyFileSync(primaryPath, copyPath); } catch {}
                                db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(copyPath, assetIds[j]);
                            }
                            sgDownloaded++;
                        } catch { sgMissing++; }
                    }));
                }
                console.log(`[Flow] SG thumbnails: ${sgDownloaded} downloaded, ${sgMissing} not available in ShotGrid`);

                // FFmpeg fallback ONLY for assets that didn't get a SG thumbnail
                if (sgMissing > 0) {
                    const missingThumbAssets = [];
                    const SQL_BATCH = 500;
                    for (let i = 0; i < newAssetIds.length; i += SQL_BATCH) {
                        const batch = newAssetIds.slice(i, i + SQL_BATCH);
                        const rows = db.prepare(
                            `SELECT id, file_path, media_type FROM assets WHERE id IN (${batch.map(() => '?').join(',')}) AND thumbnail_path IS NULL`
                        ).all(...batch);
                        missingThumbAssets.push(...rows);
                    }

                    if (missingThumbAssets.length > 0) {
                        console.log(`[Flow] Generating ${missingThumbAssets.length} thumbnails via FFmpeg (no SG thumbnail)...`);
                        const FFMPEG_CONCURRENCY = 2;
                        for (let i = 0; i < missingThumbAssets.length; i += FFMPEG_CONCURRENCY) {
                            const batch = missingThumbAssets.slice(i, i + FFMPEG_CONCURRENCY);
                            await Promise.allSettled(batch.map(async (asset) => {
                                try {
                                    const thumbPath = await ThumbnailService.generate(asset.file_path, asset.id);
                                    if (thumbPath) {
                                        db.prepare('UPDATE assets SET thumbnail_path = ? WHERE id = ?').run(thumbPath, asset.id);
                                    }
                                } catch {}
                            }));
                        }
                    }
                }
                console.log(`[Flow] Thumbnail sync complete for ${newAssetIds.length} new assets`);
            };
            setTimeout(fetchSgThumbnails, 500);
        }

        // Broadcast to spokes if hub mode
        if (registered > 0 && typeof global._broadcastChange === 'function') {
            try {
                const SQL_BATCH = 500;
                for (let i = 0; i < newAssetIds.length; i += SQL_BATCH) {
                    const batch = newAssetIds.slice(i, i + SQL_BATCH);
                    const newAssets = db.prepare(
                        `SELECT * FROM assets WHERE id IN (${batch.map(() => '?').join(',')})`
                    ).all(...batch);
                    for (const asset of newAssets) {
                        global._broadcastChange('assets', 'insert', { record: asset });
                    }
                }
            } catch {}
        }

        const finalResult = {
            success: true,
            registered,
            skipped,
            missing,
            errors,
            total: items.length,
            message: `Registered ${registered} assets from Flow. ${missing} files not found on disk. ${skipped} already imported.`
        };
        onProgress({ phase: 'done', ...finalResult });
        return finalResult;
    }

    /**
     * Fetch thumbnails from ShotGrid for assets already registered from Flow.
     * Looks up assets with flow_version_id metadata, fetches thumbnail URLs from SG,
     * and downloads them to CAM's thumbnails/ directory.
     *
     * @param {number} flowProjectId - Flow project ID
     * @param {number} localProjectId - Local project ID
     * @param {object} [opts] - Options
     * @param {string} [opts.source='both'] - 'versions'|'published_files'|'both'
     * @param {boolean} [opts.overwrite=false] - Overwrite existing thumbnails
     * @returns {object} - { downloaded, skipped, noThumb, errors, total }
     */
    static async syncThumbnails(flowProjectId, localProjectId, opts = {}) {
        const fs = require('fs');
        const pathMod = require('path');
        const https = require('https');
        const http = require('http');

        const db = this._getDb();
        const thumbDir = pathMod.join(__dirname, '..', '..', '..', 'thumbnails');
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

        // Get all assets in this project that have flow metadata
        const assets = db.prepare(
            `SELECT id, metadata FROM assets WHERE project_id = ? AND metadata IS NOT NULL`
        ).all(localProjectId);

        // Build map: flow_version_id → [assetId, ...]
        const flowToAssets = new Map();  // flowId → [assetIds]
        const flowSourceMap = new Map(); // flowId → 'version' | 'published_file'
        for (const asset of assets) {
            try {
                const meta = JSON.parse(asset.metadata);
                if (!meta.flow_version_id) continue;
                const fid = meta.flow_version_id;
                if (!flowToAssets.has(fid)) flowToAssets.set(fid, []);
                flowToAssets.get(fid).push(asset.id);
                flowSourceMap.set(fid, meta.flow_source || 'version');
            } catch {}
        }

        if (flowToAssets.size === 0) {
            return { success: true, downloaded: 0, skipped: 0, noThumb: 0, errors: 0, total: 0, message: 'No Flow-sourced assets found.' };
        }

        // Filter to only assets that need thumbnails (no existing file)
        const overwrite = opts.overwrite || false;
        const needsThumbs = new Map();
        for (const [flowId, assetIds] of flowToAssets) {
            const allExist = assetIds.every(id =>
                fs.existsSync(pathMod.join(thumbDir, `thumb_${id}.jpg`))
            );
            if (!allExist || overwrite) {
                needsThumbs.set(flowId, assetIds);
            }
        }

        if (needsThumbs.size === 0) {
            return { success: true, downloaded: 0, skipped: flowToAssets.size, noThumb: 0, errors: 0, total: flowToAssets.size, message: 'All thumbnails already exist.' };
        }

        // Fetch thumbnail URLs from ShotGrid
        const source = opts.source || 'both';
        let thumbResult;
        try {
            thumbResult = await this.execute('fetch_thumbnail_urls', {
                project_id: flowProjectId,
                source,
            });
        } catch (err) {
            throw new Error(`Failed to fetch thumbnail URLs from ShotGrid: ${err.message}`);
        }

        if (!thumbResult.thumbnails || thumbResult.thumbnails.length === 0) {
            return { success: true, downloaded: 0, skipped: 0, noThumb: flowToAssets.size, errors: 0, total: flowToAssets.size, message: 'No thumbnails found in ShotGrid for this project.' };
        }

        // Build flowId → url map
        const urlMap = new Map();
        for (const t of thumbResult.thumbnails) {
            urlMap.set(t.flow_id, t.url);
        }

        // Download thumbnails
        let downloaded = 0, skipped = 0, noThumb = 0, errors = 0;

        const downloadImage = (url, destPath) => {
            return new Promise((resolve, reject) => {
                const client = url.startsWith('https') ? https : http;
                const req = client.get(url, { timeout: 15000 }, (res) => {
                    // Handle redirects (SG often returns 302)
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    const fileStream = fs.createWriteStream(destPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => { fileStream.close(); resolve(); });
                    fileStream.on('error', reject);
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            });
        };

        for (const [flowId, assetIds] of needsThumbs) {
            const url = urlMap.get(flowId);
            if (!url) {
                noThumb++;
                continue;
            }

            try {
                // Download to the first asset's thumb path, then copy for others
                const primaryPath = pathMod.join(thumbDir, `thumb_${assetIds[0]}.jpg`);
                await downloadImage(url, primaryPath);

                // Copy for additional assets sharing the same flow version
                for (let i = 1; i < assetIds.length; i++) {
                    const copyPath = pathMod.join(thumbDir, `thumb_${assetIds[i]}.jpg`);
                    try { fs.copyFileSync(primaryPath, copyPath); } catch {}
                }

                downloaded++;
            } catch (err) {
                errors++;
            }
        }

        skipped = flowToAssets.size - needsThumbs.size;

        return {
            success: true,
            downloaded,
            skipped,
            noThumb,
            errors,
            total: flowToAssets.size,
            message: `Downloaded ${downloaded} thumbnails from ShotGrid. ${skipped} already existed. ${noThumb} had no thumbnail in SG.`
        };
    }

    /**
     * Fetch and download shot thumbnails from ShotGrid.
     * Saves as thumbnails/shot_<localShotId>.jpg so they can be served statically.
     *
     * @param {number} flowProjectId - Flow project ID
     * @param {number} localProjectId - Local project ID
     * @param {object} [opts] - Options
     * @param {boolean} [opts.overwrite=false] - Overwrite existing thumbnails
     * @returns {object} - { downloaded, skipped, noThumb, errors, total }
     */
    static async syncShotThumbnails(flowProjectId, localProjectId, opts = {}) {
        const fs = require('fs');
        const pathMod = require('path');
        const https = require('https');
        const http = require('http');

        const db = this._getDb();
        const thumbDir = pathMod.join(__dirname, '..', '..', '..', 'thumbnails');
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

        // Get local shots with flow_ids
        const shots = db.prepare(
            'SELECT id, flow_id FROM shots WHERE project_id = ? AND flow_id IS NOT NULL'
        ).all(localProjectId);

        if (shots.length === 0) {
            return { success: true, downloaded: 0, skipped: 0, noThumb: 0, errors: 0, total: 0, message: 'No shots with Flow IDs found.' };
        }

        // Build map: flowId -> localShotId
        const flowToLocal = new Map();
        for (const s of shots) flowToLocal.set(s.flow_id, s.id);

        const overwrite = opts.overwrite || false;

        // Fetch shot thumbnail URLs from ShotGrid
        let thumbResult;
        try {
            thumbResult = await this.execute('fetch_shot_thumbnails', {
                project_id: flowProjectId,
            });
        } catch (err) {
            throw new Error(`Failed to fetch shot thumbnails from ShotGrid: ${err.message}`);
        }

        if (!thumbResult.thumbnails || thumbResult.thumbnails.length === 0) {
            return { success: true, downloaded: 0, skipped: 0, noThumb: shots.length, errors: 0, total: shots.length, message: 'No shot thumbnails found in ShotGrid.' };
        }

        const downloadImage = (url, destPath) => {
            return new Promise((resolve, reject) => {
                const client = url.startsWith('https') ? https : http;
                const req = client.get(url, { timeout: 15000 }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    const fileStream = fs.createWriteStream(destPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => { fileStream.close(); resolve(); });
                    fileStream.on('error', reject);
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            });
        };

        let downloaded = 0, skipped = 0, noThumb = 0, errors = 0;

        for (const t of thumbResult.thumbnails) {
            const localId = flowToLocal.get(t.flow_id);
            if (!localId) continue; // shot not in our DB

            const destPath = pathMod.join(thumbDir, `shot_${localId}.jpg`);
            if (!overwrite && fs.existsSync(destPath)) {
                skipped++;
                continue;
            }

            try {
                await downloadImage(t.url, destPath);
                downloaded++;
            } catch (err) {
                errors++;
            }
        }

        // Count shots that had no thumbnail in SG
        const sgFlowIds = new Set(thumbResult.thumbnails.map(t => t.flow_id));
        noThumb = shots.filter(s => !sgFlowIds.has(s.flow_id)).length;

        return {
            success: true,
            downloaded,
            skipped,
            noThumb,
            errors,
            total: shots.length,
            message: `Downloaded ${downloaded} shot thumbnails from ShotGrid. ${skipped} already existed. ${noThumb} shots have no thumbnail in SG.`
        };
    }

    /**
     * Fetch and download role-level thumbnails from ShotGrid.
     * For each shot+role combo, gets the latest Version's thumbnail.
     * Saves as thumbnails/task_<shotId>_<roleId>.jpg
     *
     * @param {number} flowProjectId - Flow project ID
     * @param {number} localProjectId - Local project ID
     * @param {object} [opts]
     * @param {boolean} [opts.overwrite=false]
     * @returns {object} - { downloaded, skipped, noThumb, errors, total }
     */
    static async syncRoleThumbnails(flowProjectId, localProjectId, opts = {}) {
        const fs = require('fs');
        const pathMod = require('path');
        const https = require('https');
        const http = require('http');

        const db = this._getDb();
        const thumbDir = pathMod.join(__dirname, '..', '..', '..', 'thumbnails');
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

        // Build lookup maps: flow_id -> local id
        const shotsByFlowId = new Map();
        db.prepare('SELECT id, flow_id FROM shots WHERE project_id = ? AND flow_id IS NOT NULL')
            .all(localProjectId)
            .forEach(s => shotsByFlowId.set(s.flow_id, s.id));

        const rolesByFlowId = new Map();
        db.prepare('SELECT id, flow_id FROM roles WHERE flow_id IS NOT NULL').all()
            .forEach(r => rolesByFlowId.set(r.flow_id, r.id));

        if (shotsByFlowId.size === 0) {
            return { success: true, downloaded: 0, skipped: 0, noThumb: 0, errors: 0, total: 0, message: 'No shots with Flow IDs found.' };
        }

        // Fetch role-level thumbnail URLs from ShotGrid
        let thumbResult;
        try {
            thumbResult = await this.execute('fetch_role_thumbnails', {
                project_id: flowProjectId,
            });
        } catch (err) {
            throw new Error(`Failed to fetch role thumbnails from ShotGrid: ${err.message}`);
        }

        if (!thumbResult.thumbnails || thumbResult.thumbnails.length === 0) {
            return { success: true, downloaded: 0, skipped: 0, noThumb: 0, errors: 0, total: 0, message: 'No role-level thumbnails found in ShotGrid.' };
        }

        const overwrite = opts.overwrite || false;

        const downloadImage = (url, destPath) => {
            return new Promise((resolve, reject) => {
                const client = url.startsWith('https') ? https : http;
                const req = client.get(url, { timeout: 15000 }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    const fileStream = fs.createWriteStream(destPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => { fileStream.close(); resolve(); });
                    fileStream.on('error', reject);
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            });
        };

        let downloaded = 0, skipped = 0, errors = 0;

        for (const t of thumbResult.thumbnails) {
            const localShotId = shotsByFlowId.get(t.shot_flow_id);
            const localRoleId = rolesByFlowId.get(t.step_flow_id);
            if (!localShotId || !localRoleId) continue;

            const destPath = pathMod.join(thumbDir, `task_${localShotId}_${localRoleId}.jpg`);
            if (!overwrite && fs.existsSync(destPath)) {
                skipped++;
                continue;
            }

            try {
                await downloadImage(t.url, destPath);
                downloaded++;
            } catch (err) {
                errors++;
            }
        }

        return {
            success: true,
            downloaded,
            skipped,
            noThumb: 0,
            errors,
            total: thumbResult.thumbnails.length,
            message: `Downloaded ${downloaded} role thumbnails. ${skipped} already existed.`
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
