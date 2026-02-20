/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM - Context Menus Module
 * Right-click menus for assets, shots, sequences, projects.
 * Includes CRUD modals (add sequence/shot), bulk ops (move, role-assign,
 * delete), Send to Resolve, Load in ComfyUI, Show File Path.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, formatSize, showToast, closeModal, confirmDelete } from './utils.js';
import { openPlayer } from './player.js';

// Forward references to functions in other modules (accessed via window.*)
// openProject, renderProjectDetail, selectSequence, selectShot, loadProjectAssets
// loadTree, showEditNamingModal, toggleArchiveProject
// toggleAssetSelection, updateSelectionClasses, selectAllAssets, clearAssetSelection
// playSelectedAssets, toggleStar, renameSequence, renameShot
// openInRV, openPlayerBuiltIn

// ===========================================
//  ASSET CONTEXT MENU
// ===========================================

async function showContextMenu(event, assetIdx) {
    event.preventDefault();
    event.stopPropagation();

    const asset = state.assets[assetIdx];
    if (!asset) return;

    // macOS: Ctrl+click fires contextmenu instead of click.
    // Treat it as a multi-select toggle (same as Cmd+click).
    if (event.ctrlKey && !event.metaKey) {
        window.toggleAssetSelection?.(asset.id);
        state.lastClickedAsset = assetIdx;
        window.updateSelectionClasses?.();
        return;
    }

    // If right-clicked tile isn't already selected, select only it
    if (!state.selectedAssets.includes(asset.id)) {
        state.selectedAssets = [asset.id];
        state.lastClickedAsset = assetIdx;
        window.updateSelectionClasses?.();
    }

    const count = state.selectedAssets.length;
    const isSingle = count === 1;

    // Fetch format variants for single-asset actions
    let formats = [];
    if (isSingle) {
        try {
            const resp = await fetch(`/api/assets/${asset.id}/formats`);
            const data = await resp.json();
            formats = data.formats || [];
        } catch { formats = [{ id: asset.id, file_ext: asset.file_ext || '?', media_type: asset.media_type, file_size: asset.file_size }]; }
    }

    // Remove any existing context menu
    dismissContextMenu();

    const menu = document.createElement('div');
    menu.id = 'assetContextMenu';
    menu.className = 'context-menu';

    // Helper: format file size compactly
    const fmtSize = (bytes) => {
        if (!bytes) return '';
        if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
        if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return bytes + ' B';
    };

    // Build menu HTML
    let html = '';

    // Single-asset actions with format sub-menus
    if (isSingle) {
        if (formats.length <= 1) {
            const ext = (asset.file_ext || '').toLowerCase();
            html += `<div class="ctx-item" data-action="play"> Play ${ext}</div>`;
            html += `<div class="ctx-item" data-action="rv"> RV ${ext}</div>`;
            html += `<div class="ctx-item" data-action="send-rv"> Send to RV ${ext}</div>`;
        } else {
            html += `<div class="ctx-item ctx-item-parent"> Play`;
            html += `<div class="ctx-submenu">`;
            for (const f of formats) {
                const ext = (f.file_ext || '').toLowerCase();
                html += `<div class="ctx-sub-item" data-play-id="${f.id}"><span class="ctx-sub-ext">${ext}</span><span class="ctx-sub-size">${fmtSize(f.file_size)}</span></div>`;
            }
            html += `</div></div>`;

            html += `<div class="ctx-item ctx-item-parent"> RV`;
            html += `<div class="ctx-submenu">`;
            for (const f of formats) {
                const ext = (f.file_ext || '').toLowerCase();
                html += `<div class="ctx-sub-item" data-rv-id="${f.id}"><span class="ctx-sub-ext">${ext}</span><span class="ctx-sub-size">${fmtSize(f.file_size)}</span></div>`;
            }
            html += `</div></div>`;
        }
        html += `<div class="ctx-item" data-action="send-rv"> Send to RV</div>`;

        html += `<div class="ctx-item" data-action="star">${asset.starred ? '*' : '*'} ${asset.starred ? 'Unstar' : 'Star'}</div>`;
        html += `<div class="ctx-separator"></div>`;
    }

    // Multi-asset actions (always available)
    html += `<div class="ctx-item" data-action="move"> Move to Sequence${!isSingle ? ` (${count})` : ''}</div>`;
    html += `<div class="ctx-item" data-action="role"> Set Role${!isSingle ? ` (${count})` : ''}</div>`;
    html += `<div class="ctx-item" data-action="export"> Export${!isSingle ? ` (${count})` : ''}</div>`;
    html += `<div class="ctx-item" data-action="addToCrate"> Add to Crate${!isSingle ? ` (${count})` : ''}</div>`;
    html += `<div class="ctx-item" data-action="sendResolve"> Send to Resolve${!isSingle ? ` (${count})` : ''}</div>`;

    // If viewing a crate, offer remove-from-crate
    if (window.getActiveCrateId?.()) {
        html += `<div class="ctx-item" data-action="removeFromCrate"> Remove from Crate${!isSingle ? ` (${count})` : ''}</div>`;
    }

    if (count >= 2) {
        html += `<div class="ctx-item" data-action="play-all"> Play All (${count})</div>`;
        html += `<div class="ctx-item" data-action="send-rv-set"> Send to RV (${count})</div>`;
        html += `<div class="ctx-item" data-action="send-rv-merge">+ Add to RV (${count})</div>`;
    }

    html += `<div class="ctx-separator"></div>`;
    html += `<div class="ctx-item" data-action="selectAll">[x] Select All</div>`;
    if (count > 0) {
        html += `<div class="ctx-item" data-action="deselectAll">[ ] Deselect All</div>`;
    }

    if (isSingle && asset.file_path) {
        html += `<div class="ctx-separator"></div>`;
        html += `<div class="ctx-item" data-action="showPath"> Show File Path</div>`;
        const comfyExts = ['png', 'mp4', 'webm', 'mkv', 'mov', 'avi'];
        const assetExt = (asset.file_ext || '').replace('.', '').toLowerCase();
        if (comfyExts.includes(assetExt)) {
            html += `<div class="ctx-item" data-action="loadComfy"> Load in ComfyUI</div>`;
        }
    }

    // Hide destructive actions when inside a crate (user wants Remove, not Delete)
    if (!window.getActiveCrateId?.()) {
        html += `<div class="ctx-separator"></div>`;
        html += `<div class="ctx-item ctx-danger" data-action="delete"> Delete${!isSingle ? ` (${count})` : ''}</div>`;
        html += `<div class="ctx-item ctx-muted" data-action="removeDb"> Remove from DB only${!isSingle ? ` (${count})` : ''}</div>`;
    }

    menu.innerHTML = html;
    document.body.appendChild(menu);

    // Wire up click handlers
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action], [data-play-id], [data-rv-id]');
        if (!item) return;
        dismissContextMenu();

        const action = item.dataset.action;
        const playId = item.dataset.playId;
        const rvId = item.dataset.rvId;
        if (playId) { window.openPlayerById?.(parseInt(playId)); return; }
        if (rvId) { window.openInRV?.(parseInt(rvId)); return; }

        switch (action) {
            case 'play': window.openPlayerBuiltIn?.(assetIdx); break;
            case 'rv': window.openInRV?.(asset.id); break;
            case 'send-rv': window.sendToRV?.(asset.id, 'merge'); break;
            case 'star': window.toggleStar?.(asset.id); break;
            case 'move': showMoveToSequenceModal(); break;
            case 'role': showAssignRoleModal(); break;
            case 'export': window.showExportModal?.(); break;
            case 'addToCrate': {
                const ids = state.selectedAssets.length > 0 ? [...state.selectedAssets] : [asset.id];
                window.showAddToCrateMenu?.(event, ids);
                break;
            }
            case 'removeFromCrate': {
                const ids = state.selectedAssets.length > 0 ? [...state.selectedAssets] : [asset.id];
                window.removeFromCrate?.(ids);
                break;
            }
            case 'sendResolve': sendToResolve(); break;
            case 'play-all': window.playSelectedAssets?.(); break;
            case 'send-rv-set': window.sendSelectedToRV?.('set'); break;
            case 'send-rv-merge': window.sendSelectedToRV?.('merge'); break;
            case 'selectAll': window.selectAllAssets?.(); break;
            case 'deselectAll': window.clearAssetSelection?.(); break;
            case 'showPath':
                showFilePathModal(asset.file_path, asset.vault_name);
                break;
            case 'loadComfy':
                loadInComfyUI(asset.id, asset.vault_name);
                break;
            case 'delete': bulkDeleteAssets(); break;
            case 'removeDb': bulkDeleteAssets(true); break;
        }
    });

    // Position: ensure menu stays within viewport
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';

    requestAnimationFrame(() => {
        const mRect = menu.getBoundingClientRect();
        let x = event.clientX, y = event.clientY;
        if (x + mRect.width > window.innerWidth) x = window.innerWidth - mRect.width - 8;
        if (y + mRect.height > window.innerHeight) y = window.innerHeight - mRect.height - 8;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        if (x + mRect.width + 160 > window.innerWidth) {
            menu.querySelectorAll('.ctx-submenu').forEach(sub => {
                sub.style.left = 'auto';
                sub.style.right = '100%';
            });
        }
    });

    // Dismiss on click outside or Escape
    setTimeout(() => {
        document.addEventListener('click', dismissContextMenu, { once: true });
        document.addEventListener('contextmenu', dismissContextMenu, { once: true });
    }, 0);
    document.addEventListener('keydown', onCtxKeydown);
}

