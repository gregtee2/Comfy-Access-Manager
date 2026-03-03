/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Comfy Asset Manager (CAM) - Main Entry Point
 * Tab switching, initialization, vault setup.
 * All other logic is in feature modules.
 */

import { state } from './state.js';
import { api } from './api.js';
import { loadProjects, loadTree, initFileDropZone, loadCrates } from './browser.js';
import { loadImportTab } from './import.js';
import { loadSettings, loadRoles, openFolderPicker, autoCheckForUpdates } from './settings.js';
import pluginRegistry from './pluginRegistry.js';
import './export.js';
import './overlayEditor.js';
import './syncReview.js';
import './voiceChat.js';

// ===========================================
//  INIT
// ===========================================
document.addEventListener('DOMContentLoaded', async () => {
    initFileDropZone();
    await initUserThenSetup();
});

// ===========================================
//  USER IDENTITY
// ===========================================

/** Check if user is selected; if not, show picker overlay. Then proceed with setup. */
async function initUserThenSetup() {
    const savedUserId = localStorage.getItem('cam_user_id');
    if (savedUserId) {
        // Validate user still exists
        try {
            const users = await fetchUsersRaw();
            const found = users.find(u => u.id === parseInt(savedUserId, 10));
            if (found) {
                setCurrentUser(found);
                await checkSetup();
                return;
            }
        } catch (_) {}
        // User no longer exists - clear and show picker
        localStorage.removeItem('cam_user_id');
    }
    // No user selected - show picker
    await showUserPicker();
}

/** Fetch users list (raw fetch, no X-CAM-User header needed for this endpoint) */
async function fetchUsersRaw() {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error('Failed to fetch users');
    return res.json();
}

/** Set the active user in localStorage and update top bar indicator */
function setCurrentUser(user) {
    localStorage.setItem('cam_user_id', String(user.id));
    localStorage.setItem('cam_user_is_admin', user.is_admin ? '1' : '0');
    state.currentUser = user;
    const avatarEl = document.getElementById('userAvatar');
    const nameEl = document.getElementById('userName');
    if (avatarEl) avatarEl.textContent = user.name.substring(0, 2).toUpperCase();
    if (nameEl) nameEl.textContent = user.name;
    const btn = document.getElementById('userIndicator');
    if (btn) {
        btn.style.borderColor = user.color || '#888';
        btn.title = `Signed in as ${user.name}${user.is_admin ? ' (Admin)' : ''} - click to switch`;
    }
}

/** Show the user picker overlay. Fetches users and renders buttons. */
async function showUserPicker() {
    const overlay = document.getElementById('userPickerOverlay');
    const listEl = document.getElementById('userPickerList');
    if (!overlay || !listEl) return;

    overlay.style.display = 'flex';
    hidePinPrompt(); // Reset any open PIN prompt
    listEl.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.5;">Loading users...</div>';

    try {
        const users = await fetchUsersRaw();
        if (users.length === 0) {
            listEl.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.7;">No users yet. The first user (Admin) will be created automatically.</div>';
            // Auto-create admin if somehow missing
            const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Admin', is_admin: 1, avatar: 'AD', color: '#4fc3f7' }) });
            if (res.ok) {
                const newAdmin = await res.json();
                selectUser(newAdmin);
            }
            return;
        }

        listEl.innerHTML = users.map(u => `
            <button class="user-picker-btn" onclick="${u.has_pin ? `promptPin(${u.id})` : `selectUser(${u.id})`}" style="border-left: 4px solid ${u.color || '#888'}">
                <span class="user-picker-avatar">${u.name.substring(0, 2).toUpperCase()}</span>
                <span class="user-picker-name">${u.name}</span>
                ${u.has_pin ? '<span class="user-picker-lock">[Lock]</span>' : ''}
                ${u.is_admin ? '<span class="user-picker-badge">Admin</span>' : ''}
            </button>
        `).join('');
    } catch (err) {
        listEl.innerHTML = `<div style="color:#ff5252;padding:12px;">Error loading users: ${err.message}</div>`;
    }
}

/** Show PIN prompt for a PIN-protected user */
let _pendingPinUserId = null;
function promptPin(userId) {
    _pendingPinUserId = userId;
    const row = document.getElementById('pinPromptRow');
    const input = document.getElementById('pinInput');
    const err = document.getElementById('pinError');
    if (row) row.style.display = 'flex';
    if (input) { input.value = ''; input.focus(); }
    if (err) { err.style.display = 'none'; err.textContent = ''; }
}
function hidePinPrompt() {
    _pendingPinUserId = null;
    const row = document.getElementById('pinPromptRow');
    const err = document.getElementById('pinError');
    if (row) row.style.display = 'none';
    if (err) err.style.display = 'none';
}
async function submitPin() {
    const input = document.getElementById('pinInput');
    const err = document.getElementById('pinError');
    const pin = input?.value;
    if (!pin || !_pendingPinUserId) return;

    try {
        const res = await fetch('/api/users/verify-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: _pendingPinUserId, pin })
        });
        const data = await res.json();
        if (data.valid) {
            const uid = _pendingPinUserId;
            hidePinPrompt();
            selectUser(uid);
        } else {
            if (err) { err.textContent = 'Incorrect PIN'; err.style.display = 'block'; }
            if (input) { input.value = ''; input.focus(); }
        }
    } catch (e) {
        if (err) { err.textContent = 'Error verifying PIN'; err.style.display = 'block'; }
    }
}

