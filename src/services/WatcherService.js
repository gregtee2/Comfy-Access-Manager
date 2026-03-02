/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Watcher Service
 * Monitors folders for new media files and auto-imports them
 */

const chokidar = require('chokidar');
const path = require('path');
const { getDb, logActivity } = require('../database');
const { isMediaFile } = require('../utils/mediaTypes');

class WatcherService {
    constructor() {
        this.watchers = new Map(); // path → chokidar watcher
        this.onFileDetected = null; // Callback for new files
    }

    /**
     * Start watching all configured folders
     */
    start() {
        const db = getDb();
        const folders = db.prepare('SELECT * FROM watch_folders').all();

        for (const folder of folders) {
            if (folder.auto_import) {
                this.watchFolder(folder.path, folder.project_id, folder.id);
            }
        }

        console.log(`[Watcher] Watching ${this.watchers.size} folders`);
    }

    /**
     * Watch a specific folder for new media files
     */
    watchFolder(folderPath, projectId, watchId) {
        if (this.watchers.has(folderPath)) {
            console.log(`[Watcher] Already watching: ${folderPath}`);
            return;
        }

        try {
            const watcher = chokidar.watch(folderPath, {
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 2000,
                    pollInterval: 500,
                },
                ignored: /(^|[\/\\])\../,  // Ignore dotfiles
            });

            watcher.on('add', (filePath) => {
                if (!isMediaFile(filePath)) return;

                console.log(`[Watcher] New file detected: ${path.basename(filePath)}`);

                logActivity('file_detected', 'watch_folder', watchId, {
                    file: filePath,
                    folder: folderPath,
                });

                if (this.onFileDetected) {
                    this.onFileDetected({
                        filePath,
                        folderPath,
                        projectId,
                        watchId,
                    });
                }
            });

            watcher.on('error', (err) => {
                console.error(`[Watcher] Error on ${folderPath}:`, err.message);
            });

            this.watchers.set(folderPath, watcher);
            console.log(`[Watcher] Now watching: ${folderPath}`);
        } catch (err) {
            console.error(`[Watcher] Failed to watch ${folderPath}:`, err.message);
        }
    }

    /**
     * Stop watching a folder
     */
    unwatchFolder(folderPath) {
        const watcher = this.watchers.get(folderPath);
        if (watcher) {
            watcher.close();
            this.watchers.delete(folderPath);
            console.log(`[Watcher] Stopped watching: ${folderPath}`);
        }
    }

    /**
     * Add a new watch folder to the database and start watching
     */
    addWatch(folderPath, projectId = null, autoImport = false) {
        const db = getDb();
        const existing = db.prepare('SELECT id FROM watch_folders WHERE path = ?').get(folderPath);
        if (existing) {
            throw new Error(`Already watching: ${folderPath}`);
        }

        const result = db.prepare(
            'INSERT INTO watch_folders (path, project_id, auto_import) VALUES (?, ?, ?)'
        ).run(folderPath, projectId, autoImport ? 1 : 0);

        if (autoImport) {
            this.watchFolder(folderPath, projectId, result.lastInsertRowid);
        }

        logActivity('watch_added', 'watch_folder', result.lastInsertRowid, { path: folderPath });

        return result.lastInsertRowid;
    }

    /**
     * Remove a watch folder
     */
    removeWatch(watchId) {
        const db = getDb();
        const folder = db.prepare('SELECT * FROM watch_folders WHERE id = ?').get(watchId);
        if (folder) {
            this.unwatchFolder(folder.path);
            db.prepare('DELETE FROM watch_folders WHERE id = ?').run(watchId);
            logActivity('watch_removed', 'watch_folder', watchId, { path: folder.path });
        }
    }

    /**
     * Get all watch folders
     */
    getAll() {
        const db = getDb();
        return db.prepare(`
            SELECT wf.*, p.name as project_name, p.code as project_code
            FROM watch_folders wf
            LEFT JOIN projects p ON p.id = wf.project_id
            ORDER BY wf.created_at DESC
        `).all();
    }

    /**
     * Stop all watchers
     */
    stopAll() {
        for (const [folderPath, watcher] of this.watchers) {
            watcher.close();
            console.log(`[Watcher] Stopped: ${folderPath}`);
        }
        this.watchers.clear();
    }
}

// Singleton
module.exports = new WatcherService();
