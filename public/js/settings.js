/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV - Settings Module
 * Settings tab, vault migration, watch folders, folder picker.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, escAttr, showToast } from './utils.js';
import pluginRegistry from './pluginRegistry.js';

// ===========================================
//  SETTINGS
// ===========================================

export async function loadSettings() {
    try {
        state.settings = await api('/api/settings');
        const status = await api('/api/settings/status');

        document.getElementById('settingVaultRoot').value = state.settings.vault_root || '';
        document.getElementById('settingNamingTemplate').value = state.settings.naming_template || '';
        document.getElementById('settingThumbSize').value = state.settings.thumbnail_size || '320';
        document.getElementById('settingAutoThumb').checked = state.settings.auto_thumbnail !== 'false';


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
                <div>FFmpeg: ${status.ffmpegAvailable ? '<span style="color:var(--success)">Success: Available</span>' : '<span style="color:var(--danger)">Error: Not found</span>'}</div>
                <div>Vault: ${status.vaultConfigured ? '<span style="color:var(--success)">Success: Configured</span>' : '<span style="color:var(--warning)">Warning: Not configured</span>'}</div>
            </div>
        `;

        // Watch folders
        const watches = await api('/api/settings/watches');
        document.getElementById('watchFolderList').innerHTML = watches.map(w => {
            const folderName = w.path.split(/[\\/]/).filter(Boolean).pop() || w.path;
            return `
            <div class="watch-item">
                <span> <strong>${esc(folderName)}</strong> ${w.project_name ? `-> ${esc(w.project_name)}` : '<em style="color:var(--text-muted)">(no project)</em>'}</span>
                <span style="color:var(--text-dim);font-size:0.75rem;">${esc(w.path)}</span>
                <button onclick="removeWatch(${w.id})" title="Remove">x</button>
            </div>`;
        }).join('') || '<div style="color:var(--text-muted);font-size:0.8rem;">No watch folders configured.</div>';

        // Populate watch folder project dropdown
        const watchProjectSel = document.getElementById('newWatchProject');
        if (watchProjectSel) {
            const projects = await api('/api/projects');
            watchProjectSel.innerHTML = '<option value="">-- Project --</option>' +
                projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
        }

        // Check if files need migration to new vault root
        const vaultRoot = state.settings.vault_root;
        if (vaultRoot && status.assets > 0) {
            checkMigrationNeeded(vaultRoot);
        }

        // Load shared database config
        loadDbConfig();

        // Load preferences
        loadPrefs();

        // Load team users
        loadTeamSettings();

        // Load GitHub token status
        loadGithubTokenStatus();

        // Inject plugin settings HTML and populate their values
        pluginRegistry.injectSettingsSections();
        await pluginRegistry.loadPluginSettings(state.settings);
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

        default_player: document.getElementById('settingDefaultPlayer').value,
        custom_player_path: document.getElementById('settingCustomPlayerPath').value.trim(),
        rv_path: document.getElementById('settingRvPath').value.trim(),
        // Merge plugin settings values
        ...pluginRegistry.getPluginSettingsValues(),
    };

    try {
        await api('/api/settings', { method: 'POST', body: updates });
        loadSettings();
    } catch (err) {
        alert('Error saving: ' + err.message);
    }
}

// ===========================================
//  VAULT MIGRATION
// ===========================================

// ===========================================
//  VAULT MIGRATION
// ===========================================

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
    btn.textContent = 'Wait: Migrating...';
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
        statusEl.textContent = `Success: Done! ${result.filesCopied} files moved, ${result.pathsUpdated} paths updated.`;
        btn.textContent = 'Success: Migration Complete';

        setTimeout(() => {
            document.getElementById('migrateSection').style.display = 'none';
            loadSettings();
        }, 3000);
    } catch (err) {
        fill.style.width = '100%';
        fill.style.background = '#b85c5c';
        statusEl.textContent = `Error: Error: ${err.message}`;
        btn.disabled = false;
        btn.textContent = 'Retry Migration';
    }
}

// ===========================================
//  SHARED DATABASE
// ===========================================

async function loadDbConfig() {
    const statusEl = document.getElementById('sharedDbStatus');
    const input = document.getElementById('settingSharedDbPath');
    if (!statusEl || !input) return;

    try {
        const cfg = await api('/api/settings/db-config');
        input.value = cfg.shared_db_path || '';

        if (cfg.is_shared) {
            const accessible = cfg.shared_accessible;
            statusEl.innerHTML = `
                <span style="color:${accessible ? 'var(--success)' : 'var(--danger)'};">
                    ${accessible ? 'Success: Shared' : 'Error: Unreachable'}
                </span>
                - <code style="font-size:0.78rem;">${esc(cfg.active_db_path)}</code>
                <span style="color:var(--text-dim);margin-left:6px;">(${esc(cfg.hostname)})</span>
            `;
        } else {
            statusEl.innerHTML = `<span style="color:var(--text-dim);">Using local database</span>`;
        }
    } catch (err) {
        statusEl.innerHTML = `<span style="color:var(--danger);">Error loading config</span>`;
    }
}

async function saveSharedDbPath() {
    const input = document.getElementById('settingSharedDbPath');
    const statusEl = document.getElementById('sharedDbStatus');
    const newPath = input.value.trim();

    statusEl.innerHTML = '<span style="color:var(--text-muted);">Saving...</span>';

    try {
        const result = await api('/api/settings/db-config', {
            method: 'POST',
            body: { shared_db_path: newPath },
        });

        if (!newPath) {
            statusEl.innerHTML = '<span style="color:var(--success);">Success: Cleared - using local database. Restart the app to apply.</span>';
        } else {
            statusEl.innerHTML = `<span style="color:var(--success);">Success: Saved! Restart the app to switch to shared database.</span>`;
        }
    } catch (err) {
        statusEl.innerHTML = `<span style="color:var(--danger);">Error: ${esc(err.message)}</span>`;
    }
}

// ===========================================
//  WATCH FOLDERS
// ===========================================

async function addWatchFolder() {
    const pathInput = document.getElementById('newWatchPath');
    const projectSel = document.getElementById('newWatchProject');
    const folderPath = pathInput.value.trim();
    if (!folderPath) return;

    const projectId = projectSel?.value ? parseInt(projectSel.value) : null;

    try {
        await api('/api/settings/watches', {
            method: 'POST',
            body: { path: folderPath, project_id: projectId, auto_import: true },
        });
        pathInput.value = '';
        if (projectSel) projectSel.value = '';
        loadSettings();
        showToast('Watch folder added', 'success');
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

// ===========================================
//  FOLDER PICKER
// ===========================================
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
                <span class="fp-icon">Up</span>
                <span class="fp-name">..</span>
            </div>`;
        }

        // Group entries: network drives first (with header), then the rest
        const networkDrives = data.entries.filter(e => e.isDirectory && e.driveType === 'network');
        const otherEntries = data.entries.filter(e => e.isDirectory && e.driveType !== 'network');

        if (networkDrives.length > 0 && !dir) {
            html += `<div class="fp-section-header" style="padding:6px 12px;font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid var(--border-color, #333);">Network Drives</div>`;
            for (const entry of networkDrives) {
                const subtitle = entry.server ? `<span class="fp-subtitle" style="font-size:0.72rem;color:var(--text-muted);margin-left:8px;">${esc(entry.server)}</span>` : '';
                html += `<div class="fp-entry fp-entry-network" onclick="fpSelectEntry('${escAttr(entry.path)}')" ondblclick="fpNavigate('${escAttr(entry.path)}')" style="background:rgba(59,130,246,0.06);">
                    <span class="fp-icon">${entry.icon || ''}</span>
                    <span class="fp-name">${esc(entry.name)}${subtitle}</span>
                </div>`;
            }
            if (otherEntries.length > 0) {
                html += `<div class="fp-section-header" style="padding:6px 12px;font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid var(--border-color, #333);">Local</div>`;
            }
        }

        for (const entry of (networkDrives.length > 0 && !dir ? otherEntries : data.entries.filter(e => e.isDirectory))) {
            html += `<div class="fp-entry" onclick="fpSelectEntry('${escAttr(entry.path)}')" ondblclick="fpNavigate('${escAttr(entry.path)}')">
                <span class="fp-icon">${entry.icon || '[Folder]'}</span>
                <span class="fp-name">${esc(entry.name)}</span>
            </div>`;
        }

        if (!html || (!networkDrives.length && !otherEntries.length && !data.entries.some(e => e.isDirectory))) {
            html += '<div style="padding:20px;text-align:center;color:var(--text-muted);">No subfolders</div>';
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

async function fpNewFolder() {
    if (!fpCurrentDir) {
        showToast('Navigate into a drive or folder first', 'error');
        return;
    }

    const name = prompt('New folder name:');
    if (!name || !name.trim()) return;

    try {
        const result = await api('/api/assets/create-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentDir: fpCurrentDir, folderName: name.trim() })
        });

        if (result.success) {
            showToast(`Created folder: ${result.name}`, 'success');
            // Navigate into the new folder
            fpNavigate(result.path);
        }
    } catch (err) {
        showToast('Failed to create folder: ' + err.message, 'error');
    }
}

// ===========================================
//  ROLES MANAGEMENT
// ===========================================

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
                <button class="role-delete" onclick="deleteRole(${r.id}, '${esc(r.name).replace(/'/g, "\\'")}')" title="Delete role">x</button>
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
            body: { name, code, color, icon: '' }
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

