/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Plugin Registry — Frontend plugin discovery and dynamic UI contribution system
 *
 * Fetches the list of loaded plugins from /api/plugins, then dynamically imports
 * each plugin's frontend modules (context menus, settings, player buttons).
 *
 * Other frontend modules query the registry to get plugin-contributed UI elements
 * instead of hardcoding integration-specific code.
 *
 * Usage:
 *   import pluginRegistry from './pluginRegistry.js';
 *   await pluginRegistry.init();  // Called once on app startup
 *
 *   // Get context menu items for current selection
 *   const items = pluginRegistry.getContextMenuItems({ isSingle, count, asset, assets });
 *
 *   // Get settings sections HTML
 *   const sections = await pluginRegistry.getSettingsSections();
 *
 *   // Get player button definitions
 *   const buttons = pluginRegistry.getPlayerButtons(asset);
 *
 *   // Get player options for <select> dropdown
 *   const options = pluginRegistry.getPlayerOptions();
 */

import { api } from './api.js';

class PluginRegistry {
    constructor() {
        /** @type {object[]} Raw plugin manifests from /api/plugins */
        this.plugins = [];

        /** @type {Map<string, object>} Loaded frontend modules keyed by plugin ID */
        this.modules = new Map();

        /** @type {boolean} Whether init() has been called */
        this.initialized = false;

        /** @type {object[]} Registered context menu item providers */
        this._contextMenuProviders = [];

        /** @type {object[]} Registered settings section descriptors */
        this._settingsSections = [];

        /** @type {object[]} Registered player button providers */
        this._playerProviders = [];

        /** @type {object[]} Registered player option entries (for <select> dropdown) */
        this._playerOptions = [];

        /** @type {Map<string, Function>} Settings loaders: pluginId → loadSettings function */
        this._settingsLoaders = new Map();

        /** @type {Map<string, Function>} Settings savers: pluginId → getSettingsValues function */
        this._settingsSavers = new Map();
    }

    /**
     * Initialize the registry: fetch plugin list and load frontend modules.
     * Called once from main.js on app startup.
     */
    async init() {
        if (this.initialized) return;

        try {
            this.plugins = await api('/api/plugins');
        } catch (err) {
            console.warn('[PluginRegistry] Failed to fetch plugins:', err.message);
            this.plugins = [];
        }

        // Load each plugin's frontend contributions
        for (const plugin of this.plugins) {
            try {
                await this._loadPluginFrontend(plugin);
            } catch (err) {
                console.warn(`[PluginRegistry] Plugin "${plugin.id}" frontend load failed:`, err.message);
            }
        }

        this.initialized = true;
        console.log(`[PluginRegistry] ${this.plugins.length} plugin(s) loaded`);
    }

    /**
     * Load a plugin's frontend modules based on its manifest.frontend declarations.
     */
    async _loadPluginFrontend(plugin) {
        const fe = plugin.frontend;
        if (!fe) return;

        const baseUrl = `/plugins/${plugin.id}`;
        const loaded = {};

        // ─── Context Menu Provider ───
        if (fe.contextMenu) {
            if (typeof fe.contextMenu === 'string') {
                // contextMenu is a JS module path — dynamic import
                try {
                    const mod = await import(`${baseUrl}/${fe.contextMenu}`);
                    if (mod.getMenuItems) {
                        this._contextMenuProviders.push({
                            pluginId: plugin.id,
                            icon: plugin.icon,
                            getMenuItems: mod.getMenuItems,
                        });
                    }
                    loaded.contextMenu = true;
                } catch (err) {
                    console.warn(`[PluginRegistry] ${plugin.id} contextMenu failed:`, err.message);
                }
            } else {
                // contextMenu is declarative (object or array) — extract items directly
                const items = Array.isArray(fe.contextMenu) ? fe.contextMenu
                            : (fe.contextMenu.items || []);
                if (items.length > 0) {
                    this._contextMenuProviders.push({
                        pluginId: plugin.id,
                        icon: plugin.icon,
                        items,   // Store declarative items for rendering
                        getMenuItems: (asset, selected) => {
                            return items.filter(it => {
                                if (it.singleOnly && selected.length > 1) return false;
                                if (it.fileTypes) {
                                    const ext = (asset.file_ext || '').replace('.', '').toLowerCase();
                                    if (!it.fileTypes.split(/\s+/).includes(ext)) return false;
                                }
                                return true;
                            });
                        },
                    });
                    loaded.contextMenu = true;
                }
            }
        }

        // ─── Settings Section ───
        if (fe.settingsSection) {
            try {
                // Fetch the HTML snippet
                const resp = await fetch(`${baseUrl}/${fe.settingsSection}`);
                if (resp.ok) {
                    const html = await resp.text();
                    this._settingsSections.push({
                        pluginId: plugin.id,
                        name: plugin.name,
                        icon: plugin.icon,
                        html,
                    });
                }
            } catch (err) {
                console.warn(`[PluginRegistry] ${plugin.id} settings HTML failed:`, err.message);
            }

            // Load the settings script (handles load/save for the plugin's settings)
            if (fe.settingsScript) {
                try {
                    const mod = await import(`${baseUrl}/${fe.settingsScript}`);
                    if (mod.loadSettings) {
                        this._settingsLoaders.set(plugin.id, mod.loadSettings);
                    }
                    if (mod.getValues) {
                        this._settingsSavers.set(plugin.id, mod.getValues);
                    }
                    // Store init function — called AFTER HTML injection by injectSettingsSections()
                    if (mod.init) {
                        this._settingsInits = this._settingsInits || new Map();
                        this._settingsInits.set(plugin.id, mod.init);
                    }
                    loaded.settings = true;
                } catch (err) {
                    console.warn(`[PluginRegistry] ${plugin.id} settings script failed:`, err.message);
                }
            }
        }

        // ─── Player Buttons ───
        if (fe.playerButtons) {
            try {
                const mod = await import(`${baseUrl}/${fe.playerButtons}`);
                if (mod.getPlayerButtons) {
                    this._playerProviders.push({
                        pluginId: plugin.id,
                        getPlayerButtons: mod.getPlayerButtons,
                    });
                }
                if (mod.getPlayerOptions) {
                    const opts = mod.getPlayerOptions();
                    this._playerOptions.push(...opts);
                }
                if (mod.handlePlayerAction) {
                    // Store for action dispatch
                    if (!loaded.actions) loaded.actions = {};
                    loaded.actions.player = mod.handlePlayerAction;
                }
                loaded.player = true;
            } catch (err) {
                console.warn(`[PluginRegistry] ${plugin.id} player failed:`, err.message);
            }
        }

        this.modules.set(plugin.id, loaded);
    }

