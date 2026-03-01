/**
 * Flow Production Tracking — Frontend Settings Module
 * Handles: load/save Flow credentials, test connection, sync operations
 *
 * Exports: init(), loadSettings(settings), getValues()
 */

import { api } from '/js/api.js';

let _initialized = false;

/**
 * Initialize event listeners on the Flow settings section.
 * Called once by pluginRegistry after the HTML is injected.
 */
export function init() {
    if (_initialized) return;
    _initialized = true;

    const testBtn = document.getElementById('flowTestBtn');
    const syncBtn = document.getElementById('flowSyncBtn');
    const saveBtn = document.getElementById('flowSaveBtn');
    const syncProjectsBtn = document.getElementById('flowSyncProjectsBtn');
    const syncStepsBtn = document.getElementById('flowSyncStepsBtn');
    const fullSyncBtn = document.getElementById('flowFullSyncBtn');
    const syncTasksBtn = document.getElementById('flowSyncTasksBtn');

    if (testBtn) testBtn.addEventListener('click', testFlowConnection);
    if (syncBtn) syncBtn.addEventListener('click', showFlowSyncPanel);
    if (saveBtn) saveBtn.addEventListener('click', saveFlowSettings);
    if (syncProjectsBtn) syncProjectsBtn.addEventListener('click', flowSyncProjects);
    if (syncStepsBtn) syncStepsBtn.addEventListener('click', flowSyncSteps);
    if (fullSyncBtn) fullSyncBtn.addEventListener('click', flowFullSync);
    if (syncTasksBtn) syncTasksBtn.addEventListener('click', flowSyncTasks);
}

/**
 * Populate Flow inputs from current settings.
 * Called by pluginRegistry.loadPluginSettings(settings).
 * @param {object} settings — Full settings object from server
 */
export function loadSettings(settings) {
    const siteEl = document.getElementById('settingFlowSite');
    const scriptEl = document.getElementById('settingFlowScriptName');
    const keyEl = document.getElementById('settingFlowApiKey');

    if (siteEl)   siteEl.value   = settings.flow_site_url || '';
    if (scriptEl) scriptEl.value = settings.flow_script_name || '';
    if (keyEl)    keyEl.value    = settings.flow_api_key || '';
}

/**
 * Return current Flow credential values for saving.
 * Called by pluginRegistry.getPluginSettingsValues().
 * @returns {object} Key-value pairs to POST to /api/settings
 */
export function getValues() {
    return {
        flow_site_url:    (document.getElementById('settingFlowSite')?.value || '').trim(),
        flow_script_name: (document.getElementById('settingFlowScriptName')?.value || '').trim(),
        flow_api_key:     (document.getElementById('settingFlowApiKey')?.value || '').trim(),
    };
}

// ─── Internal Helpers ────────────────────────────────

function _status(msg, color = 'var(--text-dim)') {
    const el = document.getElementById('flowStatus');
    if (el) el.innerHTML = `<span style="color:${color}">${msg}</span>`;
}

function _log(msg) {
    const el = document.getElementById('flowSyncLog');
    if (!el) return;
    el.innerHTML += `<div>${msg}</div>`;
    el.scrollTop = el.scrollHeight;
}

// ─── Button Handlers ─────────────────────────────────

async function saveFlowSettings() {
    const values = getValues();
    try {
        await api('/api/settings', { method: 'POST', body: values });
        _status('✅ Flow credentials saved.', 'var(--success)');
    } catch (err) {
        _status(`❌ Save failed: ${err.message}`, 'var(--danger)');
    }
}

async function testFlowConnection() {
    _status('Testing connection…');
    try {
        // Save credentials first so the backend has them
        const values = getValues();
        await api('/api/settings', { method: 'POST', body: values });

        const result = await api('/api/flow/status');
        if (result.connected) {
            _status(`✅ Connected to Flow (${result.serverInfo || 'OK'})`, 'var(--success)');
            const syncBtn = document.getElementById('flowSyncBtn');
            if (syncBtn) syncBtn.disabled = false;
        } else {
            _status('❌ Connection failed — check credentials', 'var(--danger)');
        }
    } catch (err) {
        _status(`❌ ${err.message}`, 'var(--danger)');
    }
}

function showFlowSyncPanel() {
    const panel = document.getElementById('flowSyncPanel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function flowSyncProjects() {
    _log('⏳ Syncing projects…');
    try {
        const result = await api('/api/flow/sync/projects', { method: 'POST' });
        _log(`✅ Projects — ${result.created || 0} created, ${result.updated || 0} updated`);

        // After syncing projects, populate the project selector for full sync
        await loadFlowProjectSelector();
    } catch (err) {
        _log(`❌ Projects: ${err.message}`);
    }
}

async function flowSyncSteps() {
    _log('⏳ Syncing pipeline steps → roles…');
    try {
        const result = await api('/api/flow/sync/steps', { method: 'POST' });
        _log(`✅ Steps — ${result.created || 0} created, ${result.updated || 0} updated`);
    } catch (err) {
        _log(`❌ Steps: ${err.message}`);
    }
}

async function flowFullSync() {
    const select = document.getElementById('flowProjectSelect');
    if (!select || !select.value) {
        _log('⚠️ Select a project first');
        return;
    }

    const [flowId, localId] = select.value.split('|');
    _log(`⏳ Full sync for project ${select.options[select.selectedIndex]?.text}…`);

    try {
        const result = await api('/api/flow/sync/full', {
            method: 'POST',
            body: { flowProjectId: Number(flowId), localProjectId: Number(localId) }
        });

        if (result.steps)     _log(`  Steps: ${result.steps.created} created, ${result.steps.updated} updated`);
        if (result.sequences) _log(`  Sequences: ${result.sequences.created} created, ${result.sequences.updated} updated`);
        if (result.shots)     _log(`  Shots: ${result.shots.created} created, ${result.shots.updated} updated`);
        if (result.tasks)     _log(`  Tasks: ${result.tasks.created} created, ${result.tasks.updated} updated`);
        _log('✅ Full sync complete');
    } catch (err) {
        _log(`❌ Full sync: ${err.message}`);
    }
}

async function flowSyncTasks() {
    const select = document.getElementById('flowProjectSelect');
    if (!select || !select.value) {
        _log('⚠️ Select a project first');
        return;
    }

    const [flowId, localId] = select.value.split('|');
    _log(`⏳ Syncing tasks for ${select.options[select.selectedIndex]?.text}…`);

    try {
        const result = await api('/api/flow/sync/tasks', {
            method: 'POST',
            body: { flowProjectId: Number(flowId), localProjectId: Number(localId) }
        });
        _log(`✅ Tasks — ${result.created || 0} created, ${result.updated || 0} updated (${result.total || 0} total)`);
    } catch (err) {
        _log(`❌ Tasks: ${err.message}`);
    }
}

async function loadFlowProjectSelector() {
    try {
        const mappings = await api('/api/flow/mappings');
        const select = document.getElementById('flowProjectSelect');
        const row = document.getElementById('flowProjectSyncRow');
        if (!select || !mappings?.length) return;

        select.innerHTML = mappings.map(p =>
            `<option value="${p.flow_id}|${p.id}">${p.name} (${p.code})</option>`
        ).join('');

        if (row) row.style.display = 'block';
    } catch (err) {
        console.warn('Failed to load Flow project mappings:', err);
    }
}