// ===========================================
//  PREFERENCES
// ===========================================

/** Load preferences into the Settings UI */
function loadPrefs() {
    const s = state.settings || {};
    const startTab = document.getElementById('prefStartTab');
    const defaultView = document.getElementById('prefDefaultView');
    const confirmDelete = document.getElementById('prefConfirmDelete');
    const autoUpdate = document.getElementById('prefAutoUpdate');

    if (startTab) startTab.value = s.start_tab || 'projects';
    if (defaultView) defaultView.value = s.default_view || 'grid';
    if (confirmDelete) confirmDelete.checked = s.confirm_delete !== 'false';
    if (autoUpdate) autoUpdate.checked = s.auto_check_updates !== 'false';
}

/** Save a single preference to theServer */
async function savePref(key, value) {
    try {
        await api('/api/settings', {
            method: 'POST',
            body: { [key]: value }
        });
        // Update local state so other code can read it immediately
        state.settings[key] = value;
        showToast('Preference saved', 2000);
    } catch (err) {
        showToast('Failed to save preference: ' + err.message, 4000);
    }
}

// ===========================================
//  GITHUB TOKEN (private repo auto-updates)
// ===========================================

/** Load current GitHub token status (never returns actual token) */
async function loadGithubTokenStatus() {
    try {
        const res = await fetch('/api/settings/github-token');
        const data = await res.json();
        const statusEl = document.getElementById('githubTokenStatus');
        if (!statusEl) return;
        if (data.configured) {
            statusEl.innerHTML = `<span style="color:var(--success);">Success: Token configured</span> <span style="opacity:0.6">(${data.masked})</span>`;
        } else {
            statusEl.innerHTML = '<span style="opacity:0.6">No token - update checks require a public repo or a PAT.</span>';
        }
    } catch (err) {
        console.error('[Settings] Failed to load GitHub token status:', err);
    }
}