function dismissContextMenu() {
    const menu = document.getElementById('assetContextMenu');
    if (menu) menu.remove();
    document.removeEventListener('keydown', onCtxKeydown);
}

function onCtxKeydown(e) {
    if (e.key === 'Escape') dismissContextMenu();
}

// ===========================================
//  HIERARCHY CONTEXT MENUS
// ===========================================

function dismissHierarchyMenu() {
    const menu = document.getElementById('hierarchyContextMenu');
    if (menu) menu.remove();
    document.removeEventListener('keydown', onHierMenuKeydown);
}

function onHierMenuKeydown(e) {
    if (e.key === 'Escape') dismissHierarchyMenu();
}

function positionContextMenu(menu, event) {
    document.body.appendChild(menu);
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';

    requestAnimationFrame(() => {
        const mRect = menu.getBoundingClientRect();
        let x = event.clientX, y = event.clientY;
        if (x + mRect.width > window.innerWidth) x = window.innerWidth - mRect.width - 8;
        if (y + mRect.height > window.innerHeight) y = window.innerHeight - mRect.height - 8;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    });

    setTimeout(() => {
        document.addEventListener('click', dismissHierarchyMenu, { once: true });
        document.addEventListener('contextmenu', dismissHierarchyMenu, { once: true });
    }, 0);
    document.addEventListener('keydown', onHierMenuKeydown);
}

function showShotContextMenu(event, seqId, shotId, shotName) {
    event.preventDefault();
    event.stopPropagation();
    dismissHierarchyMenu();
    dismissContextMenu();

    const menu = document.createElement('div');
    menu.id = 'hierarchyContextMenu';
    menu.className = 'context-menu';

    menu.innerHTML = `
        <div class="ctx-header"> ${esc(shotName)}</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="select"> Select Shot</div>
        <div class="ctx-item" data-action="rename">Edit Rename</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item ctx-danger" data-action="delete"> Delete Shot</div>
    `;

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        dismissHierarchyMenu();

        switch (item.dataset.action) {
            case 'select': window.selectShot?.(seqId, shotId); break;
            case 'rename': window.renameShot?.(seqId, shotId, shotName); break;
            case 'delete': deleteShot(seqId, shotId, shotName); break;
        }
    });

    positionContextMenu(menu, event);
}

