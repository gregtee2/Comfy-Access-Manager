/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * LiveSyncService — Background polling sync with ShotGrid
 *
 * When enabled, runs a sync cycle every N minutes (configurable).
 * Each cycle queries ShotGrid for changes since the last sync timestamp,
 * pulling only deltas (new versions, status changes, new tasks, thumbnails).
 *
 * Settings keys (stored in CAM settings table):
 *   - flow_live_sync_enabled: '1' or '0'
 *   - flow_live_sync_interval: minutes (default 5)
 *   - flow_live_sync_last: ISO timestamp of last successful sync
 */

const FlowService = require('./FlowService');

// Module state
let _db = null;
let _timer = null;
let _running = false;       // true while a sync cycle is in progress
let _lastResult = null;     // result of the most recent sync cycle
let _lastError = null;      // error from the most recent sync cycle

const DEFAULT_INTERVAL = 5; // minutes

class LiveSyncService {

    static setDatabase(database) {
        _db = database;
    }

    // ─── Settings helpers ───

    static _getSetting(key) {
        return _db?.getSetting(key) ?? null;
    }

    static _setSetting(key, value) {
        _db?.setSetting(key, value);
    }

    static _getDb() {
        return _db?.getDb();
    }

    /** Get all Flow-linked projects: [{ localId, flowId, name }] */
    static _getLinkedProjects() {
        const db = this._getDb();
        if (!db) return [];
        return db.prepare(
            'SELECT id as localId, flow_id as flowId, name FROM projects WHERE flow_id IS NOT NULL'
        ).all();
    }

    // ─── Public API ───

    /** Is live sync currently enabled? */
    static isEnabled() {
        return this._getSetting('flow_live_sync_enabled') === '1';
    }

    /** Get the configured interval in minutes */
    static getInterval() {
        const val = this._getSetting('flow_live_sync_interval');
        return val ? parseInt(val, 10) || DEFAULT_INTERVAL : DEFAULT_INTERVAL;
    }

    /** Get the last sync timestamp (ISO string or null) */
    static getLastSyncTime() {
        return this._getSetting('flow_live_sync_last') || null;
    }

    /** Get full status object */
    static getStatus() {
        return {
            enabled: this.isEnabled(),
            running: _running,
            interval: this.getInterval(),
            lastSync: this.getLastSyncTime(),
            lastResult: _lastResult,
            lastError: _lastError,
        };
    }

    /**
     * Start the background polling timer.
     * Safe to call multiple times — clears any existing timer first.
     */
    static start() {
        this.stop(); // clear any existing timer

        if (!this.isEnabled()) return;
        if (!FlowService.isConfigured()) return;

        const intervalMs = this.getInterval() * 60 * 1000;
        console.log(`[LiveSync] Starting — interval: ${this.getInterval()} min`);

        _timer = setInterval(() => {
            this.runCycle().catch(err => {
                console.error('[LiveSync] Cycle error:', err.message);
            });
        }, intervalMs);
    }

    /** Stop the background polling timer */
    static stop() {
        if (_timer) {
            clearInterval(_timer);
            _timer = null;
            console.log('[LiveSync] Stopped');
        }
    }

    /** Enable live sync and start the timer */
    static enable(intervalMinutes) {
        this._setSetting('flow_live_sync_enabled', '1');
        if (intervalMinutes !== undefined) {
            this._setSetting('flow_live_sync_interval', String(intervalMinutes));
        }
        this.start();
    }

    /** Disable live sync and stop the timer */
    static disable() {
        this._setSetting('flow_live_sync_enabled', '0');
        this.stop();
    }