/** Save GitHub PAT toServer config */
async function saveGithubToken() {
    const input = document.getElementById('githubPatInput');
    const token = input?.value?.trim();
    if (!token) {
        showToast('Enter a GitHub Personal Access Token first.', 3000);
        return;
    }
    try {
        const res = await fetch('/api/settings/github-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Success: GitHub token saved!', 3000);
            input.value = ''; // Clear input after save
            loadGithubTokenStatus();
        } else {
            showToast('Failed: ' + (data.error || 'Unknown error'), 4000);
        }
    } catch (err) {
        showToast('Error saving token: ' + err.message, 4000);
    }
}

/** Clear (remove) the stored GitHub PAT */
async function clearGithubToken() {
    try {
        const res = await fetch('/api/settings/github-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: '' })
        });
        const data = await res.json();
        if (data.success) {
            showToast('GitHub token removed.', 3000);
            loadGithubTokenStatus();
        }
    } catch (err) {
        showToast('Error clearing token: ' + err.message, 4000);
    }
}

// ===========================================
//  UPDATE CHECKER
// ===========================================

let _pendingUpdate = null;

/** Check GitHub stable branch for a newer version */
async function checkForUpdates(silent = false) {
    const btn = document.getElementById('btnCheckUpdate');
    const statusEl = document.getElementById('updateStatus');
    const applyBtn = document.getElementById('btnApplyUpdate');
    const changelogEl = document.getElementById('updateChangelog');

    if (btn) btn.disabled = true;
    if (btn) btn.textContent = 'Wait: Checking...';

    try {
        const result = await api('/api/update/check?force=true');
        _pendingUpdate = result;

        if (result.error) {
            if (!silent) {
                if (statusEl) {
                    statusEl.style.display = 'block';
                    statusEl.style.background = 'rgba(255, 82, 82, 0.15)';
                    statusEl.style.border = '1px solid rgba(255, 82, 82, 0.3)';
                    statusEl.innerHTML = `Warning: Couldn'tCheck for Updates: ${esc(result.error)}`;
                }
            }
            return;
        }

        if (result.hasUpdate) {
            //  Settings tab UI (if visible) 
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.background = 'rgba(0, 255, 136, 0.1)';
                statusEl.style.border = '1px solid rgba(0, 255, 136, 0.3)';
                statusEl.innerHTML = `<strong>Update available!</strong> v${esc(result.currentVersion)} -> v${esc(result.remoteVersion)}`;
            }
            if (applyBtn) applyBtn.style.display = 'inline-block';
            if (result.changelog && changelogEl) {
                changelogEl.style.display = 'block';
                changelogEl.textContent = result.changelog;
            } else if (changelogEl) {
                changelogEl.style.display = 'none';
            }

            //  Persistent banner on ANY tab 
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
                    statusEl.innerHTML = `Success: You're on the latest version (v${esc(result.currentVersion)})`;
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
                statusEl.innerHTML = `Warning: Update check failed: ${esc(err.message)}`;
            }
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'RetryCheck for Updates';
        }
    }
}

// ===========================================
//  PERSISTENT UPDATE BANNER (any tab)
// ===========================================

function showUpdateBanner(updateInfo) {
    const banner = document.getElementById('updateBanner');
    const versionSpan = document.getElementById('updateBannerVersion');
    if (!banner) return;
    versionSpan.textContent = `v${updateInfo.currentVersion} -> v${updateInfo.remoteVersion}`;
    banner.style.display = 'flex';
}

function dismissUpdateBanner() {
    const banner = document.getElementById('updateBanner');
    if (banner) banner.style.display = 'none';
    // Don't set sessionStorage here - just hides banner. "Later" in modal sets it.
}

// ===========================================
//  UPDATE MODAL
// ===========================================

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
    applyBtn.textContent = 'Update Now';

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
    applyBtn.textContent = 'Wait: Updating...';
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--warning)';
    statusEl.textContent = 'Downloading update...';

    try {
        const result = await api('/api/update/apply', { method: 'POST' });
        statusEl.style.color = 'var(--success)';
        statusEl.textContent = `Success: ${result.message || 'Updated!'} Waiting for restart...`;
        setTimeout(() => pollForRestartModal(), 3000);
    } catch (err) {
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
            statusEl.style.color = 'var(--warning)';
            statusEl.textContent = 'RetryServer restarting...';
            setTimeout(() => pollForRestartModal(), 3000);
        } else {
            statusEl.style.color = 'var(--danger)';
            statusEl.textContent = `Error: Update failed: ${err.message}`;
            applyBtn.disabled = false;
            applyBtn.textContent = 'Update Now';
        }
    }
}

function pollForRestartModal(attempts = 0) {
    const statusEl = document.getElementById('updateModalStatus');
    if (attempts > 30) {
        statusEl.style.color = 'var(--warning)';
        statusEl.textContent = 'Warning:Server taking too long. Try refreshing the page manually.';
        return;
    }

    fetch('/api/update/health')
        .then(r => r.json())
        .then(data => {
            statusEl.style.color = 'var(--success)';
            statusEl.textContent = `Success: Updated to v${data.version}! Reloading...`;
            setTimeout(() => window.location.reload(), 1000);
        })
        .catch(() => {
            statusEl.style.color = 'var(--text-dim)';
            statusEl.textContent = `RetryServer restarting... (${attempts + 1}s)`;
            setTimeout(() => pollForRestartModal(attempts + 1), 2000);
        });
}

