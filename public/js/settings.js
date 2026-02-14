/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV — Settings Module
 * Settings tab, vault migration, watch folders, folder picker.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, escAttr, showToast } from './utils.js';

// ═══════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════

export async function loadSettings() {
    try {
        state.settings = await api('/api/settings');
        const status = await api('/api/settings/status');

        document.getElementById('settingVaultRoot').value = state.settings.vault_root || '';
        document.getElementById('settingNamingTemplate').value = state.settings.naming_template || '';
        document.getElementById('settingThumbSize').value = state.settings.thumbnail_size || '320';
        document.getElementById('settingAutoThumb').checked = state.settings.auto_thumbnail !== 'false';
        document.getElementById('settingComfyPath').value = state.settings.comfyui_output_path || '';
        document.getElementById('settingComfyWatch').checked = state.settings.comfyui_watch_enabled === 'true';

        // External player
        const playerSel = document.getElementById('settingDefaultPlayer');
        const defPlayer = state.settings.default_player || 'browser';
        playerSel.value = defPlayer;
        document.getElementById('customPlayerRow').style.display = defPlayer === 'custom' ? 'flex' : 'none';
        document.getElementById('settingCustomPlayerPath').value = state.settings.custom_player_path || '';
        document.getElementById('settingRvPath').value = state.settings.rv_path || '';
        playerSel.onchange = () => {
            document.getElementById('customPlayerRow').style.display = playerSel.value === 'custom' ? 'flex' : 'none';
            saveSettings();
        };

        // System info
        document.getElementById('systemInfo').innerHTML = `
            <div style="font-size:0.82rem;color:var(--text-dim);line-height:1.8;">
                <div>Version: <strong>${status.version}</strong></div>
                <div>Projects: <strong>${status.projects}</strong></div>
                <div>Assets: <strong>${status.assets}</strong></div>
                <div>Watch Folders: <strong>${status.watchFolders}</strong></div>
                <div>FFmpeg: ${status.ffmpegAvailable ? '<span style="color:var(--success)">✓ Available</span>' : '<span style="color:var(--danger)">✗ Not found</span>'}</div>
                <div>Vault: ${status.vaultConfigured ? '<span style="color:var(--success)">✓ Configured</span>' : '<span style="color:var(--warning)">⚠ Not configured</span>'}</div>
            </div>
        `;

        // Watch folders
        const watches = await api('/api/settings/watches');
        document.getElementById('watchFolderList').innerHTML = watches.map(w => `
            <div class="watch-item">
                <span>📂 ${esc(w.path)} ${w.project_name ? `→ ${esc(w.project_name)}` : ''}</span>
                <button onclick="removeWatch(${w.id})">✕</button>
            </div>
        `).join('') || '<div style="color:var(--text-muted);font-size:0.8rem;">No watch folders configured.</div>';

        // Check if files need migration to new vault root
        const vaultRoot = state.settings.vault_root;
        if (vaultRoot && status.assets > 0) {
            checkMigrationNeeded(vaultRoot);
        }
    } catch (err) {
        console.error('Settings load failed:', err);
    }
}