/** Called when user clicks a profile in the picker */
async function selectUser(userOrId) {
    let user = userOrId;
    if (typeof userOrId === 'number') {
        try {
            const users = await fetchUsersRaw();
            user = users.find(u => u.id === userOrId);
        } catch (_) { return; }
    }
    if (!user) return;

    setCurrentUser(user);
    document.getElementById('userPickerOverlay').style.display = 'none';
    await checkSetup();
}

async function checkSetup() {
    try {
        const status = await api('/api/settings/status');
        state.settings = await api('/api/settings');

        document.getElementById('assetCount').textContent = `${status.assets} assets`;
        document.getElementById('appVersion').textContent = status.version ? `v${status.version}` : '';
        document.getElementById('statusIndicator').className = 'status-dot' + (status.vaultConfigured ? '' : ' warning');

        if (!status.vaultConfigured) {
            document.getElementById('setupOverlay').style.display = 'flex';
            scanForRemoteServers(); // Auto-discover servers on the LAN
        } else {
            document.getElementById('setupOverlay').style.display = 'none';

            // Initialize plugin registry (loads plugin UI contributions)
            await pluginRegistry.init();

            loadProjects();
            loadSettings();
            loadRoles();

            // Apply start tab preference (default: projects)
            const startTab = state.settings?.start_tab || 'projects';
            if (startTab !== 'projects') {
                switchTab(startTab);
            }

            // Apply default browser view preference
            const defaultView = state.settings?.default_view || 'grid';
            state.viewMode = defaultView;

            // Auto-check for updates (unless disabled in prefs)
            if (state.settings?.auto_check_updates !== 'false') {
                autoCheckForUpdates();
            }

            // Check Flow Production Tracking connection status (non-blocking)
            checkFlowStatus();

            // Periodically refresh the "time ago" text and check for background sync results
            setInterval(updateFlowSyncStatus, 60000);
        }
    } catch (err) {
        console.error('Setup check failed:', err);
    }
}

// ===========================================
//  TABS
// ===========================================
function switchTab(tab) {
    state.currentTab = tab;

    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));

    if (tab === 'projects') loadProjects();
    if (tab === 'browser') { loadTree(); loadCrates(); }
    if (tab === 'import') loadImportTab();
    if (tab === 'settings') { loadSettings(); loadRoles(); }
}

// ===========================================
//  NETWORK DISCOVERY (setup overlay)
// ===========================================
async function scanForRemoteServers() {
    const statusEl = document.getElementById('setupDiscoveryStatus');
    const listEl = document.getElementById('setupDiscoveredServers');
    if (!statusEl || !listEl) return;

    statusEl.textContent = ' Scanning your network...';
    statusEl.style.display = 'block';
    listEl.innerHTML = '';

    try {
        const data = await api('/api/servers/discover?timeout=3000');
        const servers = data.servers || [];

        if (servers.length === 0) {
            statusEl.textContent = 'No servers found on this network';
            statusEl.style.opacity = '0.5';
        } else {
            statusEl.style.display = 'none';
            listEl.innerHTML = servers.map(s => `
                <div class="setup-server-card" onclick="window.location.href='${s.url}'">
                    <div class="setup-server-dot"></div>
                    <div class="setup-server-info">
                        <div class="setup-server-name">${s.name || s.hostname}</div>
                        <div class="setup-server-meta">${s.ip}:${s.port} . ${s.assets} assets</div>
                    </div>
                    <div class="setup-server-arrow">-></div>
                </div>
            `).join('');
        }
    } catch (err) {
        statusEl.textContent = 'Could not scan network';
        statusEl.style.opacity = '0.5';
    }
}