function showSeqContextMenu(event, seqId, seqName) {
    event.preventDefault();
    event.stopPropagation();
    dismissHierarchyMenu();
    dismissContextMenu();

    const menu = document.createElement('div');
    menu.id = 'hierarchyContextMenu';
    menu.className = 'context-menu';

    const seq = state.currentProject?.sequences?.find(s => s.id === seqId);
    const shotCount = seq?.shots?.length || 0;

    menu.innerHTML = `
        <div class="ctx-header"> ${esc(seqName)}</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="select"> Select Sequence</div>
        <div class="ctx-item" data-action="rename">Edit Rename</div>
        <div class="ctx-item" data-action="addShot">+ Add Shot</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item ctx-danger" data-action="delete"> Delete Sequence${shotCount > 0 ? ` (${shotCount} shots)` : ''}</div>
    `;

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        dismissHierarchyMenu();

        switch (item.dataset.action) {
            case 'select': window.selectSequence?.(seqId); break;
            case 'rename': window.renameSequence?.(seqId, seqName); break;
            case 'addShot': showAddShotModal(seqId); break;
            case 'delete': deleteSequence(seqId, seqName); break;
        }
    });

    positionContextMenu(menu, event);
}

function showProjectContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    dismissHierarchyMenu();
    dismissContextMenu();

    if (!state.currentProject) return;
    const project = state.currentProject;

    const menu = document.createElement('div');
    menu.id = 'hierarchyContextMenu';
    menu.className = 'context-menu';

    const seqCount = project.sequences?.length || 0;

    menu.innerHTML = `
        <div class="ctx-header">${project.type === 'shot_based' ? '' : ''} ${esc(project.name)}</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="addSeq">+ Add Sequence</div>
        <div class="ctx-item" data-action="editNaming"> Naming Convention</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="archive">${project.archived ? ' Unarchive Project' : ' Archive Project'}</div>
        <div class="ctx-item ctx-danger" data-action="delete"> Delete Project${seqCount > 0 ? ` (${seqCount} sequences)` : ''}</div>
    `;

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        dismissHierarchyMenu();

        switch (item.dataset.action) {
            case 'addSeq': showAddSequenceModal(); break;
            case 'editNaming': window.showEditNamingModal?.(project); break;
            case 'archive': window.toggleArchiveProject?.(project); break;
            case 'delete': deleteCurrentProject(); break;
        }
    });

    positionContextMenu(menu, event);
}

// ===========================================
//  DELETE OPERATIONS
// ===========================================

async function deleteShot(seqId, shotId, shotName) {
    if (!state.currentProject) return;
    if (!confirmDelete(`Delete shot "${shotName}"? Assets in this shot will become unassigned (not deleted).`)) return;
    const projectId = state.currentProject.id;
    try {
        await api(`/api/projects/${projectId}/sequences/${seqId}/shots/${shotId}`, { method: 'DELETE' });
        state.currentShot = null;
        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        window.renderProjectDetail?.(proj);
        window.loadProjectAssets?.(projectId);
        await window.loadTree?.();
    } catch (err) {
        alert(' Delete shot failed: ' + err.message);
    }
}

async function deleteSequence(seqId, seqName) {
    if (!state.currentProject) return;
    if (!confirmDelete(`Delete sequence "${seqName}" and all its shots? Assets will become unassigned (not deleted).`)) return;
    const projectId = state.currentProject.id;
    try {
        await api(`/api/projects/${projectId}/sequences/${seqId}`, { method: 'DELETE' });
        state.currentSequence = null;
        state.currentShot = null;
        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        window.renderProjectDetail?.(proj);
        window.loadProjectAssets?.(projectId);
        await window.loadTree?.();
    } catch (err) {
        alert(' Delete sequence failed: ' + err.message);
    }
}