async function saveSettings() {
    const updates = {
        vault_root: document.getElementById('settingVaultRoot').value.trim(),
        naming_template: document.getElementById('settingNamingTemplate').value.trim(),
        thumbnail_size: document.getElementById('settingThumbSize').value,
        auto_thumbnail: document.getElementById('settingAutoThumb').checked ? 'true' : 'false',
        comfyui_output_path: document.getElementById('settingComfyPath').value.trim(),
        comfyui_watch_enabled: document.getElementById('settingComfyWatch').checked ? 'true' : 'false',
        default_player: document.getElementById('settingDefaultPlayer').value,
        custom_player_path: document.getElementById('settingCustomPlayerPath').value.trim(),
        rv_path: document.getElementById('settingRvPath').value.trim(),
    };

    try {
        await api('/api/settings', { method: 'POST', body: updates });
        loadSettings();
    } catch (err) {
        alert('Error saving: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  VAULT MIGRATION
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
//  VAULT MIGRATION
// ═══════════════════════════════════════════

let _lastKnownOldRoot = null;

function checkMigrationNeeded(currentVaultRoot) {
    fetch('/api/assets?limit=1').then(r => r.json()).then(data => {
        const migrateSection = document.getElementById('migrateSection');
        if (!data.assets || data.assets.length === 0) {
            migrateSection.style.display = 'none';
            return;
        }
        const firstPath = data.assets[0].file_path;
        const normalizedRoot = currentVaultRoot.replace(/[\\/]+$/, '');
        if (!firstPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
            const relPath = data.assets[0].relative_path;
            const oldRoot = firstPath.slice(0, firstPath.length - relPath.length - 1);
            _lastKnownOldRoot = oldRoot;
            document.getElementById('migrateMessage').textContent =
                `Files are still at ${oldRoot}. Move them to ${currentVaultRoot}?`;
            migrateSection.style.display = 'block';
        } else {
            migrateSection.style.display = 'none';
        }
    }).catch(() => {});
}

async function migrateVault() {
    if (!_lastKnownOldRoot) { alert('Could not determine old vault location.'); return; }
    const newRoot = document.getElementById('settingVaultRoot').value.trim();
    if (!newRoot) { alert('Set a vault root path first.'); return; }

    const btn = document.getElementById('migrateBtn');
    const prog = document.getElementById('migrateProgress');
    const fill = document.getElementById('migrateFill');
    const statusEl = document.getElementById('migrateStatus');

    if (!confirm(`Move all vault files from:\n${_lastKnownOldRoot}\n\nTo:\n${newRoot}\n\nThis may take a while for large vaults.`)) return;

    btn.disabled = true;
    btn.textContent = '⏳ Migrating...';
    prog.style.display = 'block';
    fill.style.width = '30%';
    statusEl.textContent = 'Copying files...';

    try {
        const result = await api('/api/settings/migrate-vault', {
            method: 'POST',
            body: { oldRoot: _lastKnownOldRoot, newRoot },
        });

        fill.style.width = '100%';
        fill.style.background = '#7ab87a';
        statusEl.textContent = `✅ Done! ${result.filesCopied} files moved, ${result.pathsUpdated} paths updated.`;
        btn.textContent = '✅ Migration Complete';

        setTimeout(() => {
            document.getElementById('migrateSection').style.display = 'none';
            loadSettings();
        }, 3000);
    } catch (err) {
        fill.style.width = '100%';
        fill.style.background = '#b85c5c';
        statusEl.textContent = `❌ Error: ${err.message}`;
        btn.disabled = false;
        btn.textContent = '📦 Retry Migration';
    }
}

// ═══════════════════════════════════════════
//  WATCH FOLDERS
// ═══════════════════════════════════════════

async function addWatchFolder() {
    const pathInput = document.getElementById('newWatchPath');
    const folderPath = pathInput.value.trim();
    if (!folderPath) return;

    try {
        await api('/api/settings/watches', {
            method: 'POST',
            body: { path: folderPath, auto_import: true },
        });
        pathInput.value = '';
        loadSettings();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function removeWatch(id) {
    try {
        await api(`/api/settings/watches/${id}`, { method: 'DELETE' });
        loadSettings();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  FOLDER PICKER
// ═══════════════════════════════════════════
let fpTargetInput = null;
let fpCurrentDir = '';

export function openFolderPicker(inputId) {
    fpTargetInput = inputId;
    const currentVal = document.getElementById(inputId)?.value?.trim() || '';
    fpCurrentDir = '';
    document.getElementById('fpSelectedPath').value = currentVal;
    document.getElementById('folderPickerModal').style.display = 'flex';
    fpNavigate(currentVal || '');
}

function closeFolderPicker() {
    document.getElementById('folderPickerModal').style.display = 'none';
    fpTargetInput = null;
}

function confirmFolderPicker() {
    const selected = document.getElementById('fpSelectedPath').value;
    if (fpTargetInput && selected) {
        document.getElementById(fpTargetInput).value = selected;
    }
    closeFolderPicker();
}

async function fpNavigate(dir) {
    fpCurrentDir = dir;
    document.getElementById('fpSelectedPath').value = dir;

    const pathBar = document.getElementById('fpCurrentPath');
    pathBar.textContent = dir || 'Drives';

    const container = document.getElementById('fpEntries');
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">Loading...</div>';

    try {
        const url = dir ? `/api/assets/browse?dir=${encodeURIComponent(dir)}&folders_only=1` : '/api/assets/browse?folders_only=1';
        const data = await api(url);

        let html = '';

        if (data.parent || dir) {
            const parentPath = data.parent || '';
            html += `<div class="fp-entry fp-entry-up" ondblclick="fpNavigate('${escAttr(parentPath)}')">
                <span class="fp-icon">⬆️</span>
                <span class="fp-name">..</span>
            </div>`;
        }

        for (const entry of data.entries) {
            if (!entry.isDirectory) continue;
            html += `<div class="fp-entry" onclick="fpSelectEntry('${escAttr(entry.path)}')" ondblclick="fpNavigate('${escAttr(entry.path)}')">
                <span class="fp-icon">${entry.icon || '📁'}</span>
                <span class="fp-name">${esc(entry.name)}</span>
            </div>`;
        }

        if (!html) {
            html = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No subfolders</div>';
        }

        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<div style="padding:20px;text-align:center;color:#b85c5c;">Error: ${esc(err.message)}</div>`;
    }
}

function fpSelectEntry(path) {
    document.getElementById('fpSelectedPath').value = path;
    document.querySelectorAll('.fp-entry').forEach(el => el.classList.remove('fp-entry-selected'));
    event.currentTarget.classList.add('fp-entry-selected');
}

// ═══════════════════════════════════════════
//  ROLES MANAGEMENT
// ═══════════════════════════════════════════

export async function loadRoles() {
    try {
        const { state } = await import('./state.js');
        state.roles = await api('/api/roles');
        renderRolesList();
    } catch (err) {
        console.error('Failed to load roles:', err);
    }
}

function renderRolesList() {
    const { state } = { state: null };
    // Inline re-import is messy; just use the fetched data from the API call
    const list = document.getElementById('rolesList');
    if (!list) return;

    api('/api/roles').then(roles => {
        if (roles.length === 0) {
            list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;padding:8px;">No roles defined. Add some below.</div>';
            return;
        }
        list.innerHTML = roles.map(r => `
            <div class="role-item" data-role-id="${r.id}">
                <span class="role-icon">${r.icon}</span>
                <input type="color" class="role-color-swatch" value="${r.color}" title="Change color"
                    onchange="updateRoleColor(${r.id}, this.value)">
                <span class="role-name" ondblclick="startRoleRename(${r.id}, this)">${esc(r.name)}</span>
                <span class="role-code">${esc(r.code)}</span>
                <button class="role-delete" onclick="deleteRole(${r.id}, '${esc(r.name).replace(/'/g, "\\'")}')" title="Delete role">✕</button>
            </div>
        `).join('');
    });
}

async function addRole() {
    const nameInput = document.getElementById('newRoleName');
    const colorInput = document.getElementById('newRoleColor');
    const name = nameInput.value.trim();
    if (!name) return;

    const code = name.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10);
    const color = colorInput.value;

    try {
        await api('/api/roles', {
            method: 'POST',
            body: { name, code, color, icon: '🎭' }
        });
        nameInput.value = '';
        await loadRoles();
        showToast(`Role "${name}" created`);
    } catch (err) {
        showToast('Error: ' + err.message, 4000);
    }
}

async function updateRoleColor(id, color) {
    try {
        await api(`/api/roles/${id}`, { method: 'PUT', body: { color } });
        showToast('Color updated');
    } catch (err) {
        showToast('Error: ' + err.message, 4000);
    }
}

function startRoleRename(id, el) {
    const current = el.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'role-rename-input';
    input.onblur = () => finishRoleRename(id, input, current);
    input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = current; input.blur(); }
    };
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
}

async function finishRoleRename(id, input, oldName) {
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
        input.parentElement.textContent = oldName;
        return;
    }
    try {
        const newCode = newName.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10);
        await api(`/api/roles/${id}`, { method: 'PUT', body: { name: newName, code: newCode } });
        await loadRoles();
        showToast(`Renamed to "${newName}"`);
    } catch (err) {
        input.parentElement.textContent = oldName;
        showToast('Rename failed: ' + err.message, 4000);
    }
}

async function deleteRole(id, name) {
    if (!confirm(`Delete role "${name}"?\n\nAssets tagged with this role will become untagged.`)) return;
    try {
        await api(`/api/roles/${id}`, { method: 'DELETE' });
        await loadRoles();
        showToast(`Role "${name}" deleted`);
    } catch (err) {
        showToast('Error: ' + err.message, 4000);
    }
}

// ═══════════════════════════════════════════
//  UPDATE CHECKER
// ═══════════════════════════════════════════

let _pendingUpdate = null;

/** Check GitHub stable branch for a newer version */
async function checkForUpdates(silent = false) {
    const btn = document.getElementById('btnCheckUpdate');
    const statusEl = document.getElementById('updateStatus');
    const applyBtn = document.getElementById('btnApplyUpdate');
    const changelogEl = document.getElementById('updateChangelog');

    if (btn) btn.disabled = true;
    if (btn) btn.textContent = '⏳ Checking...';

    try {
        const result = await api('/api/update/check?force=true');
        _pendingUpdate = result;

        if (result.error) {
            if (!silent) {
                if (statusEl) {
                    statusEl.style.display = 'block';
                    statusEl.style.background = 'rgba(255, 82, 82, 0.15)';
                    statusEl.style.border = '1px solid rgba(255, 82, 82, 0.3)';
                    statusEl.innerHTML = `⚠️ Couldn't check for updates: ${esc(result.error)}`;
                }
            }
            return;
        }

        if (result.hasUpdate) {
            // ── Settings tab UI (if visible) ──
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.background = 'rgba(0, 255, 136, 0.1)';
                statusEl.style.border = '1px solid rgba(0, 255, 136, 0.3)';
                statusEl.innerHTML = `🎉 <strong>Update available!</strong> v${esc(result.currentVersion)} → v${esc(result.remoteVersion)}`;
            }
            if (applyBtn) applyBtn.style.display = 'inline-block';
            if (result.changelog && changelogEl) {
                changelogEl.style.display = 'block';
                changelogEl.textContent = result.changelog;
            } else if (changelogEl) {
                changelogEl.style.display = 'none';
            }

            // ── Persistent banner on ANY tab ──
            const dismissed = sessionStorage.getItem('dmv_update_dismissed');
            if (dismissed !== result.remoteVersion) {
                showUpdateBanner(result);
            }
        } else {
            if (!silent) {
                if (statusEl) {
                    statusEl.style.display = 'block';
                    statusEl.style.background = 'rgba(136, 136, 136, 0.1)';
                    statusEl.style.border = '1px solid rgba(136, 136, 136, 0.2)';
                    statusEl.innerHTML = `✅ You're on the latest version (v${esc(result.currentVersion)})`;
                }
                if (applyBtn) applyBtn.style.display = 'none';
                if (changelogEl) changelogEl.style.display = 'none';
            }
        }
    } catch (err) {
        if (!silent) {
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.background = 'rgba(255, 82, 82, 0.15)';
                statusEl.style.border = '1px solid rgba(255, 82, 82, 0.3)';
                statusEl.innerHTML = `⚠️ Update check failed: ${esc(err.message)}`;
            }
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🔄 Check for Updates';
        }
    }
}

// ═══════════════════════════════════════════
//  PERSISTENT UPDATE BANNER (any tab)
// ═══════════════════════════════════════════

function showUpdateBanner(updateInfo) {
    const banner = document.getElementById('updateBanner');
    const versionSpan = document.getElementById('updateBannerVersion');
    if (!banner) return;
    versionSpan.textContent = `v${updateInfo.currentVersion} → v${updateInfo.remoteVersion}`;
    banner.style.display = 'flex';
}

function dismissUpdateBanner() {
    const banner = document.getElementById('updateBanner');
    if (banner) banner.style.display = 'none';
    // Don't set sessionStorage here — just hides banner. "Later" in modal sets it.
}

// ═══════════════════════════════════════════
//  UPDATE MODAL
// ═══════════════════════════════════════════

function showUpdateModal() {
    if (!_pendingUpdate || !_pendingUpdate.hasUpdate) return;

    const modal = document.getElementById('updateModal');
    document.getElementById('updateModalCurrent').textContent = `v${_pendingUpdate.currentVersion}`;
    document.getElementById('updateModalNew').textContent = `v${_pendingUpdate.remoteVersion}`;
    document.getElementById('updateModalChangelog').textContent = _pendingUpdate.changelog || 'No changelog available.';

    const statusEl = document.getElementById('updateModalStatus');
    statusEl.style.display = 'none';
    statusEl.textContent = '';

    const applyBtn = document.getElementById('btnUpdateModalApply');
    applyBtn.disabled = false;
    applyBtn.textContent = '⬇️ Update Now';

    modal.style.display = 'flex';
}

function closeUpdateModal() {
    document.getElementById('updateModal').style.display = 'none';
}

function dismissUpdateLater() {
    if (_pendingUpdate && _pendingUpdate.remoteVersion) {
        sessionStorage.setItem('dmv_update_dismissed', _pendingUpdate.remoteVersion);
    }
    closeUpdateModal();
    dismissUpdateBanner();
    showToast('Update reminder dismissed for this session', 3000);
}

/** Apply update from the modal (same backend call, different UI target) */
async function applyUpdateFromModal() {
    const statusEl = document.getElementById('updateModalStatus');
    const applyBtn = document.getElementById('btnUpdateModalApply');

    applyBtn.disabled = true;
    applyBtn.textContent = '⏳ Updating...';
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--warning)';
    statusEl.textContent = '⬇️ Downloading update...';

    try {
        const result = await api('/api/update/apply', { method: 'POST' });
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = `✅ ${result.message || 'Updated!'} Waiting for restart...`;
        setTimeout(() => pollForRestartModal(), 3000);
    } catch (err) {
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
            statusEl.style.color = 'var(--warning)';
            statusEl.textContent = '🔄 Server restarting...';
            setTimeout(() => pollForRestartModal(), 3000);
        } else {
            statusEl.style.color = 'var(--danger)';
            statusEl.textContent = `❌ Update failed: ${err.message}`;
            applyBtn.disabled = false;
            applyBtn.textContent = '⬇️ Update Now';
        }
    }
}