/** Download and apply the update from Settings tab, then poll forServer restart */
async function applyUpdate() {
    const statusEl = document.getElementById('updateStatus');
    const applyBtn = document.getElementById('btnApplyUpdate');
    const checkBtn = document.getElementById('btnCheckUpdate');

    if (!confirm('Apply update now?\n\nTheServer will restart briefly. Your data is safe.')) return;

    if (applyBtn) applyBtn.disabled = true;
    if (applyBtn) applyBtn.textContent = 'Wait: Updating...';
    if (checkBtn) checkBtn.disabled = true;

    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(255, 170, 0, 0.15)';
        statusEl.style.border = '1px solid rgba(255, 170, 0, 0.3)';
        statusEl.innerHTML = 'Downloading update...';
    }

    try {
        const result = await api('/api/update/apply', { method: 'POST' });
        if (statusEl) statusEl.innerHTML = `Success: ${esc(result.message || 'Updated!')} Waiting for restart...`;
        setTimeout(() => pollForRestart(), 3000);
    } catch (err) {
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
            if (statusEl) statusEl.innerHTML = 'RetryServer restarting...';
            setTimeout(() => pollForRestart(), 3000);
        } else {
            if (statusEl) {
                statusEl.style.background = 'rgba(255, 82, 82, 0.15)';
                statusEl.style.border = '1px solid rgba(255, 82, 82, 0.3)';
                statusEl.innerHTML = `Error: Update failed: ${esc(err.message)}`;
            }
            if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Update Now'; }
            if (checkBtn) checkBtn.disabled = false;
        }
    }
}

/** PollServer until it's back up after restart */
function pollForRestart(attempts = 0) {
    const statusEl = document.getElementById('updateStatus');
    if (attempts > 30) {
        if (statusEl) statusEl.innerHTML = 'Warning:Server taking too long to restart. Try refreshing the page manually.';
        return;
    }

    fetch('/api/update/health')
        .then(r => r.json())
        .then(data => {
            if (statusEl) {
                statusEl.style.background = 'rgba(0, 255, 136, 0.15)';
                statusEl.style.border = '1px solid rgba(0, 255, 136, 0.3)';
                statusEl.innerHTML = `Success: Updated to v${data.version}! Reloading...`;
            }
            setTimeout(() => window.location.reload(), 1000);
        })
        .catch(() => {
            if (statusEl) statusEl.innerHTML = `RetryServer restarting... (${attempts + 1}s)`;
            setTimeout(() => pollForRestart(attempts + 1), 2000);
        });
}

/** Auto-check on app load (silent - shows banner if update available) */
export function autoCheckForUpdates() {
    setTimeout(() => checkForUpdates(true), 5000);
}

// ===========================================
//  NETWORK /Server DISCOVERY
// ===========================================

let _serverPanelOpen = false;

export function toggleServerPanel() {
    _serverPanelOpen = !_serverPanelOpen;
    const panel = document.getElementById('serverPanel');
    if (!panel) return;
    panel.style.display = _serverPanelOpen ? 'flex' : 'none';
    if (_serverPanelOpen) {
        loadServerInfo();
        loadSavedServers();
    }
}

// Close panel when clicking outside
document.addEventListener('click', (e) => {
    if (!_serverPanelOpen) return;
    const panel = document.getElementById('serverPanel');
    const btn = document.getElementById('networkBtn');
    if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
        _serverPanelOpen = false;
        panel.style.display = 'none';
    }
});

async function loadServerInfo() {
    try {
        const info = await api('/api/servers/info');
        const nameEl = document.getElementById('serverLocalName');
        if (nameEl) nameEl.textContent = info.name || info.hostname;

        // Update settings section too
        const nameInput = document.getElementById('serverNameInput');
        if (nameInput && !nameInput.value) nameInput.value = info.name || '';

        const addrsEl = document.getElementById('serverAddresses');
        if (addrsEl && info.ip) {
            addrsEl.innerHTML = info.ip
                .map(ip => `<a href="http://${ip}:${info.port}" target="_blank" style="color:var(--accent);text-decoration:none;">http://${ip}:${info.port}</a>`)
                .join('<br>');
        }
    } catch (err) {
        console.error('[Network] Failed to loadServer info:', err);
    }
}

async function scanForServers() {
    const btn = document.getElementById('serverScanBtn');
    const list = document.getElementById('serverDiscoveredList');
    if (!list) return;

    if (btn) { btn.classList.add('scanning'); btn.textContent = 'Wait: Scanning...'; }
    list.innerHTML = '<div class="server-list-empty">Scanning network...</div>';

    try {
        const data = await api('/api/servers/discover?timeout=3000');
        constServers = data.servers || [];

        if (servers.length === 0) {
            list.innerHTML = '<div class="server-list-empty">No other instances found on this network</div>';
        } else {
            // Show green dot on network button
            document.getElementById('networkBtn')?.classList.add('has-servers');

            list.innerHTML =Servers.map((s, i) => `
                <div class="server-card" ondblclick="window.open('${esc(s.url)}','_blank')">
                    <span class="server-dotServer-dot-active"></span>
                    <div class="server-card-info">
                        <div class="server-card-name">${esc(s.name || s.hostname)}</div>
                        <div class="server-card-meta">${esc(s.ip)}:${s.port} . ${s.assets} assets . ${platformLabel(s.platform)} . v${esc(s.version)}</div>
                    </div>
                    <div class="server-card-actions">
                        <button class="btn-open" onclick="window.open('${esc(s.url)}','_blank')">Open</button>
                        <button onclick="saveDiscoveredServer(${i})">Save</button>
                    </div>
                </div>
            `).join('');
        }

        window._discoveredServers =Servers;
    } catch (err) {
        list.innerHTML = `<div class="server-list-empty" style="color:#e57373;">Scan failed: ${esc(err.message)}</div>`;
    }

    if (btn) { btn.classList.remove('scanning'); btn.textContent = 'Scan Scan'; }
}

