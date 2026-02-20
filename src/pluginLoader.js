/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Plugin Loader — Dynamic plugin system for CAM integrations
 *
 * Scans plugins/ for directories containing plugin.json manifests.
 * Each plugin can provide:
 *   - Backend Express routes (mounted at a specified path)
 *   - Startup hooks (run once on server boot)
 *   - Frontend assets (served statically at /plugins/<id>/)
 *   - Frontend UI contributions (settings sections, context menu items, player buttons)
 *
 * Plugins receive a `coreAPI` object with access to database, services, and utilities.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

class PluginLoader {
    constructor() {
        /** @type {Map<string, object>} Loaded plugin metadata keyed by id */
        this.plugins = new Map();
        this.pluginsDir = path.join(__dirname, '..', 'plugins');
    }

    /**
     * Build the core API object that plugins receive for dependency injection.
     * This is the contract between core CAM and plugins.
     */
    buildCoreAPI() {
        return {
            // Database access
            database: require('./database'),

            // Core services — lazy-loaded to avoid circular deps
            services: {
                get FileService() { return require('./services/FileService'); },
                get ThumbnailService() { return require('./services/ThumbnailService'); },
                get MediaInfoService() { return require('./services/MediaInfoService'); },
                get WatcherService() { return require('./services/WatcherService'); },
                get TranscodeService() { return require('./services/TranscodeService'); },
            },

            // Utility modules
            utils: {
                get naming() { return require('./utils/naming'); },
                get pathResolver() { return require('./utils/pathResolver'); },
                get mediaTypes() { return require('./utils/mediaTypes'); },
                get sequenceDetector() { return require('./utils/sequenceDetector'); },
            },

            // Paths
            rootDir: path.join(__dirname, '..'),
            pluginsDir: this.pluginsDir,
        };
    }

    /**
     * Load all plugins from the plugins/ directory.
     * @param {express.Application} app - Express app to mount routes on
     */
    async loadAll(app) {
        if (!fs.existsSync(this.pluginsDir)) {
            fs.mkdirSync(this.pluginsDir, { recursive: true });
            console.log('  📁 Created plugins/ directory');
            return;
        }

        const coreAPI = this.buildCoreAPI();

        const dirs = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const dir of dirs) {
            try {
                await this.loadPlugin(dir.name, app, coreAPI);
            } catch (err) {
                console.error(`  ❌ Plugin "${dir.name}" failed to load:`, err.message);
            }
        }

        // Mount the plugin metadata API endpoint
        this.mountAPI(app);
    }

    /**
     * Load a single plugin from its directory.
     * @param {string} dirName - Plugin directory name (e.g., "flow", "resolve")
     * @param {express.Application} app - Express app
     * @param {object} coreAPI - Core API object for dependency injection
     */
    async loadPlugin(dirName, app, coreAPI) {
        const pluginDir = path.join(this.pluginsDir, dirName);
        const manifestPath = path.join(pluginDir, 'plugin.json');

        if (!fs.existsSync(manifestPath)) {
            return; // Not a plugin directory, skip silently
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        // Validate required fields
        if (!manifest.id || !manifest.name) {
            throw new Error(`plugin.json missing required "id" or "name" field`);
        }

        // Check for duplicate plugin IDs
        if (this.plugins.has(manifest.id)) {
            throw new Error(`Duplicate plugin ID "${manifest.id}"`);
        }

        // ─── Mount Backend Routes ───
        if (manifest.backend?.routes) {
            const routePath = path.join(pluginDir, manifest.backend.routes);
            if (!fs.existsSync(routePath)) {
                throw new Error(`Routes file not found: ${manifest.backend.routes}`);
            }

            const routeModule = require(routePath);

            // Call init() if the route module exports one (dependency injection pattern)
            if (typeof routeModule.init === 'function') {
                routeModule.init(coreAPI);
            }

            // Mount the router at the specified path
            const router = routeModule.router || routeModule;
            const mountPath = manifest.backend.mountPath;
            if (!mountPath) {
                throw new Error(`plugin.json missing backend.mountPath`);
            }
            app.use(mountPath, router);
        }

        // ─── Run Startup Hook ───
        if (manifest.backend?.startup) {
            const startupPath = path.join(pluginDir, manifest.backend.startup);
            if (fs.existsSync(startupPath)) {
                const startupModule = require(startupPath);
                if (typeof startupModule === 'function') {
                    await startupModule(coreAPI);
                } else if (typeof startupModule.run === 'function') {
                    await startupModule.run(coreAPI);
                }
            }
        }

        // ─── Serve Frontend Assets ───
        // Mount the entire plugin directory so manifest paths like
        // "frontend/settings.js" resolve correctly under /plugins/<id>/
        app.use(`/plugins/${manifest.id}`, express.static(pluginDir));

        // ─── Store Plugin Metadata ───
        this.plugins.set(manifest.id, {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version || '1.0.0',
            description: manifest.description || '',
            icon: manifest.icon || '🔌',
            author: manifest.author || '',
            dir: pluginDir,
            backend: manifest.backend || {},
            frontend: manifest.frontend || {},
            loaded: true,
        });

        console.log(`  🔌 ${manifest.icon || '🔌'} ${manifest.name} v${manifest.version || '1.0.0'}`);
    }

    /**
     * Mount the /api/plugins endpoint that serves loaded plugin metadata to the frontend.
     * The frontend uses this to know which plugins are available and load their UI contributions.
     */
    mountAPI(app) {
        app.get('/api/plugins', (req, res) => {
            const plugins = Array.from(this.plugins.values()).map(p => ({
                id: p.id,
                name: p.name,
                version: p.version,
                description: p.description,
                icon: p.icon,
                author: p.author,
                frontend: p.frontend,
            }));
            res.json(plugins);
        });
    }

    /**
     * Get metadata for all loaded plugins.
     * @returns {object[]}
     */
    getLoaded() {
        return Array.from(this.plugins.values());
    }

    /**
     * Check if a specific plugin is loaded.
     * @param {string} id - Plugin ID
     * @returns {boolean}
     */
    isLoaded(id) {
        return this.plugins.has(id);
    }

    /**
     * Get metadata for a specific plugin.
     * @param {string} id - Plugin ID
     * @returns {object|undefined}
     */
    get(id) {
        return this.plugins.get(id);
    }
}

module.exports = new PluginLoader();
