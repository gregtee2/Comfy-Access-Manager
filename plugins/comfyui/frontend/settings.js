/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * ComfyUI Plugin — Frontend Settings Module
 * Loads and saves ComfyUI-specific settings (URL, output path, auto-watch).
 */

/**
 * Called by pluginRegistry after settings HTML is injected into the DOM.
 * No event listeners needed for ComfyUI settings (just form fields).
 */
export function init() {
    // No buttons to wire — field values are populated by loadSettings()
}

/**
 * Populate the ComfyUI settings fields from the global settings state.
 * Called by pluginRegistry.loadPluginSettings(settings) with the full settings object.
 */
export function loadSettings(settings) {
    const comfyUrl = document.getElementById('settingComfyUrl');
    const comfyPath = document.getElementById('settingComfyPath');
    const comfyWatch = document.getElementById('settingComfyWatch');

    if (comfyUrl) comfyUrl.value = (settings?.comfyui_url) || 'http://127.0.0.1:8188';
    if (comfyPath) comfyPath.value = (settings?.comfyui_output_path) || '';
    if (comfyWatch) comfyWatch.checked = settings?.comfyui_watch_enabled === 'true';
}

/**
 * Called by pluginRegistry.getPluginSettingsValues() during save.
 * Returns an object of key-value pairs to merge into the settings update.
 */
export function getValues() {
    return {
        comfyui_url: (document.getElementById('settingComfyUrl')?.value || '').trim() || 'http://127.0.0.1:8188',
        comfyui_output_path: (document.getElementById('settingComfyPath')?.value || '').trim(),
        comfyui_watch_enabled: document.getElementById('settingComfyWatch')?.checked ? 'true' : 'false',
    };
}
