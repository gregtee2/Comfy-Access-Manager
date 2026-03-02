/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM — Crate Module
 * Asset staging/export collections. Crates are named collections of assets
 * that can be exported as a batch to a network folder.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, formatSize, formatDateTime, typeIcon, showToast } from './utils.js';
import { openPlayer } from './player.js';

// ═══════════════════════════════════════════
//  MODULE STATE
// ═══════════════════════════════════════════

let crates = [];
let activeCrateId = null;  // Currently viewed crate (null = normal project view)
let crateAssets = [];       // Assets in the active crate
let cratePanelOpen = true;
let _crateRefreshInterval = null;  // Auto-refresh timer while viewing a crate
let _sseSource = null;             // SSE connection for real-time crate updates
const CRATE_POLL_MS = 3000;        // Fallback poll (only if SSE fails)
const _thumbCacheBuster = Date.now(); // Bust browser cache for thumbnails

// ═══════════════════════════════════════════
//  CRATE LIST (left sidebar panel)
// ═══════════════════════════════════════════

export async function loadCrates() {
    try {
        crates = await api('/api/crates');
        renderCrateList();
    } catch (err) {
        console.error('Failed to load crates:', err);
    }
}

function renderCrateList() {
    const container = document.getElementById('crateList');
    if (!container) return;

    if (crates.length === 0) {
        container.innerHTML = '<div class="crate-empty">No crates yet. Click + to create one.</div>';
        return;
    }

    container.innerHTML = crates.map(c => `
        <div class="crate-item ${activeCrateId === c.id ? 'crate-active' : ''}"
             onclick="window.selectCrate(${c.id})"
             oncontextmenu="event.preventDefault();window.showCrateContextMenu(event, ${c.id})">
            <span class="crate-name">📦 ${esc(c.name)}</span>
            <span class="crate-count">${c.item_count}</span>
            <span class="crate-actions">
                <button onclick="event.stopPropagation();window.exportCratePrompt(${c.id})" title="Export crate to folder">📤</button>
                <button onclick="event.stopPropagation();window.deleteCratePrompt(${c.id})" title="Delete crate">✕</button>
            </span>
        </div>
    `).join('');
}

// ═══════════════════════════════════════════
//  PANEL TOGGLE
// ═══════════════════════════════════════════

function toggleCratePanel() {
    cratePanelOpen = !cratePanelOpen;
    const list = document.getElementById('crateList');
    const chevron = document.getElementById('crateChevron');
    if (list) list.classList.toggle('collapsed', !cratePanelOpen);
    if (chevron) chevron.classList.toggle('collapsed', !cratePanelOpen);
}

// ═══════════════════════════════════════════
//  CRATE CRUD
// ═══════════════════════════════════════════