    // ═══════════════════════════════════════════
    //  PUBLIC API — Used by core UI modules
    // ═══════════════════════════════════════════

    /**
     * Get context menu items contributed by all plugins.
     * @param {object} context - { isSingle, count, asset, assets, formats }
     * @returns {object[]} Array of { id, label, action, pluginId, separator? }
     */
    getContextMenuItems(context) {
        const items = [];
        for (const provider of this._contextMenuProviders) {
            try {
                const pluginItems = provider.getMenuItems(context);
                if (Array.isArray(pluginItems)) {
                    items.push(...pluginItems.map(item => ({
                        ...item,
                        pluginId: provider.pluginId,
                    })));
                }
            } catch (err) {
                console.warn(`[PluginRegistry] ${provider.pluginId} menu items error:`, err.message);
            }
        }
        return items;
    }

    /**
     * Get settings section HTML snippets from all plugins.
     * @returns {object[]} Array of { pluginId, name, icon, html }
     */
    getSettingsSections() {
        return [...this._settingsSections];
    }

    /**
     * Call all plugin settings loaders (populate DOM fields with saved values).
     * @param {object} settings - The current settings object from /api/settings
     */
    async loadPluginSettings(settings) {
        for (const [pluginId, loader] of this._settingsLoaders) {
            try {
                await loader(settings);
            } catch (err) {
                console.warn(`[PluginRegistry] ${pluginId} loadSettings error:`, err.message);
            }
        }
    }

    /**
     * Collect settings values from all plugins for saving.
     * @returns {object} Merged key-value pairs from all plugin settings
     */
    getPluginSettingsValues() {
        const values = {};
        for (const [pluginId, saver] of this._settingsSavers) {
            try {
                const pluginValues = saver();
                if (pluginValues && typeof pluginValues === 'object') {
                    Object.assign(values, pluginValues);
                }
            } catch (err) {
                console.warn(`[PluginRegistry] ${pluginId} getValues error:`, err.message);
            }
        }
        return values;
    }

    /**
     * Get player buttons contributed by all plugins for a given asset.
     * @param {object} asset - Current asset being viewed
     * @returns {object[]} Array of { id, label, action(asset), pluginId }
     */
    getPlayerButtons(asset) {
        const buttons = [];
        for (const provider of this._playerProviders) {
            try {
                const pluginButtons = provider.getPlayerButtons(asset);
                if (Array.isArray(pluginButtons)) {
                    buttons.push(...pluginButtons.map(btn => ({
                        ...btn,
                        pluginId: provider.pluginId,
                    })));
                }
            } catch (err) {
                console.warn(`[PluginRegistry] ${provider.pluginId} player buttons error:`, err.message);
            }
        }
        return buttons;
    }

    /**
     * Get player <select> option entries contributed by plugins.
     * @returns {object[]} Array of { value, label }
     */
    getPlayerOptions() {
        return [...this._playerOptions];
    }

    /**
     * Inject plugin settings HTML into the DOM and call init() on each plugin's settings module.
     * Called by settings.js after the settings tab DOM is ready.
     * Each plugin gets a placeholder <div id="plugin-settings-{id}"> in index.html.
     */
    injectSettingsSections() {
        for (const section of this._settingsSections) {
            const container = document.getElementById(`plugin-settings-${section.pluginId}`);
            if (container) {
                container.innerHTML = `<div class="settings-section">${section.html}</div>`;
            } else {
                // No placeholder — append to settings tab end (fallback)
                const settingsTab = document.getElementById('settings');
                if (settingsTab) {
                    const div = document.createElement('div');
                    div.className = 'settings-section';
                    div.innerHTML = section.html;
                    // Insert before the last settings-section (roles) or at end
                    const sections = settingsTab.querySelectorAll('.settings-section');
                    const lastSection = sections[sections.length - 1];
                    if (lastSection) {
                        lastSection.parentNode.insertBefore(div, lastSection);
                    } else {
                        settingsTab.appendChild(div);
                    }
                }
            }
        }

        // Now that HTML is in the DOM, call plugin init() functions to wire event listeners
        if (this._settingsInits) {
            for (const [pluginId, initFn] of this._settingsInits) {
                try {
                    initFn();
                } catch (err) {
                    console.warn(`[PluginRegistry] ${pluginId} settings init error:`, err.message);
                }
            }
        }
    }

    /**
     * Check if a specific plugin is loaded.
     * @param {string} id - Plugin ID
     * @returns {boolean}
     */
    isLoaded(id) {
        return this.plugins.some(p => p.id === id);
    }

    /**
     * Get a specific plugin's manifest.
     * @param {string} id - Plugin ID
     * @returns {object|undefined}
     */
    get(id) {
        return this.plugins.find(p => p.id === id);
    }
}

// Singleton
const pluginRegistry = new PluginRegistry();
export default pluginRegistry;