function pollForRestartModal(attempts = 0) {
    const statusEl = document.getElementById('updateModalStatus');
    if (attempts > 30) {
        statusEl.style.color = 'var(--warning)';
        statusEl.textContent = '⚠️ Server taking too long. Try refreshing the page manually.';
        return;
    }

    fetch('/api/update/health')
        .then(r => r.json())
        .then(data => {
            statusEl.style.color = 'var(--success)';
            statusEl.textContent = `✅ Updated to v${data.version}! Reloading...`;
            setTimeout(() => window.location.reload(), 1000);
        })
        .catch(() => {
            statusEl.style.color = 'var(--text-dim)';
            statusEl.textContent = `🔄 Server restarting... (${attempts + 1}s)`;
            setTimeout(() => pollForRestartModal(attempts + 1), 2000);
        });
}

/** Download and apply the update from Settings tab, then poll for server restart */
async function applyUpdate() {
    const statusEl = document.getElementById('updateStatus');
    const applyBtn = document.getElementById('btnApplyUpdate');
    const checkBtn = document.getElementById('btnCheckUpdate');

    if (!confirm('Apply update now?\n\nThe server will restart briefly. Your data is safe.')) return;

    if (applyBtn) applyBtn.disabled = true;
    if (applyBtn) applyBtn.textContent = '⏳ Updating...';
    if (checkBtn) checkBtn.disabled = true;

    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(255, 170, 0, 0.15)';
        statusEl.style.border = '1px solid rgba(255, 170, 0, 0.3)';
        statusEl.innerHTML = '⬇️ Downloading update...';
    }

    try {
        const result = await api('/api/update/apply', { method: 'POST' });
        if (statusEl) statusEl.innerHTML = `✅ ${esc(result.message || 'Updated!')} Waiting for restart...`;
        setTimeout(() => pollForRestart(), 3000);
    } catch (err) {
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
            if (statusEl) statusEl.innerHTML = '🔄 Server restarting...';
            setTimeout(() => pollForRestart(), 3000);
        } else {
            if (statusEl) {
                statusEl.style.background = 'rgba(255, 82, 82, 0.15)';
                statusEl.style.border = '1px solid rgba(255, 82, 82, 0.3)';
                statusEl.innerHTML = `❌ Update failed: ${esc(err.message)}`;
            }
            if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = '⬇️ Update Now'; }
            if (checkBtn) checkBtn.disabled = false;
        }
    }
}