    /**
     * Run one sync cycle (called by timer or manually).
     * Queries ShotGrid for changes since `flow_live_sync_last` timestamp.
     * Updates shots (statuses) and tasks.
     *
     * @param {object} [opts] - Options
     * @param {number} [opts.localProjectId] - Only sync this project (toolbar refresh).
     *        When omitted, syncs ALL linked projects (background timer / Settings).
     */
    static async runCycle(opts = {}) {
        if (_running) {
            console.log('[LiveSync] Cycle already in progress, skipping');
            return { skipped: true };
        }

        _running = true;
        _lastError = null;
        const startTime = Date.now();
        const since = this.getLastSyncTime();  // ISO timestamp or null (full sync if first time)

        let projects = this._getLinkedProjects();
        if (opts.localProjectId) {
            projects = projects.filter(p => p.localId === opts.localProjectId);
        }

        if (projects.length === 0) {
            console.log('[LiveSync] No Flow-linked projects to sync');
            _running = false;
            return { skipped: true, reason: 'No linked projects' };
        }

        const scope = opts.localProjectId ? projects[0].name : `all ${projects.length}`;
        console.log(`[LiveSync] Starting cycle for ${scope}${since ? ` (since ${since})` : ' (full)'}`);

        const results = {
            projects: projects.length,
            shots: { updated: 0, total: 0 },
            tasks: { created: 0, updated: 0, total: 0 },
            versions: { registered: 0, skipped: 0, missing: 0, total: 0 },
            thumbnails: { downloaded: 0, total: 0 },
            errors: [],
        };

        // Run all shot syncs in parallel (1 Python subprocess each, all independent)
        const shotPromises = projects.map(project =>
            FlowService.syncShots(project.flowId, project.localId, { since })
                .then(r => ({ project, result: r }))
                .catch(err => ({ project, error: err }))
        );
        const shotResults = await Promise.all(shotPromises);

        // Track per-project changes for conditional thumbnail sync
        const projChanges = new Map(); // localId → { shotUpdates, taskCreates }
        for (const { project, result, error: err } of shotResults) {
            if (err) {
                results.errors.push(`shots/${project.name}: ${err.message}`);
                projChanges.set(project.localId, { shotUpdates: 0, taskCreates: 0 });
            } else {
                const updated = result.updated || 0;
                results.shots.updated += updated;
                results.shots.total += result.total || 0;
                projChanges.set(project.localId, { shotUpdates: updated, taskCreates: 0 });
            }
        }

        // Run all task syncs in parallel
        const taskPromises = projects.map(project =>
            FlowService.syncTasks(project.flowId, project.localId, { since })
                .then(r => ({ project, result: r }))
                .catch(err => ({ project, error: err }))
        );
        const taskResults = await Promise.all(taskPromises);

        for (const { project, result, error: err } of taskResults) {
            if (err) {
                results.errors.push(`tasks/${project.name}: ${err.message}`);
            } else {
                const created = result.created || 0;
                results.tasks.created += created;
                results.tasks.updated += result.updated || 0;
                results.tasks.total += result.total || 0;
                const pc = projChanges.get(project.localId);
                if (pc) pc.taskCreates = created;
            }
        }

        // Version sync (new media discovery) is SKIPPED during delta refreshes.
        // It spawns 2 Python subprocesses per project and scans disk for files —
        // too slow for a quick status poll. Use the "Import Media from Flow"
        // button in Settings for explicit media discovery.

        // Sync thumbnails only for projects that had actual changes
        for (const project of projects) {
            const pc = projChanges.get(project.localId) || {};
            if ((pc.shotUpdates || 0) > 0 || (pc.taskCreates || 0) > 0) {
                try {
                    const thumbResult = await FlowService.syncShotThumbnails(
                        project.flowId, project.localId, {}
                    );
                    results.thumbnails.downloaded += thumbResult.downloaded || 0;
                    results.thumbnails.total += thumbResult.total || 0;

                    const roleThumbResult = await FlowService.syncRoleThumbnails(
                        project.flowId, project.localId, {}
                    );
                    results.thumbnails.downloaded += roleThumbResult.downloaded || 0;
                    results.thumbnails.total += roleThumbResult.total || 0;
                } catch (err) {
                    results.errors.push(`thumbnails/${project.name}: ${err.message}`);
                }
            }
        }

        // Update last sync timestamp
        const now = new Date().toISOString();
        this._setSetting('flow_live_sync_last', now);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[LiveSync] Cycle complete in ${elapsed}s — shots:${results.shots.updated} tasks:${results.tasks.created}+${results.tasks.updated} versions:${results.versions.registered} thumbs:${results.thumbnails.downloaded} errors:${results.errors.length}`);

        _lastResult = { ...results, elapsed, timestamp: now };
        _running = false;

        return _lastResult;
    }
}

module.exports = LiveSyncService;