function platformLabel(p) {
    if (p === 'win32') return 'Win Windows';
    if (p === 'darwin') return 'Mac Mac';
    if (p === 'linux') return 'Linux Linux';
    return p || 'Unknown';
}

async function saveDiscoveredServer(index) {
    const s = window._discoveredServers?.[index];
    if (!s) return;
    try {
        await api('/api/servers/save', {
            method: 'POST',
            body: { name: s.name || s.hostname, url: s.url }
        });
        showToast(`Saved ${s.name || s.hostname}`);
        loadSavedServers();
    } catch (err) {
        showToast('Failed to save: ' + err.message);
    }
}

async function addServerManual() {
    const input = document.getElementById('serverAddUrl');
    const url = input?.value?.trim();
    if (!url) return;

    try {
        // Ping first to validate
        const ping = await api('/api/servers/ping', { method: 'POST', body: { url } });

        const name = ping.online ? (ping.name || ping.hostname || url) : url;
        await api('/api/servers/save', { method: 'POST', body: { name, url } });

        input.value = '';
        showToast(ping.online ? `Added ${name} (online)` : `Added ${url} (offline)`);
        loadSavedServers();
    } catch (err) {
        showToast('Failed: ' + err.message);
    }
}

async function loadSavedServers() {
    const list = document.getElementById('serverSavedList');
    if (!list) return;

    try {
        const data = await api('/api/servers/saved');
        constServers = data.servers || [];

        if (servers.length === 0) {
            list.innerHTML = '<div class="server-list-empty">No savedServers</div>';
            return;
        }

        // Ping eachServer in parallel for status
        const pings = await Promise.allSettled(
           Servers.map(s =>
                api('/api/servers/ping', { method: 'POST', body: { url: s.url } })
                    .catch(() => ({ online: false }))
            )
        );

        list.innerHTML =Servers.map((s, i) => {
            const ping = pings[i]?.value || { online: false };
            const dotClass = ping.online ? 'server-dot-active' : 'server-dot-offline';
            const statusText = ping.online ? `${ping.assets} assets . v${ping.version}` : 'Offline';

            return `
                <div class="server-card" ondblclick="window.open('${esc(s.url)}','_blank')">
                    <span class="server-dot ${dotClass}"></span>
                    <div class="server-card-info">
                        <div class="server-card-name">${esc(s.name)}</div>
                        <div class="server-card-meta">${esc(s.url)} . ${statusText}</div>
                    </div>
                    <div class="server-card-actions">
                        ${ping.online ? `<button class="btn-open" onclick="window.open('${esc(s.url)}','_blank')">Open</button>` : ''}
                        <button onclick="removeSavedServer(${i})">x</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        list.innerHTML = '<div class="server-list-empty">Failed to load savedServers</div>';
    }
}

async function removeSavedServer(index) {
    try {
        await api(`/api/servers/saved/${index}`, { method: 'DELETE' });
        loadSavedServers();
    } catch (err) {
        showToast('Failed to remove: ' + err.message);
    }
}

async function saveServerName() {
    const input = document.getElementById('serverNameInput');
    const name = input?.value?.trim();
    if (!name) return;
    try {
        await api('/api/servers/name', { method: 'POST', body: { name } });
        showToast('Server name saved');
        loadServerInfo();
    } catch (err) {
        showToast('Failed: ' + err.message);
    }
}

// --- Path Mappings ---

async function loadPathMappings() {
    const list = document.getElementById('pathMappingList');
    if (!list) return;
    try {
        const data = await api('/api/servers/path-map');
        const mappings = data.mappings || [];
        if (mappings.length === 0) {
            list.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);padding:4px 0;">No path mappings configured</div>';
            return;
        }
        list.innerHTML = mappings.map((m, i) => `
            <div class="path-mapping-row">
                <span class="pm-from" title="${esc(m.from)}">${esc(m.from)}</span>
                <span class="pm-arrow">-></span>
                <span class="pm-to" title="${esc(m.to)}">${esc(m.to)}</span>
                <button class="pm-remove" onclick="removePathMapping(${i})" title="Remove">x</button>
            </div>
        `).join('');
    } catch {}
}

async function addPathMapping() {
    const fromEl = document.getElementById('pathMapFrom');
    const toEl = document.getElementById('pathMapTo');
    const from = fromEl?.value?.trim();
    const to = toEl?.value?.trim();
    if (!from || !to) return showToast('Both paths required');

    try {
        const data = await api('/api/servers/path-map');
        const mappings = data.mappings || [];
        mappings.push({ from, to });
        await api('/api/servers/path-map', { method: 'POST', body: { mappings } });
        fromEl.value = '';
        toEl.value = '';
        loadPathMappings();
        showToast('Path mapping added');
    } catch (err) {
        showToast('Failed: ' + err.message);
    }
}

async function removePathMapping(index) {
    try {
        const data = await api('/api/servers/path-map');
        const mappings = data.mappings || [];
        mappings.splice(index, 1);
        await api('/api/servers/path-map', { method: 'POST', body: { mappings } });
        loadPathMappings();
    } catch (err) {
        showToast('Failed: ' + err.message);
    }
}

// Load network settings when settings tab is opened
const _origLoadSettings = loadSettings;
// Augment loadSettings with network info (called from overridden export)
function loadNetworkSettings() {
    loadServerInfo();
    loadPathMappings();
    loadDbInfo();
    loadDiscoveredServersForPull();
    loadSyncConfig();
}

// ===========================================
//  DATABASE TRANSFER
// ===========================================

async function loadDbInfo() {
    try {
        const info = await api('/api/settings/db-info');
        const sizeKB = (info.fileSize / 1024).toFixed(0);
        const sizeMB = (info.fileSize / 1024 / 1024).toFixed(1);
        const sizeStr = info.fileSize > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
        const modified = info.modified ? new Date(info.modified).toLocaleString() : 'Unknown';
        const el = document.getElementById('dbInfo');
        if (el) {
            el.innerHTML = `
                <div>Projects: <strong>${info.projects}</strong> . Assets: <strong>${info.assets}</strong> . Sequences: <strong>${info.sequences}</strong> . Shots: <strong>${info.shots}</strong></div>
                <div>File size: <strong>${sizeStr}</strong> . Last modified: <strong>${modified}</strong></div>
            `;
        }
    } catch (err) {
        console.error('Failed to load DB info:', err);
    }
}

function exportDatabase() {
    // Direct download via browser
    window.location.href = '/api/settings/export-db';
    showToast('Database export started - check your Downloads folder', 'success');
}

async function importDatabase(input) {
    const file = input.files?.[0];
    if (!file) return;
    input.value = ''; // Reset so same file can be re-selected

    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    if (!confirm(`Import "${file.name}" (${sizeMB} MB)?\n\nThis will REPLACE your current database. A backup will be saved automatically.`)) {
        return;
    }

    try {
        showToast('Importing database...', 'info');
        const formData = new FormData();
        formData.append('database', file);

        const response = await fetch('/api/settings/import-db', {
            method: 'POST',
            body: formData,
        });
        const result = await response.json();

        if (!response.ok) {
            showToast(`Import failed: ${result.error}`, 'error');
            return;
        }

        showToast(`Success: ${result.message}`, 'success');
        // Reload the entire page to pick up new data
        setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
        showToast(`Import error: ${err.message}`, 'error');
    }
}

async function pullRemoteDatabase() {
    const urlInput = document.getElementById('pullDbUrl');
    const url = urlInput?.value?.trim();
    if (!url) {
        showToast('Enter the URL of a remote MediaVaultServer', 'error');
        return;
    }

    if (!confirm(`Pull database from ${url}?\n\nThis will REPLACE your current database with the remote one. A backup will be saved automatically.`)) {
        return;
    }

    try {
        showToast('Pulling database from remoteServer...', 'info');
        const result = await api('/api/settings/pull-db', {
            method: 'POST',
            body: { url },
        });
        showToast(`Success: ${result.message}`, 'success');
        setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
        showToast(`Pull failed: ${err.message}`, 'error');
    }
}

async function loadDiscoveredServersForPull() {
    const container = document.getElementById('discoveredServersForPull');
    if (!container) return;

    try {
        // Show saved/discoveredServers as quick-pick buttons
        const saved = await api('/api/servers/saved');
        const discovered = await api('/api/servers/discover');

        const allServers = [];
        const seenUrls = new Set();

        for (const s of [...(saved || []), ...(discovered || [])]) {
            const sUrl = s.url || s.address;
            if (sUrl && !seenUrls.has(sUrl)) {
                seenUrls.add(sUrl);
                allServers.push({ name: s.name || s.hostname || sUrl, url: sUrl });
            }
        }

        if (allServers.length === 0) {
            container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted);">No otherServers detected on network.</span>';
            return;
        }

        container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted);margin-right:6px;">Quick pick:</span>' +
            allServers.map(s =>
                `<button onclick="document.getElementById('pullDbUrl').value='${s.url}'" style="font-size:0.78rem;padding:3px 10px;margin:2px;border-radius:4px;background:var(--bg-dark);border:1px solid var(--border);color:var(--text);cursor:pointer;">${s.name}</button>`
            ).join('');
    } catch (err) {
        container.innerHTML = '';
    }
}
// Hook into settings load
const _settingsTabObserver = new MutationObserver(() => {
    const settingsTab = document.getElementById('tab-settings');
    if (settingsTab?.classList.contains('active')) {
        loadNetworkSettings();
    }
});
setTimeout(() => {
    const main = document.getElementById('mainContent');
    if (main) _settingsTabObserver.observe(main, { subtree: true, attributes: true, attributeFilter: ['class'] });
}, 1000);

// ===========================================
//  TEAM MANAGEMENT
// ===========================================

export async function loadTeamSettings() {
    const container = document.getElementById('teamUserList');
    if (!container) return;
    try {
        const users = await api('/api/users');
        if (users.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No users yet.</div>';
            return;
        }
        container.innerHTML = users.map(u => `
            <div class="team-user-row" style="border-left: 3px solid ${u.color || '#888'}">
                <span class="team-user-avatar">${u.name.substring(0, 2).toUpperCase()}</span>
                <span class="team-user-name">${esc(u.name)}</span>
                ${u.has_pin ? '<span class="team-pin-badge" title="PIN protected">[Lock]</span>' : ''}
                ${u.is_admin ? '<span class="team-badge-admin">Admin</span>' : '<span class="team-badge-user">User</span>'}
                <div class="team-user-actions">
                    <button class="btn-xs" onclick="showSetPinModal(${u.id}, '${escAttr(u.name)}', ${!!u.has_pin})" title="${u.has_pin ? 'Change PIN' : 'Set PIN'}">${u.has_pin ? '[Lock]' : '[Unlock]'}</button>
                    ${u.is_admin ? '' : `<button class="btn-xs" onclick="toggleUserAdmin(${u.id}, true)" title="Promote to admin">Up Admin</button>`}
                    ${u.is_admin ? `<button class="btn-xs" onclick="toggleUserAdmin(${u.id}, false)" title="Demote to regular user">Down User</button>` : ''}
                    <button class="btn-xs btn-danger-xs" onclick="deleteTeamUser(${u.id}, '${escAttr(u.name)}')" title="Delete user">x</button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = `<div style="color:var(--danger);font-size:0.82rem;">Error loading users: ${err.message}</div>`;
    }
}

async function addTeamUser() {
    const nameInput = document.getElementById('teamNewUserName');
    const avatarSelect = document.getElementById('teamNewUserAvatar');
    const colorInput = document.getElementById('teamNewUserColor');
    const name = nameInput?.value.trim();
    if (!name) return showToast('Enter a name', 'error');

    try {
        await api('/api/users', {
            method: 'POST',
            body: { name, avatar: name.substring(0, 2).toUpperCase(), color: colorInput?.value || '#888888', is_admin: 0 }
        });
        nameInput.value = '';
        showToast(`User "${name}" created`, 'success');
        await loadTeamSettings();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function toggleUserAdmin(userId, makeAdmin) {
    try {
        await api(`/api/users/${userId}`, { method: 'PUT', body: { is_admin: makeAdmin ? 1 : 0 } });
        showToast(makeAdmin ? 'Promoted to admin' : 'Changed to regular user', 'success');
        await loadTeamSettings();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteTeamUser(userId, userName) {
    if (!confirm(`Delete user "${userName}"? Their hidden-project entries will be removed.`)) return;
    try {
        await api(`/api/users/${userId}`, { method: 'DELETE' });
        showToast(`User "${userName}" deleted`, 'success');
        // If we just deleted the current user, show picker
        if (localStorage.getItem('cam_user_id') === String(userId)) {
            localStorage.removeItem('cam_user_id');
            window.showUserPicker();
        }
        await loadTeamSettings();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

/** Show modal to set or change a user's PIN */
function showSetPinModal(userId, userName, hasPin) {
    const modal = document.getElementById('modal');
    const content = document.getElementById('modalContent');
    if (!modal || !content) return;

    content.innerHTML = `
        <h2 style="margin:0 0 8px;">${hasPin ? '[Lock] Change PIN' : '[Unlock] Set PIN'}</h2>
        <p style="opacity:0.6;font-size:0.85rem;margin:0 0 16px;">
            ${hasPin ? `Change or remove the PIN for <strong>${userName}</strong>.` : `Set a PIN on <strong>${userName}</strong>'s profile to prevent impersonation.`}
        </p>
        <label style="font-size:0.82rem;opacity:0.8;">New PIN (4-8 characters)</label>
        <input type="password" id="setPinInput" maxlength="8" placeholder="****"
               style="width:100%;margin:6px 0 12px;"
               onkeydown="if(event.key==='Enter')saveUserPin(${userId});"
               onpointerdown="event.stopPropagation();">
        <div id="setPinError" style="color:#ff5252;font-size:0.82rem;margin-bottom:8px;display:none;"></div>
        <div class="form-actions">
            ${hasPin ? `<button class="btn-cancel" onclick="removeUserPin(${userId})" style="margin-right:auto;">Remove PIN</button>` : '<span></span>'}
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="saveUserPin(${userId})">Save Save PIN</button>
        </div>
    `;
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('setPinInput')?.focus(), 100);
}

async function saveUserPin(userId) {
    const input = document.getElementById('setPinInput');
    const err = document.getElementById('setPinError');
    const pin = input?.value;

    if (!pin || pin.length < 4) {
        if (err) { err.textContent = 'PIN must be at least 4 characters'; err.style.display = 'block'; }
        return;
    }

    try {
        await api(`/api/users/${userId}/pin`, { method: 'PUT', body: { pin } });
        closeModal();
        showToast('PIN saved', 'success');
        await loadTeamSettings();
    } catch (e) {
        if (err) { err.textContent = e.message || 'Failed to save PIN'; err.style.display = 'block'; }
    }
}

async function removeUserPin(userId) {
    if (!confirm('Remove PIN? This profile will no longer require a PIN to sign in.')) return;
    try {
        await api(`/api/users/${userId}/pin`, { method: 'PUT', body: { pin: null } });
        closeModal();
        showToast('PIN removed', 'success');
        await loadTeamSettings();
    } catch (e) {
        showToast(e.message || 'Failed to remove PIN', 'error');
    }
}

// ===========================================
//  HUB / SPOKE SYNC CONFIG
// ===========================================

async function loadSyncConfig() {
    try {
        const cfg = await api('/api/settings/sync-config');
        const modeSelect = document.getElementById('syncModeSelect');
        if (modeSelect) modeSelect.value = cfg.mode || 'standalone';

        // Populate fields
        document.getElementById('syncHubSecret')?.setAttribute('value', '');
        document.getElementById('syncHubUrl')?.setAttribute('value', '');
        document.getElementById('syncSpokeSecret')?.setAttribute('value', '');
        document.getElementById('syncSpokeName')?.setAttribute('value', '');

        if (cfg.mode === 'hub') {
            const el = document.getElementById('syncHubSecret');
            if (el) el.value = cfg.hub_secret || '';
        } else if (cfg.mode === 'spoke') {
            const urlEl = document.getElementById('syncHubUrl');
            const secEl = document.getElementById('syncSpokeSecret');
            const nameEl = document.getElementById('syncSpokeName');
            if (urlEl) urlEl.value = cfg.hub_url || '';
            if (secEl) secEl.value = cfg.hub_secret || '';
            if (nameEl) nameEl.value = cfg.spoke_name || '';
        }

        onSyncModeChange(); // show/hide fields
        updateSyncModeStatus(cfg.mode);
    } catch (err) {
        console.error('[SyncConfig] Failed to load:', err);
    }
}

function onSyncModeChange() {
    const mode = document.getElementById('syncModeSelect')?.value || 'standalone';
    const hubFields = document.getElementById('syncHubFields');
    const spokeFields = document.getElementById('syncSpokeFields');

    if (hubFields) hubFields.style.display = mode === 'hub' ? 'block' : 'none';
    if (spokeFields) spokeFields.style.display = mode === 'spoke' ? 'block' : 'none';
}

function updateSyncModeStatus(mode) {
    const el = document.getElementById('syncModeStatus');
    if (!el) return;

    if (mode === 'hub') {
        el.innerHTML = '<span style="color:var(--success);font-weight:600;">Active: Hub</span> — broadcasting changes to connected spokes';
    } else if (mode === 'spoke') {
        el.innerHTML = '<span style="color:var(--accent);font-weight:600;">Active: Spoke</span> — syncing from hub, writes forwarded';
    } else {
        el.innerHTML = '<span style="color:var(--text-dim);">Standalone</span> — no sync active';
    }
}

async function saveSyncConfig() {
    const mode = document.getElementById('syncModeSelect')?.value || 'standalone';
    const statusEl = document.getElementById('syncSaveStatus');

    const body = { mode };

    if (mode === 'hub') {
        body.hub_secret = document.getElementById('syncHubSecret')?.value?.trim() || '';
    } else if (mode === 'spoke') {
        body.hub_url    = document.getElementById('syncHubUrl')?.value?.trim() || '';
        body.hub_secret = document.getElementById('syncSpokeSecret')?.value?.trim() || '';
        body.spoke_name = document.getElementById('syncSpokeName')?.value?.trim() || '';
    }

    if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">Saving...</span>';

    try {
        const result = await api('/api/settings/sync-config', { method: 'POST', body });
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--success);">Saved! Restart the server to apply.</span>`;
        }
        updateSyncModeStatus(mode);
    } catch (err) {
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:var(--danger);">Error: ${esc(err.message)}</span>`;
        }
    }
}

// ===========================================
//  SCAN FOR HUB (spoke auto-discovery)
// ===========================================

async function scanForHub() {
    const resultsEl = document.getElementById('syncHubScanResults');
    if (!resultsEl) return;

    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<span style="color:var(--text-secondary);">Scanning network for hubs (UDP + HTTP subnet probe)…</span>';

    try {
        const data = await api('/api/servers/scan-hubs');
        const hubs = data.hubs || [];

        if (hubs.length === 0) {
            resultsEl.innerHTML = '<span style="color:var(--warning);">No hub found on this network. Make sure the hub is running and set to Hub mode in Settings.</span>';
            return;
        }

        resultsEl.innerHTML = hubs.map(h => {
            const label = `${esc(h.name || h.hostname)} (${esc(h.ip)}:${h.port})`;
            const badge = h.method === 'http' ? ' <span style="opacity:0.5;font-size:0.75rem;">[HTTP]</span>' : '';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span style="width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block;"></span>
                <span>${label}${badge}</span>
                <button onclick="selectHub('${esc(h.url)}')">Use This Hub</button>
            </div>`;
        }).join('');
    } catch (err) {
        resultsEl.innerHTML = `<span style="color:var(--danger);">Scan failed: ${esc(err.message)}</span>`;
    }
}

function selectHub(url) {
    const urlEl = document.getElementById('syncHubUrl');
    if (urlEl) urlEl.value = url;
    const resultsEl = document.getElementById('syncHubScanResults');
    if (resultsEl) {
        resultsEl.innerHTML = '<span style="color:var(--success);">Hub selected ✓</span>';
        setTimeout(() => { resultsEl.style.display = 'none'; }, 2000);
    }
}

// ===========================================
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ===========================================

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
window.fpNewFolder = fpNewFolder;
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
window.toggleServerPanel = toggleServerPanel;
window.scanForServers = scanForServers;
window.saveDiscoveredServer = saveDiscoveredServer;
window.addServerManual = addServerManual;
window.removeSavedServer = removeSavedServer;
window.saveServerName = saveServerName;
window.addPathMapping = addPathMapping;
window.removePathMapping = removePathMapping;
window.exportDatabase = exportDatabase;
window.importDatabase = importDatabase;
window.pullRemoteDatabase = pullRemoteDatabase;
window.saveSharedDbPath = saveSharedDbPath;
window.loadDbConfig = loadDbConfig;
window.saveGithubToken = saveGithubToken;
window.clearGithubToken = clearGithubToken;
window.loadGithubTokenStatus = loadGithubTokenStatus;
window.savePref = savePref;
window.addTeamUser = addTeamUser;
window.toggleUserAdmin = toggleUserAdmin;
window.deleteTeamUser = deleteTeamUser;
window.loadTeamSettings = loadTeamSettings;
window.showSetPinModal = showSetPinModal;
window.saveUserPin = saveUserPin;
window.removeUserPin = removeUserPin;
window.onSyncModeChange = onSyncModeChange;
window.saveSyncConfig = saveSyncConfig;
window.scanForHub = scanForHub;
window.selectHub = selectHub;