/** Poll server until it's back up after restart */
function pollForRestart(attempts = 0) {
    const statusEl = document.getElementById('updateStatus');
    if (attempts > 30) {
        if (statusEl) statusEl.innerHTML = '⚠️ Server taking too long to restart. Try refreshing the page manually.';
        return;
    }

    fetch('/api/update/health')
        .then(r => r.json())
        .then(data => {
            if (statusEl) {
                statusEl.style.background = 'rgba(0, 255, 136, 0.15)';
                statusEl.style.border = '1px solid rgba(0, 255, 136, 0.3)';
                statusEl.innerHTML = `✅ Updated to v${data.version}! Reloading...`;
            }
            setTimeout(() => window.location.reload(), 1000);
        })
        .catch(() => {
            if (statusEl) statusEl.innerHTML = `🔄 Server restarting... (${attempts + 1}s)`;
            setTimeout(() => pollForRestart(attempts + 1), 2000);
        });
}

/** Auto-check on app load (silent — shows banner if update available) */
export function autoCheckForUpdates() {
    setTimeout(() => checkForUpdates(true), 5000);
}

// ═══════════════════════════════════════════
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ═══════════════════════════════════════════

window.loadSettings = loadSettings;
window.saveSettings = saveSettings;
window.migrateVault = migrateVault;
window.addWatchFolder = addWatchFolder;
window.removeWatch = removeWatch;
window.openFolderPicker = openFolderPicker;
window.closeFolderPicker = closeFolderPicker;
window.confirmFolderPicker = confirmFolderPicker;
window.fpNavigate = fpNavigate;
window.fpSelectEntry = fpSelectEntry;
window.addRole = addRole;
window.updateRoleColor = updateRoleColor;
window.startRoleRename = startRoleRename;
window.deleteRole = deleteRole;
window.loadRoles = loadRoles;
window.checkForUpdates = checkForUpdates;
window.applyUpdate = applyUpdate;
window.showUpdateModal = showUpdateModal;
window.closeUpdateModal = closeUpdateModal;
window.dismissUpdateLater = dismissUpdateLater;
window.dismissUpdateBanner = dismissUpdateBanner;
window.applyUpdateFromModal = applyUpdateFromModal;