async function createCratePrompt() {
    const name = prompt('Crate name:');
    if (!name || !name.trim()) return;

    try {
        await api('/api/crates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
        showToast('Crate created', 'success');
        await loadCrates();
    } catch (err) {
        showToast('Failed to create crate: ' + err.message, 'error');
    }
}

async function renameCrate(crateId) {
    const crate = crates.find(c => c.id === crateId);
    if (!crate) return;
    const name = prompt('Rename crate:', crate.name);
    if (!name || !name.trim() || name.trim() === crate.name) return;

    try {
        await api(`/api/crates/${crateId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
        showToast('Crate renamed', 'success');
        await loadCrates();
    } catch (err) {
        showToast('Failed to rename crate: ' + err.message, 'error');
    }
}

async function deleteCratePrompt(crateId) {
    const crate = crates.find(c => c.id === crateId);
    if (!crate) return;
    if (!confirm(`Delete crate "${crate.name}"? The assets themselves are NOT deleted.`)) return;

    try {
        await api(`/api/crates/${crateId}`, { method: 'DELETE' });
        showToast('Crate deleted', 'success');
        if (activeCrateId === crateId) {
            activeCrateId = null;
            crateAssets = [];
            exitCrateView();
        }
        await loadCrates();
    } catch (err) {
        showToast('Failed to delete crate: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════
//  VIEW CRATE CONTENTS
// ═══════════════════════════════════════════

async function selectCrate(crateId) {
    if (activeCrateId === crateId) {
        // Toggle off — go back to project view
        exitCrateView();
        return;
    }

    activeCrateId = crateId;
    renderCrateList();

    try {
        crateAssets = await api(`/api/crates/${crateId}/items`);
        const crate = crates.find(c => c.id === crateId);
        showCrateView(crate, crateAssets);
        _startCratePolling(crateId);
    } catch (err) {
        console.error('Failed to load crate items:', err);
        showToast('Failed to load crate items', 'error');
    }
}

function showCrateView(crate, items) {
    // Override the main browser area with crate contents
    const detail = document.getElementById('projectDetail');
    const breadcrumb = document.getElementById('browserBreadcrumb');
    const container = document.getElementById('assetContainer');
    const filterBar = document.getElementById('filterBar');

    // Show projectDetail (assetContainer lives inside it) but hide the project header
    if (detail) detail.style.display = 'block';
    const stickyHeader = detail?.querySelector('.project-sticky-header');
    if (stickyHeader) stickyHeader.style.display = 'none';

    // Update breadcrumb
    if (breadcrumb) {
        breadcrumb.innerHTML = `
            <span class="crumb" onclick="window.exitCrateView()">📦 Crates</span>
            <span class="crumb">${esc(crate.name)} <span style="opacity:.5">(${items.length})</span></span>
        `;
    }

    // Hide filter bar (not applicable in crate view)
    if (filterBar) filterBar.style.display = 'none';

    // Show the count
    const countEl = document.getElementById('assetCount');
    if (countEl) countEl.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

    // Render assets in the grid
    state.assets = items;
    state.selectedAssets = [];

    if (!container) return;

    if (items.length === 0) {
        container.className = 'asset-grid';
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-icon">📦</div>
                <p>This crate is empty. Right-click assets and choose "Add to Crate" to fill it.</p>
            </div>
        `;
        return;
    }

    // Render crate toolbar
    let toolbarHtml = `
        <div class="crate-toolbar" style="grid-column:1/-1;display:flex;gap:8px;margin-bottom:8px;align-items:center;">
            <button class="btn-primary" onclick="window.exportCratePrompt(${crate.id})" style="font-size:0.8rem;">📤 Export Crate</button>
            <button class="btn-primary" onclick="window.sendCrateToRV(${crate.id})" style="font-size:0.8rem;background:#334;border-color:#445;">🎬 Open in RV</button>
            <span style="flex:1;"></span>
            <button class="btn-primary" onclick="window.clearCratePrompt(${crate.id})" style="font-size:0.8rem;background:#422;border-color:#644;">🗑 Clear Crate</button>
        </div>
    `;

    if (state.viewMode === 'grid') {
        container.className = 'asset-grid';
        container.innerHTML = toolbarHtml + items.map((a, i) => `
            <div class="asset-card fade-in ${state.selectedAssets.includes(a.id) ? 'asset-selected' : ''}"
                data-aidx="${i}" onclick="handleAssetClick(event, ${i})" ondblclick="handleAssetDblClick(event, ${i})" oncontextmenu="showContextMenu(event, ${i})"
                draggable="true" ondragstart="onAssetDragStart(event, ${i})">
                <div class="asset-thumb">
                    <img src="/thumbnails/thumb_${a.id}.jpg?v=${_thumbCacheBuster}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <div class="thumb-placeholder" style="display:none">${typeIcon(a.media_type)}</div>
                    <span class="asset-type-badge ${a.media_type}">${a.media_type}</span>
                    ${a.role_name ? `<span class="asset-role-badge" style="background:${a.role_color || '#666'}">${a.role_icon || '🎭'} ${esc(a.role_code)}</span>` : ''}
                    ${a.duration ? `<span class="asset-duration">${a.duration}</span>` : ''}
                    ${a.file_ext && !a.duration ? `<span class="asset-ext-label">${a.file_ext.replace('.','')}</span>` : ''}
                </div>
                <div class="asset-info">
                    <div class="asset-name" title="${esc(a.vault_name)}">${esc(a.vault_name)}</div>
                    <div class="asset-meta">
                        ${a.project_code ? `<span style="color:var(--text-muted)">${esc(a.project_code)}</span>` : ''}
                        ${a.width ? `<span>${a.width}×${a.height}</span>` : ''}
                        <span>${formatSize(a.file_size)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    } else {
        container.className = 'asset-list';
        const headerRow = `
            <div class="asset-row asset-row-header">
                <div class="row-thumb">Media</div>
                <div class="row-show">Show</div>
                <div class="row-shot">Shot</div>
                <div class="row-name">Vault Name</div>
                <div class="row-role">Role</div>
                <div class="row-res">Resolution</div>
                <div class="row-size">Size</div>
                <div class="row-date">Added</div>
            </div>`;
        const rows = items.map((a, i) => `
            <div class="asset-row ${state.selectedAssets.includes(a.id) ? 'asset-selected' : ''}"
                data-aidx="${i}" onclick="handleAssetClick(event, ${i})" ondblclick="handleAssetDblClick(event, ${i})" oncontextmenu="showContextMenu(event, ${i})">
                <div class="row-thumb">
                    <img src="/thumbnails/thumb_${a.id}.jpg?v=${_thumbCacheBuster}" onerror="this.outerHTML='<span>${typeIcon(a.media_type)}</span>'">
                    <span class="row-type-pip ${a.media_type}">${a.file_ext || ''}</span>
                </div>
                <div class="row-show">${esc(a.project_code || '')}</div>
                <div class="row-shot">${esc(a.shot_name || a.shot_code || '—')}</div>
                <div class="row-name">${esc(a.vault_name)}</div>
                <div class="row-role">${a.role_name ? `<span class="role-tag" style="background:${a.role_color || '#666'}">${a.role_icon || ''} ${esc(a.role_code)}</span>` : ''}</div>
                <div class="row-res">${a.width ? `${a.width}×${a.height}` : '—'}</div>
                <div class="row-size">${formatSize(a.file_size)}</div>
                <div class="row-date">${formatDateTime(a.added_at)}</div>
            </div>
        `).join('');
        container.innerHTML = toolbarHtml + headerRow + rows;
    }
}

function exitCrateView() {
    _stopCratePolling();
    activeCrateId = null;
    crateAssets = [];
    renderCrateList();

    // Restore filter bar
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.style.display = '';

    // Restore project view
    if (state.currentProject) {
        window.loadProjectAssets?.(state.currentProject.id);
        const detail = document.getElementById('projectDetail');
        if (detail) detail.style.display = 'block';
        const stickyHeader = detail?.querySelector('.project-sticky-header');
        if (stickyHeader) stickyHeader.style.display = '';
        // Restore breadcrumb
        const breadcrumb = document.getElementById('browserBreadcrumb');
        if (breadcrumb) {
            breadcrumb.innerHTML = `
                <span class="crumb" onclick="switchTab('projects')">Projects</span>
                <span class="crumb">${esc(state.currentProject.name)}</span>
            `;
        }
    } else {
        // Go back to projects tab
        window.switchTab?.('projects');
    }
}

// ═══════════════════════════════════════════
//  ADD TO CRATE (called from context menu)
// ═══════════════════════════════════════════

export function showAddToCrateMenu(event, assetIds) {
    // Remove existing sub-menu if any
    document.querySelectorAll('.crate-add-menu').forEach(el => el.remove());

    // Re-fetch crates to ensure list is current
    api('/api/crates').then(fresh => {
        crates = fresh || [];
        _buildCrateSubmenu(event, assetIds);
    }).catch(() => {
        _buildCrateSubmenu(event, assetIds);
    });
}

function _buildCrateSubmenu(event, assetIds) {
    const menu = document.createElement('div');
    menu.className = 'context-menu crate-add-menu';

    let html = '<div class="ctx-header" style="padding:4px 12px;font-size:0.75rem;opacity:.5;pointer-events:none;">Add to Crate</div>';
    if (crates.length === 0) {
        html += '<div class="ctx-item" style="opacity:.5;pointer-events:none;">No crates yet</div>';
    } else {
        for (const c of crates) {
            html += `<div class="ctx-item" data-crate-id="${c.id}">📦 ${esc(c.name)} <span style="opacity:.5">(${c.item_count})</span></div>`;
        }
    }
    html += `<div class="ctx-separator"></div>`;
    html += `<div class="ctx-item" data-crate-id="new">➕ New Crate...</div>`;
    menu.innerHTML = html;

    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
    document.body.appendChild(menu);

    // Position adjustment
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    });

    // Click handler for items
    menu.addEventListener('pointerdown', async (e) => {
        const item = e.target.closest('[data-crate-id]');
        if (!item) return;
        e.stopPropagation();
        menu.remove();
        removeDismissListener();

        const crateId = item.dataset.crateId;
        const count = assetIds.length;

        if (crateId === 'new') {
            const name = prompt('New crate name:');
            if (!name || !name.trim()) return;
            try {
                const newCrate = await api('/api/crates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
                await addToCrate(newCrate.id, assetIds);
                await loadCrates();
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        } else {
            await addToCrate(parseInt(crateId), assetIds);
            await loadCrates();
        }
    });

    // Prevent the menu itself from propagating clicks that would dismiss it
    menu.addEventListener('click', (e) => e.stopPropagation());

    // Dismiss on click outside — use pointerdown on a delay so the current
    // click event (that opened this menu) doesn't immediately close it
    function dismiss(e) {
        if (menu.contains(e.target)) return;
        menu.remove();
        removeDismissListener();
    }
    function removeDismissListener() {
        document.removeEventListener('pointerdown', dismiss, true);
    }
    setTimeout(() => {
        document.addEventListener('pointerdown', dismiss, true);
    }, 200);
}

async function addToCrate(crateId, assetIds) {
    try {
        const result = await api(`/api/crates/${crateId}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds }) });
        const count = result.added || assetIds.length;
        showToast(`Added ${count} asset${count !== 1 ? 's' : ''} to crate`, 'success');
        // Refresh crate sidebar counts
        await loadCrates();
    } catch (err) {
        showToast('Failed to add to crate: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════
//  REMOVE FROM CRATE
// ═══════════════════════════════════════════

export async function removeFromCrate(assetIds) {
    if (!activeCrateId) return;
    const crateId = activeCrateId;
    try {
        await api(`/api/crates/${crateId}/items`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds })
        });
        showToast(`Removed ${assetIds.length} item${assetIds.length !== 1 ? 's' : ''}`, 'success');
        // Refresh crate sidebar counts
        await loadCrates();
        // Reload this crate's contents without toggling out of crate view
        try {
            crateAssets = await api(`/api/crates/${crateId}/items`);
            const crate = crates.find(c => c.id === crateId);
            if (crate) showCrateView(crate, crateAssets);
        } catch (_) { /* crate view refresh failed, non-critical */ }
    } catch (err) {
        showToast('Failed to remove: ' + err.message, 'error');
    }
}

