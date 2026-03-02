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
    const savePathBtn = document.getElementById('flowSavePathBtn');
    const autoMatchBtn = document.getElementById('flowAutoMatchBtn');
    const scanDryRunBtn = document.getElementById('flowScanDryRunBtn');
    const scanTreeBtn = document.getElementById('flowScanTreeBtn');

    if (testBtn) testBtn.addEventListener('click', testFlowConnection);
    if (syncBtn) syncBtn.addEventListener('click', showFlowSyncPanel);
    if (saveBtn) saveBtn.addEventListener('click', saveFlowSettings);
    if (syncProjectsBtn) syncProjectsBtn.addEventListener('click', flowSyncProjects);
    if (syncStepsBtn) syncStepsBtn.addEventListener('click', flowSyncSteps);
    if (fullSyncBtn) fullSyncBtn.addEventListener('click', flowFullSync);
    if (syncTasksBtn) syncTasksBtn.addEventListener('click', flowSyncTasks);
    if (savePathBtn) savePathBtn.addEventListener('click', savePathConfig);
    if (autoMatchBtn) autoMatchBtn.addEventListener('click', runAutoMatch);
    if (scanDryRunBtn) scanDryRunBtn.addEventListener('click', () => scanTree(true));
    if (scanTreeBtn) scanTreeBtn.addEventListener('click', () => scanTree(false));

    // Load path config on init
    loadPathConfig();
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

    // Path matching fields are loaded separately via loadPathConfig() in init()
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
        const mappings = await api('/api/flow/mappings/projects');
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

// ─── Path Matching Helpers ───────────────────────────

function _pathLog(msg) {
    const el = document.getElementById('flowPathLog');
    if (!el) return;
    el.innerHTML += `<div>${msg}</div>`;
    el.scrollTop = el.scrollHeight;
}

async function loadPathConfig() {
    try {
        const config = await api('/api/flow/path-config');
        const rootEl = document.getElementById('flowShowRoot');
        const patternEl = document.getElementById('flowPathPattern');
        if (rootEl)    rootEl.value    = config.showRoot || '';
        if (patternEl) patternEl.value = config.pattern || '{project}/{sequence}/{shot}';
    } catch (err) {
        console.warn('Failed to load path config:', err);
    }
}

async function savePathConfig() {
    const showRoot = (document.getElementById('flowShowRoot')?.value || '').trim();
    const pattern  = (document.getElementById('flowPathPattern')?.value || '').trim();

    try {
        await api('/api/flow/path-config', {
            method: 'POST',
            body: { showRoot, pattern }
        });
        _pathLog('✅ Path config saved');
    } catch (err) {
        _pathLog(`❌ Save failed: ${err.message}`);
    }
}

async function runAutoMatch() {
    _pathLog('⏳ Auto-matching unassigned assets…');
    try {
        const result = await api('/api/flow/auto-match', { method: 'POST', body: {} });
        _pathLog(`✅ Auto-match: ${result.matched} matched, ${result.skipped} skipped, ${result.errors} errors (${result.total} total)`);
    } catch (err) {
        _pathLog(`❌ Auto-match: ${err.message}`);
    }
}

async function scanTree(dryRun) {
    const rootDir = (document.getElementById('flowScanRoot')?.value || '').trim();
    if (!rootDir) {
        _pathLog('⚠️ Enter a directory path to scan');
        return;
    }

    _pathLog(dryRun ? '⏳ Previewing scan…' : '⏳ Scanning & registering…');

    try {
        const result = await api('/api/flow/scan-tree', {
            method: 'POST',
            body: { rootDir, dryRun }
        });

        if (dryRun) {
            _pathLog(`👁️ Preview: ${result.total} media files found`);
            const matchCount = result.files.filter(f => f.wouldMatch).length;
            _pathLog(`   ${matchCount} would auto-match to project/sequence/shot`);
            if (result.total > 0 && result.files.length > 0) {
                const sample = result.files.slice(0, 5);
                for (const f of sample) {
                    const t = f.tokens;
                    const label = t ? `${t.project || '?'}/${t.sequence || '?'}/${t.shot || '?'}` : 'no match';
                    const icon = f.wouldMatch ? '✅' : '⚠️';
                    const shortPath = f.file.split('/').slice(-3).join('/');
                    _pathLog(`   ${icon} …/${shortPath} → ${label}`);
                }
                if (result.total > 5) _pathLog(`   … and ${result.total - 5} more`);
            }
        } else {
            _pathLog(`🚀 Registered ${result.registered} assets (${result.matched} auto-matched, ${result.skipped} already existed, ${result.errors} errors)`);
        }
    } catch (err) {
        _pathLog(`❌ Scan: ${err.message}`);
    }
}