async function deleteCurrentProject() {
    if (!state.currentProject) return;
    if (!confirmDelete(` DELETE ENTIRE PROJECT "${state.currentProject.name}"?\n\nThis will delete ALL sequences, shots, and assets!\n\nThis cannot be undone!`)) return;

    try {
        await api(`/api/projects/${state.currentProject.id}`, { method: 'DELETE' });
        state.currentProject = null;
        window.switchTab('projects');
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ===========================================
//  BULK OPS - Move to Sequence, Assign Role
// ===========================================

async function showMoveToSequenceModal() {
    if (state.selectedAssets.length === 0) return;
    if (!state.currentProject?.sequences?.length) {
        alert('No sequences in this project. Create a sequence first.');
        return;
    }

    const seqs = state.currentProject.sequences;
    document.getElementById('modalContent').innerHTML = `
        <h3>Move ${state.selectedAssets.length} Asset(s) to Sequence</h3>
        <p style="color:var(--text-dim);margin-bottom:16px">Files will be physically moved into the sequence folder.</p>
        <label>Sequence</label>
        <select id="moveToSeqSelect">
            ${seqs.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`).join('')}
        </select>
        <div class="form-actions" style="margin-top:20px">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="executeMoveToSequence()"> Move</button>
        </div>
    `;
    document.getElementById('modal').style.display = 'flex';
}

async function executeMoveToSequence() {
    const seqId = document.getElementById('moveToSeqSelect').value;
    if (!seqId) return;

    try {
        const result = await api('/api/assets/bulk-assign', {
            method: 'POST',
            body: {
                ids: state.selectedAssets,
                sequence_id: parseInt(seqId),
            },
        });

        closeModal();
        alert(` Moved ${result.moved} asset(s).` +
            (result.errors > 0 ? `\n ${result.errors} error(s)` : ''));

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        await window.loadTree?.();
        if (state.currentProject) {
            const proj = await api(`/api/projects/${state.currentProject.id}`);
            state.currentProject = proj;
            window.loadProjectAssets?.(state.currentProject.id);
        }
    } catch (err) {
        alert(' Move failed: ' + err.message);
    }
}

async function showAssignRoleModal() {
    if (state.selectedAssets.length === 0) return;

    let roles = [];
    try { roles = await api('/api/roles'); } catch { /* no roles */ }

    if (roles.length === 0) {
        alert('No roles defined. Go to Settings -> Roles to create some.');
        return;
    }

    document.getElementById('modalContent').innerHTML = `
        <h3> Assign Role to ${state.selectedAssets.length} Asset(s)</h3>
        <p style="color:var(--text-dim);margin-bottom:16px">Categorize assets by department/role.</p>
        <label>Role</label>
        <select id="assignRoleSelect">
            <option value="">-- Clear Role --</option>
            ${roles.map(r => `<option value="${r.id}" style="color:${r.color}">${r.icon} ${esc(r.name)}</option>`).join('')}
        </select>
        <div class="form-actions" style="margin-top:20px">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="executeAssignRole()"> Assign</button>
        </div>
    `;
    document.getElementById('modal').style.display = 'flex';
}

async function executeAssignRole() {
    const roleId = document.getElementById('assignRoleSelect').value;

    try {
        await api('/api/assets/bulk-role', {
            method: 'POST',
            body: {
                ids: state.selectedAssets,
                role_id: roleId ? parseInt(roleId) : null,
            },
        });

        closeModal();
        const action = roleId ? 'assigned role to' : 'cleared role from';
        showToast(` ${action} ${state.selectedAssets.length} asset(s)`);

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        await window.loadTree?.();
        if (state.currentProject) {
            window.loadProjectAssets?.(state.currentProject.id);
        }
    } catch (err) {
        alert(' Role assignment failed: ' + err.message);
    }
}

async function bulkDeleteAssets(dbOnly = false) {
    const count = state.selectedAssets.length;
    if (count === 0) return;

    const msg = dbOnly
        ? `Remove ${count} asset(s) from the database?\n\nFiles will be KEPT on disk.`
        : `DELETE ${count} asset(s)?\n\n This will permanently delete the files from disk!\n\nThis cannot be undone.`;

    if (!confirmDelete(msg)) return;

    try {
        const result = await api('/api/assets/bulk-delete', {
            method: 'POST',
            body: {
                ids: state.selectedAssets,
                delete_files: !dbOnly,
            },
        });

        alert(` Deleted ${result.deleted} asset(s).` +
            (result.errors > 0 ? `\n ${result.errors} error(s)` : ''));

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        if (state.currentProject) {
            window.loadProjectAssets?.(state.currentProject.id);
        }
        window.checkSetup?.();
    } catch (err) {
        alert(' Delete failed: ' + err.message);
    }
}

// ===========================================
//  SEQUENCES & SHOTS CRUD
// ===========================================

function showAddSequenceModal() {
    if (!state.currentProject) return;

    const nextNum = (state.currentProject.sequences?.length || 0) + 1;

    document.getElementById('modalContent').innerHTML = `
        <h3>Add Sequence</h3>
        <label>Sequence Name</label>
        <input type="text" id="seqName" placeholder="Opening Shot" autofocus>
        <label>Sequence Code</label>
        <input type="text" id="seqCode" value="SQ${String(nextNum * 10).padStart(3, '0')}" 
            oninput="this.value=this.value.toUpperCase()">
        <div class="form-actions">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="createSequence()">Create</button>
        </div>
    `;
    document.getElementById('modal').style.display = 'flex';
}

async function createSequence() {
    const name = document.getElementById('seqName').value.trim();
    const code = document.getElementById('seqCode').value.trim();
    if (!name || !code) return alert('Name and code required');

    try {
        await api(`/api/projects/${state.currentProject.id}/sequences`, {
            method: 'POST', body: { name, code }
        });
        closeModal();
        window.openProject?.(state.currentProject.id);
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function showAddShotModal(sequenceId) {
    document.getElementById('modalContent').innerHTML = `
        <h3>Add Shot</h3>
        <label>Shot Name</label>
        <input type="text" id="shotName" placeholder="Hero Close-Up" autofocus>
        <label>Shot Code</label>
        <input type="text" id="shotCode" value="SH010" 
            oninput="this.value=this.value.toUpperCase()">
        <input type="hidden" id="shotSeqId" value="${sequenceId}">
        <div class="form-actions">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="createShot()">Create</button>
        </div>
    `;
    document.getElementById('modal').style.display = 'flex';
}

async function createShot() {
    const name = document.getElementById('shotName').value.trim();
    const code = document.getElementById('shotCode').value.trim();
    const seqId = document.getElementById('shotSeqId').value;
    if (!name || !code) return alert('Name and code required');

    try {
        await api(`/api/projects/${state.currentProject.id}/sequences/${seqId}/shots`, {
            method: 'POST', body: { name, code }
        });
        closeModal();
        window.openProject?.(state.currentProject.id);
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ===========================================
//  SEND TO DAVINCI RESOLVE
// ===========================================

async function sendToResolve() {
    const ids = state.selectedAssets;
    if (!ids.length) return;

    document.getElementById('resolveModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'resolveModal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.style.cssText = 'background:#222;border:1px solid #444;border-radius:8px;padding:24px 28px;max-width:500px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    box.innerHTML = `
        <div style="font-size:15px;font-weight:600;color:#ddd;margin-bottom:16px;"> Send to DaVinci Resolve</div>
        <div style="font-size:12px;color:#888;margin-bottom:12px;">${ids.length} asset${ids.length > 1 ? 's' : ''} selected</div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;">
            <input type="checkbox" id="resolveAutoHierarchy" checked
                   style="width:16px;height:16px;accent-color:#888;">
            <span style="font-size:13px;color:#ccc;">Auto-create bins from project hierarchy</span>
        </label>
        <div id="resolveManualBin" style="display:none;margin-bottom:12px;">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Bin Path (e.g. "Project/Comp")</label>
            <input type="text" id="resolveBinPathInput" placeholder="Leave empty for Media Pool root"
                   style="width:100%;padding:8px 10px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#ddd;font-size:13px;box-sizing:border-box;">
        </div>
        <div id="resolveStatus" style="font-size:12px;color:#666;margin-bottom:16px;min-height:18px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button onclick="this.closest('#resolveModal').remove()"
                    style="padding:8px 16px;background:#333;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;">Cancel</button>
            <button id="resolveSendBtn" onclick="executeSendToResolve()"
                    style="padding:8px 20px;background:#444;border:1px solid #555;border-radius:4px;color:#ddd;cursor:pointer;font-size:13px;font-weight:500;">Send -></button>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Toggle manual bin input
    const autoCheck = document.getElementById('resolveAutoHierarchy');
    const manualDiv = document.getElementById('resolveManualBin');
    autoCheck.addEventListener('change', () => {
        manualDiv.style.display = autoCheck.checked ? 'none' : 'block';
    });

    // Check Resolve status
    const statusEl = document.getElementById('resolveStatus');
    try {
        const res = await api('/api/resolve/status');
        if (res.running) {
            statusEl.innerHTML = `<span style="color:#6a6">Success: Connected to Resolve - ${esc(res.currentProject || 'No project open')}</span>`;
        } else {
            statusEl.innerHTML = `<span style="color:#a66">Warning: Resolve not detected. Make sure Resolve is running.</span>`;
        }
    } catch (e) {
        statusEl.innerHTML = `<span style="color:#a66">Warning: Cannot check Resolve status</span>`;
    }

    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}