async function clearCratePrompt(crateId) {
    const crate = crates.find(c => c.id === crateId);
    if (!crate) return;
    if (!confirm(`Remove all items from "${crate.name}"? Assets are NOT deleted.`)) return;

    try {
        const items = await api(`/api/crates/${crateId}/items`);
        const assetIds = items.map(i => i.id);
        if (assetIds.length > 0) {
            await api(`/api/crates/${crateId}/items`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assetIds })
            });
        }
        showToast('Crate cleared', 'success');
        await loadCrates();
        if (activeCrateId === crateId) await selectCrate(crateId);
    } catch (err) {
        showToast('Failed to clear crate: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════
//  EXPORT CRATE TO FOLDER
// ═══════════════════════════════════════════

async function exportCratePrompt(crateId) {
    const crate = crates.find(c => c.id === crateId);
    if (!crate) return;

    // Build a modal with folder picker
    const modal = document.createElement('div');
    modal.id = 'crateExportModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
        <div style="background:var(--bg-card,#222);border-radius:12px;padding:24px;max-width:500px;width:90%;border:1px solid var(--border);">
            <h3 style="margin:0 0 16px;">📤 Export Crate: ${esc(crate.name)}</h3>
            <p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 16px;">
                Copies all ${crate.item_count} file${crate.item_count !== 1 ? 's' : ''} to the target folder with their vault names.
            </p>
            <div style="display:flex;gap:8px;margin-bottom:16px;">
                <input type="text" id="crateExportPath" placeholder="Target folder path..." style="flex:1;padding:8px 10px;background:var(--bg-darker);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.85rem;">
                <button class="btn-primary" onclick="window.openFolderPicker('crateExportPath')" style="white-space:nowrap;">📂 Browse</button>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button class="btn-primary" onclick="this.closest('#crateExportModal').remove()" style="background:#333;">Cancel</button>
                <button class="btn-primary" id="crateExportBtn" onclick="window.executeCrateExport(${crateId})">📤 Export</button>
            </div>
            <div id="crateExportStatus" style="margin-top:12px;font-size:0.8rem;color:var(--text-muted);display:none;"></div>
        </div>
    `;

    document.body.appendChild(modal);
}

async function executeCrateExport(crateId) {
    const pathInput = document.getElementById('crateExportPath');
    const statusEl = document.getElementById('crateExportStatus');
    const btn = document.getElementById('crateExportBtn');
    const targetDir = pathInput?.value?.trim();

    if (!targetDir) { showToast('Please select a target folder', 'error'); return; }

    btn.disabled = true;
    btn.textContent = '⏳ Exporting...';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Copying files...';

    try {
        const result = await api(`/api/crates/${crateId}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetDir })
        });

        if (result.errors?.length > 0) {
            statusEl.innerHTML = `✅ Copied ${result.copied}/${result.total} files<br><span style="color:#b85c5c;">⚠️ ${result.errors.length} error(s): ${result.errors.map(e => e.file).join(', ')}</span>`;
        } else {
            statusEl.textContent = `✅ Copied ${result.copied}/${result.total} files to ${targetDir}`;
        }
        showToast(`Exported ${result.copied} files`, 'success');
        btn.textContent = '✅ Done';
        setTimeout(() => {
            document.getElementById('crateExportModal')?.remove();
        }, 2000);
    } catch (err) {
        statusEl.textContent = `❌ Export failed: ${err.message}`;
        statusEl.style.color = '#b85c5c';
        btn.disabled = false;
        btn.textContent = '📤 Export';
        showToast('Export failed: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════
//  SEND CRATE TO RV
// ═══════════════════════════════════════════

async function sendCrateToRV(crateId) {
    try {
        const items = await api(`/api/crates/${crateId}/items`);
        if (items.length === 0) { showToast('Crate is empty', 'error'); return; }

        // Use the first asset ID and send all as a set
        const assetIds = items.map(i => i.id);
        window.sendSelectedToRV?.('set');
        // Override selection temporarily
        const prevSelection = [...state.selectedAssets];
        state.selectedAssets = assetIds;
        window.sendSelectedToRV?.('set');
        state.selectedAssets = prevSelection;
    } catch (err) {
        showToast('Failed to send to RV: ' + err.message, 'error');
    }
}

// ═══════════════════════════════════════════
//  CRATE CONTEXT MENU (right-click on crate item in sidebar)
// ═══════════════════════════════════════════

function showCrateContextMenu(event, crateId) {
    event.preventDefault();
    event.stopPropagation();

    document.querySelectorAll('.context-menu, .ctx-menu').forEach(el => el.remove());

    const menu = document.createElement('div');
    menu.className = 'context-menu';

    const crate = crates.find(c => c.id === crateId);
    menu.innerHTML = `
        <div class="ctx-item" data-action="open">📦 Open Crate</div>
        <div class="ctx-item" data-action="export">📤 Export to Folder</div>
        <div class="ctx-item" data-action="rv">🎬 Open in RV</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="rename">✏️ Rename</div>
        <div class="ctx-item ctx-danger" data-action="delete">🗑 Delete Crate</div>
    `;

    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
    document.body.appendChild(menu);

    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    });

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        menu.remove();

        switch (item.dataset.action) {
            case 'open': selectCrate(crateId); break;
            case 'export': exportCratePrompt(crateId); break;
            case 'rv': sendCrateToRV(crateId); break;
            case 'rename': renameCrate(crateId); break;
            case 'delete': deleteCratePrompt(crateId); break;
        }
    });

    setTimeout(() => {
        const dismiss = () => { menu.remove(); document.removeEventListener('click', dismiss); };
        document.addEventListener('click', dismiss, { once: true });
    }, 50);
}

