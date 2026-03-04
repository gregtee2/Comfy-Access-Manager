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
    const syncVersionsBtn = document.getElementById('flowSyncVersionsBtn');
    const syncThumbsBtn = document.getElementById('flowSyncThumbsBtn');
    const savePathBtn = document.getElementById('flowSavePathBtn');
    const autoMatchBtn = document.getElementById('flowAutoMatchBtn');
    const scanDryRunBtn = document.getElementById('flowScanDryRunBtn');
    const scanTreeBtn = document.getElementById('flowScanTreeBtn');

    // Debug: log if critical buttons are missing from the DOM
    if (!testBtn || !saveBtn) {
        console.error('[Flow] init() called but buttons not found in DOM — testBtn:', testBtn, 'saveBtn:', saveBtn);
    }

    if (testBtn) testBtn.addEventListener('click', testFlowConnection);
    if (syncBtn) syncBtn.addEventListener('click', showFlowSyncPanel);
    if (saveBtn) saveBtn.addEventListener('click', saveFlowSettings);
    if (syncProjectsBtn) syncProjectsBtn.addEventListener('click', flowSyncProjects);
    if (syncStepsBtn) syncStepsBtn.addEventListener('click', flowSyncSteps);
    if (fullSyncBtn) fullSyncBtn.addEventListener('click', flowFullSync);
    if (syncTasksBtn) syncTasksBtn.addEventListener('click', flowSyncTasks);
    if (syncVersionsBtn) syncVersionsBtn.addEventListener('click', flowSyncVersions);
    if (syncThumbsBtn) syncThumbsBtn.addEventListener('click', flowSyncThumbnails);
    if (savePathBtn) savePathBtn.addEventListener('click', savePathConfig);
    if (autoMatchBtn) autoMatchBtn.addEventListener('click', runAutoMatch);
    if (scanDryRunBtn) scanDryRunBtn.addEventListener('click', () => scanTree(true));
    if (scanTreeBtn) scanTreeBtn.addEventListener('click', () => scanTree(false));

    // Live Sync toggle
    const liveSyncToggle = document.getElementById('flowLiveSyncToggle');
    if (liveSyncToggle) liveSyncToggle.addEventListener('change', onLiveSyncToggle);

    // Live Sync interval selector
    const liveSyncInterval = document.getElementById('flowLiveSyncInterval');
    if (liveSyncInterval) liveSyncInterval.addEventListener('change', onLiveSyncIntervalChange);

    // Load path config on init
    loadPathConfig();

    // Load live sync status
    loadLiveSyncStatus();
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