async function executeSendToResolve() {
    const ids = state.selectedAssets;
    if (!ids.length) return;

    const autoHierarchy = document.getElementById('resolveAutoHierarchy')?.checked ?? true;
    const manualBinPath = document.getElementById('resolveBinPathInput')?.value?.trim() || '';

    const statusEl = document.getElementById('resolveStatus');
    const sendBtn = document.getElementById('resolveSendBtn');
    if (statusEl) statusEl.innerHTML = '<span style="color:#888"> Sending to Resolve...</span>';
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending...'; }

    try {
        const body = { assetIds: ids, createBins: true };

        if (autoHierarchy) {
            body.autoBinByHierarchy = true;
        } else if (manualBinPath) {
            body.binPath = manualBinPath;
        }

        const res = await api('/api/resolve/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.success) {
            const msg = ` ${res.imported || ids.length} asset${(res.imported || ids.length) > 1 ? 's' : ''} sent to Resolve -> ${res.bin || 'Master'}`;
            if (statusEl) statusEl.innerHTML = `<span style="color:#6a6">${esc(msg)}</span>`;
            showToast(msg, 4000);

            if (res.warnings) {
                if (statusEl) statusEl.innerHTML += `<br><span style="color:#a86">Warning: ${esc(res.warnings.message)}</span>`;
            }

            setTimeout(() => {
                document.getElementById('resolveModal')?.remove();
            }, 2000);
        } else {
            const errMsg = res.error || 'Unknown error';
            if (statusEl) statusEl.innerHTML = `<span style="color:#a66"> ${esc(errMsg)}</span>`;
            showToast('Failed: ' + errMsg, 5000);
        }
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span style="color:#a66"> ${e.message}</span>`;
        showToast('Resolve error: ' + e.message, 5000);
    } finally {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send ->'; }
    }
}

// ===========================================
//  SHOW FILE PATH MODAL
// ===========================================

function showFilePathModal(filePath, vaultName) {
    document.getElementById('filePathModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'filePathModal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.style.cssText = 'background:#222;border:1px solid #444;border-radius:8px;padding:20px 24px;max-width:700px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    const title = document.createElement('div');
    title.textContent = vaultName || 'File Path';
    title.style.cssText = 'font-size:13px;color:#888;margin-bottom:10px;';

    const pathEl = document.createElement('div');
    pathEl.textContent = filePath;
    pathEl.style.cssText = 'font-family:monospace;font-size:13px;color:#ddd;background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:12px 14px;word-break:break-all;user-select:all;cursor:text;line-height:1.5;';

    const hint = document.createElement('div');
    hint.textContent = 'Select text above to copy  .  Click outside or press Esc to close';
    hint.style.cssText = 'font-size:11px;color:#555;margin-top:10px;text-align:center;';

    box.append(title, pathEl, hint);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
}

// ===========================================
//  LOAD IN COMFYUI
// ===========================================

async function loadInComfyUI(assetId, assetName) {
    try {
        showToast('Extracting workflow...');

        const res = await fetch(`/api/comfyui/load-in-comfy/${assetId}`, { method: 'POST' });
        const data = await res.json();

        if (!res.ok || !data.success) {
            showToast(data.error || 'Failed to load in ComfyUI', 5000);
            return;
        }

        const comfyTab = window.open(data.comfyUrl + '?cam_load=1', 'comfyui');
        if (!comfyTab) {
            showToast('Pop-up blocked - allow pop-ups for this site', 5000);
            return;
        }

        showToast(`Sent to ComfyUI (${data.nodeCount} nodes)`);
    } catch (e) {
        showToast('Error: ' + e.message, 5000);
    }
}

// ===========================================
//  RENAME SHOT / SEQUENCE (called from hierarchy context menus)
// ===========================================

async function renameShot(seqId, shotId, currentName) {
    const newName = prompt('Rename shot:', currentName);
    if (!newName || newName.trim() === '' || newName === currentName) return;
    const projectId = state.currentProject?.id;
    if (!projectId) return;

    try {
        await api(`/api/projects/${projectId}/sequences/${seqId}/shots/${shotId}`, {
            method: 'PUT',
            body: { name: newName.trim() },
        });
        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        window.renderProjectDetail?.(proj);
        await window.loadTree?.();
    } catch (err) {
        alert(' Rename failed: ' + err.message);
    }
}

async function renameSequence(seqId, currentName) {
    const newName = prompt('Rename sequence:', currentName);
    if (!newName || newName.trim() === '' || newName === currentName) return;

    const projectId = state.currentProject?.id;
    if (!projectId) return;

    try {
        await api(`/api/projects/${projectId}/sequences/${seqId}`, {
            method: 'PUT',
            body: { name: newName.trim() },
        });

        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        window.renderProjectDetail?.(proj);
        await window.loadTree?.();
    } catch (err) {
        alert(' Rename failed: ' + err.message);
    }
}

// ===========================================
//  IMPORT FROM DAVINCI RESOLVE (Phase 2)
// ===========================================

/**
 * "Import from Resolve" modal - pulls all clips from Resolve's media pool,
 * lets user select which ones to register in CAM, and creates a project
 * with the bin hierarchy mapped to sequences/shots.
 */
async function importFromResolve() {
    document.getElementById('resolveImportModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'resolveImportModal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.style.cssText = 'background:#222;border:1px solid #444;border-radius:8px;padding:24px 28px;max-width:700px;width:92%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    box.innerHTML = `
        <div style="font-size:15px;font-weight:600;color:#ddd;margin-bottom:4px;"> Import from DaVinci Resolve</div>
        <div style="font-size:12px;color:#888;margin-bottom:16px;">Pull your Resolve media pool into CAM. Files stay in place (register-in-place).</div>
        <div id="resolveImportStatus" style="font-size:12px;color:#888;margin-bottom:12px;min-height:18px;">Connecting to Resolve...</div>

        <!-- Project name row -->
        <div id="resolveImportForm" style="display:none;">
            <div style="display:flex;gap:10px;margin-bottom:12px;">
                <div style="flex:2;">
                    <label style="font-size:11px;color:#666;display:block;margin-bottom:3px;">Project Name</label>
                    <input type="text" id="resolveImportProjectName" placeholder="My Project"
                           style="width:100%;padding:7px 10px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#ddd;font-size:13px;box-sizing:border-box;">
                </div>
                <div style="flex:1;">
                    <label style="font-size:11px;color:#666;display:block;margin-bottom:3px;">Code</label>
                    <input type="text" id="resolveImportProjectCode" placeholder="AUTO"
                           style="width:100%;padding:7px 10px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#ddd;font-size:13px;box-sizing:border-box;">
                </div>
            </div>

            <!-- Select all / clip count -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="resolveImportSelectAll" checked
                           style="width:14px;height:14px;accent-color:#888;">
                    <span style="font-size:12px;color:#aaa;">Select All</span>
                </label>
                <span id="resolveImportClipCount" style="font-size:12px;color:#666;margin-left:auto;"></span>
            </div>

            <!-- Clip list (scrollable) -->
            <div id="resolveImportClipList" style="flex:1;overflow-y:auto;max-height:45vh;border:1px solid #333;border-radius:4px;background:#1a1a1a;margin-bottom:14px;"></div>

            <!-- Action buttons -->
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button onclick="document.getElementById('resolveImportModal')?.remove()"
                        style="padding:8px 16px;background:#333;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;">Cancel</button>
                <button id="resolveImportBtn" onclick="executeImportFromResolve()"
                        style="padding:8px 20px;background:#444;border:1px solid #555;border-radius:4px;color:#ddd;cursor:pointer;font-size:13px;font-weight:500;"> Import Selected</button>
            </div>
        </div>

        <!-- Loading / error state -->
        <div id="resolveImportLoading" style="text-align:center;padding:30px 0;">
            <div style="font-size:24px;margin-bottom:8px;"></div>
            <div style="font-size:13px;color:#888;">Scanning Resolve media pool...</div>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    // Fetch media pool from Resolve
    const statusEl = document.getElementById('resolveImportStatus');
    const formEl = document.getElementById('resolveImportForm');
    const loadingEl = document.getElementById('resolveImportLoading');

    try {
        const data = await api('/api/resolve/media-pool');
        if (!data.success) {
            loadingEl.innerHTML = `<div style="color:#a66;font-size:13px;"> ${esc(data.error || 'Could not connect to Resolve')}</div>
                <div style="margin-top:12px;"><button onclick="document.getElementById('resolveImportModal')?.remove()" style="padding:6px 14px;background:#333;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;">Close</button></div>`;
            return;
        }

        if (!data.clips || data.clips.length === 0) {
            loadingEl.innerHTML = `<div style="color:#a86;font-size:13px;">Warning: No media clips found in Resolve's media pool.</div>
                <div style="font-size:12px;color:#666;margin-top:6px;">Make sure your Resolve project has media imported.</div>
                <div style="margin-top:12px;"><button onclick="document.getElementById('resolveImportModal')?.remove()" style="padding:6px 14px;background:#333;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;">Close</button></div>`;
            return;
        }

        // Populate form
        statusEl.innerHTML = `<span style="color:#6a6;">Success: Connected to Resolve - ${esc(data.project)}</span>  .  <span style="color:#aaa;">${data.mediaClips} clips found</span>`;
        document.getElementById('resolveImportProjectName').value = data.project || '';
        loadingEl.style.display = 'none';
        formEl.style.display = 'block';

        // Store clips in window for executeImport
        window._resolveImportClips = data.clips;

        // Build clip list
        renderResolveClipList(data.clips);

        // Select All toggle
        document.getElementById('resolveImportSelectAll').addEventListener('change', (e) => {
            const checks = document.querySelectorAll('.resolve-clip-check');
            checks.forEach(cb => cb.checked = e.target.checked);
            updateResolveImportCount();
        });

    } catch (e) {
        loadingEl.innerHTML = `<div style="color:#a66;font-size:13px;"> ${esc(e.message)}</div>
            <div style="font-size:12px;color:#666;margin-top:6px;">Make sure DaVinci Resolve is running and scripting is enabled.</div>
            <div style="margin-top:12px;"><button onclick="document.getElementById('resolveImportModal')?.remove()" style="padding:6px 14px;background:#333;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;">Close</button></div>`;
    }
}

function renderResolveClipList(clips) {
    const container = document.getElementById('resolveImportClipList');
    if (!container) return;

    // Group by bin path for visual hierarchy
    const byBin = {};
    for (const clip of clips) {
        const bin = clip.binPath || '(root)';
        if (!byBin[bin]) byBin[bin] = [];
        byBin[bin].push(clip);
    }

    let html = '';
    const bins = Object.keys(byBin).sort();

    for (const bin of bins) {
        // Bin header
        const shortBin = bin.split('/').slice(1).join(' / ') || bin; // skip root "Master"
        html += `<div style="padding:6px 10px;background:#252525;font-size:11px;color:#888;border-bottom:1px solid #2a2a2a;font-weight:600;"> ${esc(shortBin || 'Media Pool Root')}</div>`;

        for (const clip of byBin[bin]) {
            const ext = (clip.filePath || '').split('.').pop().toUpperCase();
            const meta = [clip.resolution, clip.fps ? clip.fps + ' fps' : '', clip.codec].filter(Boolean).join('  .  ');
            html += `
                <label style="display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid #222;cursor:pointer;transition:background 0.15s;"
                       onmouseenter="this.style.background='#2a2a2a'" onmouseleave="this.style.background='transparent'">
                    <input type="checkbox" class="resolve-clip-check" checked data-filepath="${esc(clip.filePath)}" data-name="${esc(clip.name)}" data-bin="${esc(clip.binPath)}"
                           onchange="updateResolveImportCount()" style="width:13px;height:13px;accent-color:#888;flex-shrink:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:12px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(clip.filePath)}">${esc(clip.name)}</div>
                        <div style="font-size:10px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(meta)}</div>
                    </div>
                    <span style="font-size:10px;color:#555;flex-shrink:0;">${esc(ext)}</span>
                </label>
            `;
        }
    }

    container.innerHTML = html;
    updateResolveImportCount();
}

function updateResolveImportCount() {
    const total = document.querySelectorAll('.resolve-clip-check').length;
    const checked = document.querySelectorAll('.resolve-clip-check:checked').length;
    const countEl = document.getElementById('resolveImportClipCount');
    if (countEl) countEl.textContent = `${checked} / ${total} clips selected`;

    const btn = document.getElementById('resolveImportBtn');
    if (btn) {
        btn.disabled = checked === 0;
        btn.textContent = checked > 0 ? ` Import ${checked} Clip${checked > 1 ? 's' : ''}` : ' Import Selected';
    }
}

async function executeImportFromResolve() {
    const projectName = document.getElementById('resolveImportProjectName')?.value?.trim();
    if (!projectName) {
        showToast('Enter a project name', 3000);
        document.getElementById('resolveImportProjectName')?.focus();
        return;
    }

    const projectCode = document.getElementById('resolveImportProjectCode')?.value?.trim() || '';

    // Gather selected clips
    const checks = document.querySelectorAll('.resolve-clip-check:checked');
    const selectedClips = [];
    checks.forEach(cb => {
        selectedClips.push({
            filePath: cb.dataset.filepath,
            name: cb.dataset.name,
            binPath: cb.dataset.bin
        });
    });

    if (!selectedClips.length) {
        showToast('No clips selected', 3000);
        return;
    }

    const statusEl = document.getElementById('resolveImportStatus');
    const btn = document.getElementById('resolveImportBtn');
    if (statusEl) statusEl.innerHTML = `<span style="color:#888;"> Importing ${selectedClips.length} clips into CAM...</span>`;
    if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }

    try {
        const res = await api('/api/resolve/import-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectName,
                projectCode,
                clips: selectedClips
            })
        });

        if (res.success) {
            const msg = ` Imported ${res.imported} clip${res.imported !== 1 ? 's' : ''} into project "${esc(projectName)}"`;
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:#6a6;">${msg}</span>`;
                if (res.errors > 0) {
                    statusEl.innerHTML += `<br><span style="color:#a86;">Warning: ${res.errors} clip${res.errors !== 1 ? 's' : ''} had errors</span>`;
                }
            }
            showToast(msg, 5000);

            // Refresh projects list
            if (window.loadProjects) window.loadProjects();

            setTimeout(() => {
                document.getElementById('resolveImportModal')?.remove();
            }, 2500);
        } else {
            const errMsg = res.error || 'Unknown error';
            if (statusEl) statusEl.innerHTML = `<span style="color:#a66;"> ${esc(errMsg)}</span>`;
            if (btn) { btn.disabled = false; btn.textContent = ' Import Selected'; }
            showToast('Import failed: ' + errMsg, 5000);
        }
    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span style="color:#a66;"> ${esc(e.message)}</span>`;
        if (btn) { btn.disabled = false; btn.textContent = ' Import Selected'; }
        showToast('Import error: ' + e.message, 5000);
    }
}


// ===========================================
//  REORGANIZE & RELINK TO RESOLVE
// ===========================================

/**
 * "Reorganize & Relink" - after user has organized assets in CAM
 * (renamed, assigned to sequences/shots, set naming convention),
 * this renames/moves files per the naming convention and sends a
 * relink map to Resolve so the timeline still works.
 *
 * Available from the project action bar when viewing a project
 * that has linked (register-in-place) assets.
 */
async function reorganizeAndRelink() {
    const projectId = state.currentProject?.id;
    if (!projectId) {
        showToast('Open a project first', 3000);
        return;
    }

    document.getElementById('relinkModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'relinkModal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.style.cssText = 'background:#222;border:1px solid #444;border-radius:8px;padding:24px 28px;max-width:600px;width:92%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    box.innerHTML = `
        <div style="font-size:15px;font-weight:600;color:#ddd;margin-bottom:4px;"> Reorganize & Relink to Resolve</div>
        <div style="font-size:12px;color:#888;margin-bottom:16px;">
            Copy linked files into the vault folder structure, rename using naming convention, then update Resolve's media pool so the timeline still works. Originals are not touched.
        </div>
        <div id="relinkStatus" style="font-size:12px;color:#888;margin-bottom:12px;min-height:18px;">Scanning project assets...</div>
        <div id="relinkContent" style="flex:1;overflow-y:auto;max-height:45vh;margin-bottom:14px;"></div>
        <div id="relinkActions" style="display:flex;gap:8px;justify-content:flex-end;">
            <button onclick="document.getElementById('relinkModal')?.remove()"
                    style="padding:8px 16px;background:#333;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;">Cancel</button>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    const statusEl = document.getElementById('relinkStatus');
    const contentEl = document.getElementById('relinkContent');
    const actionsEl = document.getElementById('relinkActions');

    try {
        // Find linked assets in this project
        const assetsRes = await api(`/api/assets?project_id=${projectId}&limit=9999`);
        const allAssets = assetsRes.assets || assetsRes || [];
        const linkedAssets = allAssets.filter(a => a.is_linked == 1);

        if (!linkedAssets.length) {
            statusEl.innerHTML = `<span style="color:#a86;">Warning: No linked (register-in-place) assets found in this project.</span>`;
            contentEl.innerHTML = `<div style="padding:16px;font-size:12px;color:#666;">This feature works with assets imported from Resolve via "Import from Resolve". Copied/moved assets are already managed by CAM.</div>`;
            return;
        }

        // Check Resolve connection
        let resolveConnected = false;
        try {
            const resolveStatus = await api('/api/resolve/status');
            resolveConnected = resolveStatus.running === true;
        } catch { /* ignore */ }

        statusEl.innerHTML = `<span style="color:#aaa;">Found ${linkedAssets.length} linked asset${linkedAssets.length !== 1 ? 's' : ''}.</span>` +
            (resolveConnected
                ? `  <span style="color:#6a6;">Success: Resolve connected</span>`
                : `  <span style="color:#a86;">Warning: Resolve not detected - relink will be skipped</span>`);

        // Show preview of what will happen
        let previewHtml = `<div style="font-size:12px;color:#888;padding:8px 0 4px;">This will:</div>
            <ul style="font-size:12px;color:#aaa;margin:0 0 12px 16px;padding:0;line-height:1.8;">
                <li>Copy each file into your vault folder structure</li>
                <li>Rename files using your project's naming convention</li>
                <li>Update CAM database with new paths</li>
                ${resolveConnected ? '<li>Relink clips in Resolve so the timeline keeps working</li>' : '<li style="color:#a86;">Skip Resolve relink (not connected)</li>'}
            </ul>
            <div style="border:1px solid #333;border-radius:4px;background:#1a1a1a;max-height:30vh;overflow-y:auto;">`;

        for (const asset of linkedAssets) {
            const shortPath = asset.file_path ? '...' + asset.file_path.split(/[/\\]/).slice(-3).join('/') : '(no path)';
            previewHtml += `
                <div style="display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid #222;">
                    <span style="font-size:12px;color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(asset.file_path || '')}">${esc(asset.original_name || asset.vault_name)}</span>
                    <span style="font-size:10px;color:#555;">${esc(shortPath)}</span>
                </div>`;
        }
        previewHtml += '</div>';
        contentEl.innerHTML = previewHtml;

        // Add execute button
        actionsEl.innerHTML = `
            <button onclick="document.getElementById('relinkModal')?.remove()"
                    style="padding:8px 16px;background:#333;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;">Cancel</button>
            <button id="relinkExecBtn" onclick="executeReorganizeAndRelink(${projectId}, ${resolveConnected})"
                    style="padding:8px 20px;background:#444;border:1px solid #555;border-radius:4px;color:#ddd;cursor:pointer;font-size:13px;font-weight:500;"> Reorganize ${linkedAssets.length} Files</button>
        `;

    } catch (e) {
        statusEl.innerHTML = `<span style="color:#a66;"> ${esc(e.message)}</span>`;
    }
}