// ═══════════════════════════════════════════
//  HELPERS / ACCESSORS
// ═══════════════════════════════════════════

/** Clear crate state without triggering asset reload (for use by tree navigation) */
export function clearCrateState() {
    if (!activeCrateId) return;
    _stopCratePolling();
    activeCrateId = null;
    crateAssets = [];
    renderCrateList();
    // Restore project sticky header that showCrateView hid
    const detail = document.getElementById('projectDetail');
    const stickyHeader = detail?.querySelector('.project-sticky-header');
    if (stickyHeader) stickyHeader.style.display = '';
    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.style.display = '';
}

/** Returns the active crate ID (or null if in project view) */
export function getActiveCrateId() { return activeCrateId; }

/** Returns loaded crates list */
export function getCrates() { return crates; }

// ═══════════════════════════════════════════
//  REAL-TIME UPDATES (SSE push from server)
// ═══════════════════════════════════════════

function _connectSSE() {
    if (_sseSource) return;  // already connected
    _sseSource = new EventSource('/api/crates/events');
    _sseSource.onopen = () => console.log('[Crate] SSE connected');
    _sseSource.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('[Crate] SSE event received:', data);
            // Only refresh if we're viewing the affected crate
            if (activeCrateId && data.crateId === activeCrateId) {
                await _refreshActiveCrate();
            }
            // Also refresh the sidebar count for any crate change
            await loadCrates();
        } catch (_) { /* ignore parse errors */ }
    };
    _sseSource.onerror = () => {
        console.warn('[Crate] SSE disconnected, falling back to polling');
        // SSE disconnected — close and fall back to polling
        _disconnectSSE();
        _startCratePolling(activeCrateId);
    };
}