// ===========================================
//  VAULT SETUP
// ===========================================
async function setupVault() {
    const pathInput = document.getElementById('setupVaultPath');
    const vaultPath = pathInput.value.trim();
    if (!vaultPath) return alert('Please enter a path');

    try {
        await api('/api/settings/setup-vault', { method: 'POST', body: { path: vaultPath } });
        document.getElementById('setupOverlay').style.display = 'none';
        await checkSetup();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function browseForVault() {
    openFolderPicker('setupVaultPath');
}

// ===========================================
//  FLOW STATUS CHECK
// ===========================================

/**
 * Check Flow Production Tracking connection status and update topbar indicator.
 * Runs once on startup, non-blocking. Shows the Flow + Sync buttons if configured.
 */
async function checkFlowStatus() {
    const btn = document.getElementById('flowStatusBtn');
    const dot = document.getElementById('flowStatusDot');
    const syncBtn = document.getElementById('flowRefreshBtn');
    if (!btn || !dot) return;

    try {
        const result = await api('/api/flow/status');

        if (!result.configured) {
            // Not configured — hide the buttons
            btn.style.display = 'none';
            if (syncBtn) syncBtn.style.display = 'none';
            return;
        }

        // Show the buttons
        btn.style.display = '';
        if (syncBtn) syncBtn.style.display = '';

        if (result.connected) {
            dot.className = 'flow-dot connected';
            btn.title = 'Flow Production Tracking — connected';
            // Check live sync status and update the "last synced" indicator
            updateFlowSyncStatus();
        } else {
            dot.className = 'flow-dot configured';
            btn.title = 'Flow Production Tracking — configured but not connected';
        }
    } catch {
        // API not available (plugin not loaded) — hide buttons
        btn.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
    }
}

/**
 * Update the sync button's "last synced" indicator text.
 * Also detects background sync completions and auto-refreshes the UI.
 */
let _lastKnownSync = null;
async function updateFlowSyncStatus() {
    const statusEl = document.getElementById('flowRefreshStatus');
    const syncBtn = document.getElementById('flowRefreshBtn');
    if (!statusEl || !syncBtn) return;

    try {
        const status = await api('/api/flow/live-sync/status');
        if (status.lastSync) {
            const ago = timeAgo(status.lastSync);
            statusEl.textContent = ago;
            statusEl.title = `Last synced: ${new Date(status.lastSync).toLocaleString()}`;

            // Detect background sync completion and auto-refresh UI
            if (_lastKnownSync && status.lastSync !== _lastKnownSync) {
                window.loadTree?.();
                window.loadProjectAssets?.(window.state?.currentProject?.id);
            }
            _lastKnownSync = status.lastSync;
        } else {
            statusEl.textContent = '';
            statusEl.title = 'Never synced';
        }
        syncBtn.title = status.enabled
            ? `Live Sync ON (every ${status.interval} min) — click to sync now`
            : 'Click to sync with ShotGrid';
    } catch {
        // endpoints not available
    }
}

/**
 * Format an ISO timestamp as a human-readable "time ago" string.
 */
function timeAgo(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Trigger a manual Flow sync (called from the toolbar Refresh button).
 */
async function triggerFlowSync() {
    const syncBtn = document.getElementById('flowRefreshBtn');
    if (!syncBtn || syncBtn.classList.contains('syncing')) return;

    syncBtn.classList.add('syncing');
    syncBtn.title = 'Syncing with ShotGrid...';

    try {
        // Only sync the project the user is currently viewing (fast: ~1s)
        const body = {};
        const proj = window.state?.currentProject;
        if (proj?.id && proj?.flow_id) {
            body.localProjectId = proj.id;
        }
        const result = await api('/api/flow/live-sync/trigger', { method: 'POST', body });
        if (result.success) {
            const parts = [];
            if (result.shots?.updated) parts.push(`${result.shots.updated} shot updates`);
            if (result.tasks?.created) parts.push(`${result.tasks.created} new tasks`);
            if (result.tasks?.updated) parts.push(`${result.tasks.updated} task updates`);
            if (result.versions?.registered) parts.push(`${result.versions.registered} new versions`);
            if (result.thumbnails?.downloaded) parts.push(`${result.thumbnails.downloaded} thumbnails`);

            const msg = parts.length > 0 ? `Synced: ${parts.join(', ')}` : 'Sync complete — no changes';
            window.showToast?.(msg, 4000);

            // Refresh the tree and grid to show new data
            window.loadTree?.();
            window.loadProjectAssets?.(window.state?.currentProject?.id);
        }
    } catch (err) {
        window.showToast?.('Sync failed: ' + (err.message || 'Unknown error'), 5000);
    } finally {
        syncBtn.classList.remove('syncing');
        updateFlowSyncStatus();
    }
}

// ===========================================
//  EXPOSE ON WINDOW
// ===========================================
window.switchTab = switchTab;
window.checkSetup = checkSetup;
window.setupVault = setupVault;
window.scanForRemoteServers = scanForRemoteServers;
window.browseForVault = browseForVault;
window.showUserPicker = showUserPicker;
window.selectUser = selectUser;
window.promptPin = promptPin;
window.hidePinPrompt = hidePinPrompt;
window.submitPin = submitPin;
window.triggerFlowSync = triggerFlowSync;