async function flowSyncVersions() {
    const select = document.getElementById('flowProjectSelect');
    if (!select || !select.value) {
        _log('⚠️ Select a project first');
        return;
    }

    const [flowId, localId] = select.value.split('|');
    const sourceSelect = document.getElementById('flowVersionSourceSelect');
    const source = sourceSelect ? sourceSelect.value : 'both';
    const projectName = select.options[select.selectedIndex]?.text || '';

    // Show progress bar
    const progressWrap = document.getElementById('flowSyncProgress');
    const progressFill = document.getElementById('flowSyncProgressFill');
    const progressText = document.getElementById('flowSyncProgressText');
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = 'Connecting to ShotGrid...';

    _log(`⏳ Importing media from Flow for ${projectName} (${source})…`);

    // Disable button during sync
    const btn = document.getElementById('flowSyncVersionsBtn');
    if (btn) btn.disabled = true;

    try {
        const response = await fetch(`/api/flow/sync/versions?stream=1`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CAM-User': localStorage.getItem('cam_user_id') || '',
            },
            body: JSON.stringify({ flowProjectId: Number(flowId), localProjectId: Number(localId), source }),
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse complete SSE events from buffer
            let eventEnd;
            while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
                const eventBlock = buffer.slice(0, eventEnd);
                buffer = buffer.slice(eventEnd + 2);

                // Check for named events (done/error)
                let eventType = 'message';
                let eventData = '';
                for (const line of eventBlock.split('\n')) {
                    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
                    else if (line.startsWith('data: ')) eventData = line.slice(6);
                }

                if (!eventData) continue;
                let data;
                try { data = JSON.parse(eventData); } catch { continue; }

                if (eventType === 'done') {
                    finalResult = data;
                    break;
                }
                if (eventType === 'error') {
                    throw new Error(data.error || 'Sync failed');
                }

                // Progress update
                if (data.phase === 'fetching') {
                    if (progressFill) progressFill.style.width = '0%';
                    if (progressText) progressText.textContent = data.message;
                } else if (data.phase === 'processing') {
                    const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
                    if (progressFill) progressFill.style.width = `${pct}%`;
                    if (progressText) progressText.textContent = `${data.current} / ${data.total} — ${data.registered || 0} registered`;
                } else if (data.phase === 'thumbnails') {
                    if (progressFill) progressFill.style.width = '100%';
                    if (progressText) progressText.textContent = data.message;
                }
            }

            if (finalResult) break;
        }

        // Show final results
        if (finalResult) {
            if (progressFill) progressFill.style.width = '100%';
            if (progressText) progressText.textContent = `Done — ${finalResult.registered} imported`;

            if (finalResult.registered > 0) {
                _log(`✅ Imported ${finalResult.registered} assets from Flow`);
            } else {
                _log('ℹ️ No new assets to import');
            }
            if (finalResult.missing > 0) {
                _log(`⚠️ ${finalResult.missing} files not found on disk — check path mappings if media is on a NAS`);
            }
            if (finalResult.skipped > 0) {
                _log(`   ${finalResult.skipped} already imported or non-media, ${finalResult.errors} errors`);
            }
            _log(`   Total from Flow: ${finalResult.total}`);
        }
    } catch (err) {
        _log(`❌ Import: ${err.message}`);
        if (progressFill) progressFill.style.width = '0%';
        if (progressText) progressText.textContent = `Error: ${err.message}`;
    } finally {
        if (btn) btn.disabled = false;
        // Hide progress bar after a delay
        setTimeout(() => {
            if (progressWrap) progressWrap.style.display = 'none';
        }, 5000);
    }
}
async function flowSyncThumbnails() {
    const select = document.getElementById('flowProjectSelect');
    if (!select || !select.value) {
        _log('\u26a0\ufe0f Select a project first');
        return;
    }

    const [flowId, localId] = select.value.split('|');
    const projectName = select.options[select.selectedIndex]?.text || '';

    _log(`\u23f3 Pulling thumbnails from ShotGrid for ${projectName}\u2026`);

    try {
        const result = await api('/api/flow/sync/thumbnails', {
            method: 'POST',
            body: { flowProjectId: Number(flowId), localProjectId: Number(localId) }
        });

        if (result.downloaded > 0) {
            _log(`\u2705 Downloaded ${result.downloaded} thumbnails from ShotGrid`);
        } else if (result.noThumb > 0 && result.total > 0) {
            _log(`\u2139\ufe0f No thumbnails available in ShotGrid for this project`);
        } else if (result.total === 0) {
            _log('\u2139\ufe0f No Flow-sourced items found for this project');
        } else {
            _log('\u2139\ufe0f All thumbnails already exist locally');
        }
        if (result.shots && result.shots.downloaded > 0) {
            _log(`   Shot thumbnails: ${result.shots.downloaded} downloaded`);
        }
        if (result.roles && result.roles.downloaded > 0) {
            _log(`   Role thumbnails: ${result.roles.downloaded} downloaded (per shot+department)`);
        }
        if (result.skipped > 0) {
            _log(`   ${result.skipped} already had thumbnails`);
        }
        if (result.errors > 0) {
            _log(`   ${result.errors} download errors`);
        }
    } catch (err) {
        _log(`\u274c Thumbnails: ${err.message}`);
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

// ─── Live Sync ───────────────────────────────────────

async function loadLiveSyncStatus() {
    const toggle = document.getElementById('flowLiveSyncToggle');
    const options = document.getElementById('flowLiveSyncOptions');
    const interval = document.getElementById('flowLiveSyncInterval');
    const statusEl = document.getElementById('flowLiveSyncStatus');
    if (!toggle) return;

    try {
        const status = await api('/api/flow/live-sync/status');
        toggle.checked = status.enabled;
        if (options) options.style.display = status.enabled ? 'block' : 'none';
        if (interval) interval.value = String(status.interval || 5);
        if (statusEl) {
            if (status.lastSync) {
                statusEl.textContent = `Last synced: ${new Date(status.lastSync).toLocaleString()}`;
            } else {
                statusEl.textContent = 'Never synced';
            }
        }
    } catch {
        // Live sync endpoint not available
        toggle.checked = false;
    }
}

async function onLiveSyncToggle() {
    const toggle = document.getElementById('flowLiveSyncToggle');
    const options = document.getElementById('flowLiveSyncOptions');
    if (!toggle) return;

    const enabled = toggle.checked;

    try {
        if (enabled) {
            const interval = document.getElementById('flowLiveSyncInterval');
            const mins = interval ? Number(interval.value) : 5;
            await api('/api/flow/live-sync/enable', { method: 'POST', body: { interval: mins } });
            if (options) options.style.display = 'block';
            _status('Live Sync enabled', 'var(--success)');
        } else {
            await api('/api/flow/live-sync/disable', { method: 'POST' });
            if (options) options.style.display = 'none';
            _status('Live Sync disabled', 'var(--text-dim)');
        }
    } catch (err) {
        _status(`Live Sync error: ${err.message}`, 'var(--danger)');
        toggle.checked = !enabled; // revert
    }
}

async function onLiveSyncIntervalChange() {
    const interval = document.getElementById('flowLiveSyncInterval');
    const toggle = document.getElementById('flowLiveSyncToggle');
    if (!interval || !toggle?.checked) return;

    try {
        await api('/api/flow/live-sync/enable', {
            method: 'POST',
            body: { interval: Number(interval.value) }
        });
        _status(`Sync interval updated to ${interval.value} min`, 'var(--success)');
    } catch (err) {
        _status(`Interval update failed: ${err.message}`, 'var(--danger)');
    }
}