function _disconnectSSE() {
    if (_sseSource) {
        _sseSource.close();
        _sseSource = null;
    }
}

async function _refreshActiveCrate() {
    if (!activeCrateId) return;
    try {
        const fresh = await api(`/api/crates/${activeCrateId}/items`);
        if (fresh.length !== crateAssets.length ||
            JSON.stringify(fresh.map(a => a.id)) !== JSON.stringify(crateAssets.map(a => a.id))) {
            crateAssets = fresh;
            const crate = crates.find(c => c.id === activeCrateId);
            if (crate) {
                crate.item_count = fresh.length;
                showCrateView(crate, crateAssets);
                renderCrateList();
            }
        }
    } catch (_) { /* ignore */ }
}

// Connect SSE when module loads — stays open so background adds are instant
_connectSSE();

// ═══════════════════════════════════════════
//  FALLBACK POLLING (only used if SSE fails)
// ═══════════════════════════════════════════

function _startCratePolling(crateId) {
    if (_sseSource) return;      // SSE is active — no need to poll
    _stopCratePolling();
    _crateRefreshInterval = setInterval(async () => {
        if (activeCrateId !== crateId) { _stopCratePolling(); return; }
        await _refreshActiveCrate();
    }, CRATE_POLL_MS);
}

function _stopCratePolling() {
    if (_crateRefreshInterval) {
        clearInterval(_crateRefreshInterval);
        _crateRefreshInterval = null;
    }
}

// When tab becomes visible again, try to reconnect SSE if it died
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!_sseSource) _connectSSE();
        if (activeCrateId) _refreshActiveCrate();
    }
});

// ═══════════════════════════════════════════
//  WINDOW EXPORTS (for onclick handlers)
// ═══════════════════════════════════════════

window.toggleCratePanel = toggleCratePanel;
window.createCratePrompt = createCratePrompt;
window.selectCrate = selectCrate;
window.exitCrateView = exitCrateView;
window.deleteCratePrompt = deleteCratePrompt;
window.exportCratePrompt = exportCratePrompt;
window.executeCrateExport = executeCrateExport;
window.clearCratePrompt = clearCratePrompt;
window.sendCrateToRV = sendCrateToRV;
window.showCrateContextMenu = showCrateContextMenu;
window.showAddToCrateMenu = showAddToCrateMenu;
window.removeFromCrate = removeFromCrate;
window.getActiveCrateId = getActiveCrateId;