async function executeReorganizeAndRelink(projectId, resolveConnected) {
    const statusEl = document.getElementById('relinkStatus');
    const btn = document.getElementById('relinkExecBtn');
    if (statusEl) statusEl.innerHTML = '<span style="color:#888;"> Reorganizing files...</span>';
    if (btn) { btn.disabled = true; btn.textContent = 'Working...'; }

    try {
        // Step 1: Call backend to reorganize linked assets
        const result = await api('/api/resolve/reorganize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId })
        });

        if (!result.success) {
            if (statusEl) statusEl.innerHTML = `<span style="color:#a66;"> ${esc(result.error)}</span>`;
            if (btn) { btn.disabled = false; btn.textContent = ' Retry'; }
            return;
        }

        let msg = ` ${result.moved} file${result.moved !== 1 ? 's' : ''} reorganized into vault`;

        // Step 2: If Resolve is connected and we have relink mappings, relink
        if (resolveConnected && result.relinkMap && Object.keys(result.relinkMap).length > 0) {
            if (statusEl) statusEl.innerHTML = '<span style="color:#888;"> Relinking in Resolve...</span>';

            try {
                const relinkResult = await api('/api/resolve/relink', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ relink_map: result.relinkMap })
                });

                if (relinkResult.success) {
                    msg += ` . ${relinkResult.relinked} clip${relinkResult.relinked !== 1 ? 's' : ''} relinked in Resolve`;
                    if (relinkResult.not_found > 0) {
                        msg += ` . ${relinkResult.not_found} not found in Resolve`;
                    }
                } else {
                    msg += ' . Warning: Resolve relink failed: ' + (relinkResult.error || 'unknown error');
                }
            } catch (e) {
                msg += ' . Warning: Resolve relink error: ' + e.message;
            }
        }

        if (statusEl) statusEl.innerHTML = `<span style="color:#6a6;">${esc(msg)}</span>`;
        showToast(msg, 6000);

        // Refresh the browser view
        if (window.loadProjectAssets) window.loadProjectAssets(projectId);

        setTimeout(() => {
            document.getElementById('relinkModal')?.remove();
        }, 3000);

    } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span style="color:#a66;"> ${esc(e.message)}</span>`;
        if (btn) { btn.disabled = false; btn.textContent = ' Retry'; }
        showToast('Reorganize error: ' + e.message, 5000);
    }
}


// ===========================================
//  EXPOSE ON WINDOW
// ===========================================

window.showContextMenu = showContextMenu;
window.showShotContextMenu = showShotContextMenu;
window.showSeqContextMenu = showSeqContextMenu;
window.showProjectContextMenu = showProjectContextMenu;
window.showMoveToSequenceModal = showMoveToSequenceModal;
window.executeMoveToSequence = executeMoveToSequence;
window.showAssignRoleModal = showAssignRoleModal;
window.executeAssignRole = executeAssignRole;
window.bulkDeleteAssets = bulkDeleteAssets;
window.showAddSequenceModal = showAddSequenceModal;
window.createSequence = createSequence;
window.showAddShotModal = showAddShotModal;
window.createShot = createShot;
window.deleteCurrentProject = deleteCurrentProject;
window.deleteShot = deleteShot;
window.deleteSequence = deleteSequence;
window.sendToResolve = sendToResolve;
window.executeSendToResolve = executeSendToResolve;
window.importFromResolve = importFromResolve;
window.executeImportFromResolve = executeImportFromResolve;
window.updateResolveImportCount = updateResolveImportCount;
window.reorganizeAndRelink = reorganizeAndRelink;
window.executeReorganizeAndRelink = executeReorganizeAndRelink;
window.showFilePathModal = showFilePathModal;
window.loadInComfyUI = loadInComfyUI;
window.renameShot = renameShot;
window.renameSequence = renameSequence;


