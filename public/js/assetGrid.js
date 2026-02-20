/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM - Asset Grid Module
 * Browser tab: project detail, asset loading/rendering, selection,
 * drag & drop, star toggle, polling for new assets.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, formatSize, formatDuration, formatDateTime, typeIcon, showToast } from './utils.js';
import { openPlayer } from './player.js';
import { getActiveCrateId } from './crate.js';

// ===========================================
//  PROJECT DETAIL / BROWSER
// ===========================================

export async function openProject(id) {
    try {
        const project = await api(`/api/projects/${id}`);
        state.currentProject = project;
        state.currentSequence = null;
        state.currentShot = null;

        // Expand in tree
        window._treeExpandNode?.(`p_${id}`);
        window.switchTab('browser');
        renderProjectDetail(project);
        loadProjectAssets(project.id);
        window.loadTree?.();
    } catch (err) {
        console.error('Failed to open project:', err);
    }
}

export function renderProjectDetail(project) {
    const detail = document.getElementById('projectDetail');
    detail.style.display = 'block';

    // Breadcrumb
    document.getElementById('browserBreadcrumb').innerHTML = `
        <span class="crumb" onclick="switchTab('projects')">Projects</span>
        <span class="crumb">${esc(project.name)}</span>
    `;

    document.getElementById('projectTitle').textContent = project.name;
    document.getElementById('projectCode').textContent = project.code;
    document.getElementById('projectType').textContent = project.type.replace('_', ' ');

    // Show vault path
    const vaultRoot = state.settings?.vault_root || '';
    const sep = vaultRoot.includes('/') ? '/' : '\\';
    const projectFolder = vaultRoot ? `${vaultRoot}${vaultRoot.endsWith('\\') || vaultRoot.endsWith('/') ? '' : sep}${project.code}` : '';
    document.getElementById('projectPath').textContent = projectFolder ? ` ${projectFolder}` : '';
    document.getElementById('projectPath').title = projectFolder;

    // Sequences panel
    const seqPanel = document.getElementById('sequencesPanel');
    const seqList = document.getElementById('sequenceList');
    const filterSeq = document.getElementById('filterSequence');

    // Restore collapse state helper
    const _syncSeqToggle = () => {
        const open = localStorage.getItem('cam_seqPanelOpen') === '1';
        seqList.style.display = open ? 'flex' : 'none';
        const tog = document.getElementById('seqPanelToggle');
        const arr = document.getElementById('seqPanelArrow');
        if (tog) tog.classList.toggle('open', open);
        if (arr) arr.textContent = open ? '\u25bc' : '\u25b6';
    };

    if (project.type !== 'simple' && project.sequences?.length > 0) {
        seqPanel.style.display = 'block';
        filterSeq.style.display = 'block';

        seqList.innerHTML = project.sequences.map(s => {
            const isActive = state.currentSequence?.id === s.id;
            let shotHtml = '';
            if (isActive && s.shots?.length > 0) {
                shotHtml = `<div class="shot-chips">${s.shots.map(sh => {
                    const isShActive = state.currentShot?.id === sh.id;
                    const rolePills = (sh.roles || []).map(r => {
                        const c = r.role_color || '#888';
                        return `<span style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:3px;background:${c}33;color:${c};border:1px solid ${c}55;margin:1px 2px 0 0;line-height:1.3;">${r.role_icon || ''} ${r.role_code || r.role_name}</span>`;
                    }).join('');
                    return `
                    <span class="shot-chip ${isShActive ? 'active' : ''}" 
                          onclick="event.stopPropagation();selectShot(${s.id}, ${sh.id})"
                          oncontextmenu="event.stopPropagation();showShotContextMenu(event, ${s.id}, ${sh.id}, '${esc(sh.name).replace(/'/g, "\\'")}')"
                          ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                          ondrop="event.stopPropagation();onShotDrop(event, ${s.id}, ${sh.id})"
                          style="display:inline-flex;flex-direction:column;align-items:flex-start;"
                          ><span> ${esc(sh.name)} <span class="chip-count">${sh.asset_count || 0}</span></span>${rolePills ? `<span style="margin-top:2px;">${rolePills}</span>` : ''}</span>`;
                }).join('')}
                    <span class="shot-chip shot-add" onclick="event.stopPropagation();showAddShotModal(${s.id})">+ Shot</span>
                </div>`;
            } else if (isActive) {
                shotHtml = `<div class="shot-chips">
                    <span class="shot-chip shot-add" onclick="event.stopPropagation();showAddShotModal(${s.id})">+ Shot</span>
                </div>`;
            }
            // Role pills for this sequence (always visible, not just when active)
            let seqRolePills = '';
            if (s.roles?.length > 0) {
                seqRolePills = `<div style="margin:2px 0 4px 24px;display:flex;flex-wrap:wrap;gap:2px;">${s.roles.map(r => {
                    const c = r.role_color || '#888';
                    return `<span style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:3px;background:${c}33;color:${c};border:1px solid ${c}55;line-height:1.3;">${r.role_icon || ''} ${r.role_code || r.role_name} <span style="opacity:.6">${r.asset_count}</span></span>`;
                }).join('')}</div>`;
            }
            return `
            <div class="sequence-chip ${isActive ? 'active' : ''}" 
                 onclick="selectSequence(${s.id})"
                 oncontextmenu="showSeqContextMenu(event, ${s.id}, '${esc(s.name).replace(/'/g, "\\'")}')"
                 ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                 ondrop="onSeqDrop(event, ${s.id})">
                 ${esc(s.name)} <span style="opacity:.5;font-size:.8em">${esc(s.code)}</span>
                <span class="chip-count">${s.asset_count || 0}</span>
            </div>${seqRolePills}${shotHtml}`;
        }).join('');

        // Populate dropdown
        filterSeq.innerHTML = '<option value="">All Sequences</option>' +
            project.sequences.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
    } else if (project.orphanShots?.length > 0) {
        // Fallback: shots without sequences - show directly with role pills
        seqPanel.style.display = 'block';
        filterSeq.style.display = 'none';
        seqList.innerHTML = project.orphanShots.map(sh => {
            const isShActive = state.currentShot?.id === sh.id;
            const rolePills = (sh.roles || []).map(r => {
                const c = r.role_color || '#888';
                return `<span style="display:inline-block;font-size:9px;padding:1px 5px;border-radius:3px;background:${c}33;color:${c};border:1px solid ${c}55;margin:1px 2px 0 0;line-height:1.3;">${r.role_icon || ''} ${r.role_code || r.role_name} <span style="opacity:.6">${r.asset_count}</span></span>`;
            }).join('');
            return `
            <span class="shot-chip ${isShActive ? 'active' : ''}" 
                  onclick="event.stopPropagation();selectShot(null, ${sh.id})"
                  style="display:inline-flex;flex-direction:column;align-items:flex-start;margin:2px;"
                  > ${esc(sh.name)} <span class="chip-count">${sh.asset_count || 0}</span>${rolePills ? `<span style="margin-top:2px;">${rolePills}</span>` : ''}</span>`;
        }).join('');
    } else {
        seqPanel.style.display = project.type === 'simple' ? 'none' : 'block';
        seqList.innerHTML = project.type === 'simple' ? '' :
            '<div style="color:var(--text-muted);font-size:0.82rem;padding:8px;">No sequences yet. Click "+ Sequence" to add one.</div>';
        filterSeq.style.display = 'none';
    }
    _syncSeqToggle();
}

export async function selectSequence(seqId) {
    const db = state.currentProject;
    const seq = db.sequences.find(s => s.id === seqId);
    state.currentSequence = state.currentSequence?.id === seqId ? null : seq;
    state.currentShot = null;
    state.currentRole = null;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
}

export function selectShot(seqId, shotId) {
    const seq = state.currentProject?.sequences?.find(s => s.id === seqId);
    if (!seq) return;
    state.currentSequence = seq;
    const shot = seq.shots?.find(sh => sh.id === shotId);
    state.currentShot = state.currentShot?.id === shotId ? null : shot;
    state.currentRole = null;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
}

// ===========================================
//  ASSET LOADING & RENDERING
// ===========================================

export async function loadProjectAssets(projectId) {
    // Don't overwrite the asset grid when viewing a crate
    if (getActiveCrateId()) return;

    const params = new URLSearchParams({ project_id: projectId });

    const mediaType = document.getElementById('filterMediaType')?.value;
    const search = document.getElementById('searchInput')?.value;
    const seqId = state.currentSequence?.id || document.getElementById('filterSequence')?.value;

    if (mediaType) params.set('media_type', mediaType);
    if (search) params.set('search', search);
    if (seqId) {
        params.set('sequence_id', seqId);
        if (!state.currentShot) params.set('unassigned_shot', '1');
    }
    else params.set('unassigned', '1');
    if (state.currentShot) params.set('shot_id', state.currentShot.id);
    if (state.currentRole) params.set('role_id', state.currentRole.id);

    try {
        const result = await api(`/api/assets?${params}`);
        state.assets = result.assets;
        renderAssets();
        const countEl = document.getElementById('assetCount');
        if (countEl) countEl.textContent = `${result.assets.length} asset${result.assets.length !== 1 ? 's' : ''}`;
    } catch (err) {
        console.error('Failed to load assets:', err);
    }
}

function filterAssets() {
    if (state.currentProject) {
        loadProjectAssets(state.currentProject.id);
    }
}

function setView(mode) {
    state.viewMode = mode;
    document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    renderAssets();
}

/**
 * Lightweight selection update - toggles CSS classes on existing DOM elements
 * without rebuilding the entire grid. Eliminates flicker/jiggle on click.
 */
export function updateSelectionClasses() {
    const container = document.getElementById('assetContainer');
    if (!container) return;
    const selectedSet = new Set(state.selectedAssets);
    container.querySelectorAll('[data-aidx]').forEach(el => {
        const idx = parseInt(el.dataset.aidx, 10);
        const asset = state.assets[idx];
        if (!asset) return;
        el.classList.toggle('asset-selected', selectedSet.has(asset.id));
    });
    updateSelectionToolbar();
}

function renderAssets() {
    const container = document.getElementById('assetContainer');

    if (state.assets.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-icon"></div>
                <p>No assets yet. Import some files to get started!</p>
            </div>
        `;
        container.className = 'asset-grid';
        return;
    }

    if (state.viewMode === 'grid') {
        container.className = 'asset-grid';
        container.innerHTML = state.assets.map((a, i) => `
            <div class="asset-card fade-in ${state.selectedAssets.includes(a.id) ? 'asset-selected' : ''}" 
                data-aidx="${i}" onclick="handleAssetClick(event, ${i})" ondblclick="handleAssetDblClick(event, ${i})" oncontextmenu="showContextMenu(event, ${i})"
                draggable="true" ondragstart="onAssetDragStart(event, ${i})">
                <div class="asset-thumb" ${a.media_type === 'video' ? `data-duration="${a.duration || 0}" data-codec="${a.codec || ''}" onmouseenter="handleVideoHover(this, ${a.id})" onmousemove="handleVideoMove(event, this)" onmouseleave="handleVideoLeave(this)"` : ''}>
                    <img src="/api/assets/${a.id}/thumbnail" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <div class="thumb-placeholder" style="display:none">${typeIcon(a.media_type)}</div>
                    <span class="asset-type-badge ${a.media_type}">${a.media_type}</span>
                    ${a.is_linked ? '<span class="asset-link-badge" title="Linked - file remains at original location"></span>' : ''}
                    ${a.role_name ? `<span class="asset-role-badge" style="background:${a.role_color || '#666'}">${a.role_icon || ''} ${esc(a.role_code)}</span>` : ''}
                    ${a.duration ? `<span class="asset-duration">${formatDuration(a.duration)}</span>` : ''}
                </div>
                <button class="asset-star" onclick="event.stopPropagation();toggleStar(${a.id})">${a.starred ? '*' : '*'}</button>
                <div class="asset-info">
                    <div class="asset-name" title="${esc(a.vault_name)}">${esc(a.vault_name)}</div>
                    <div class="asset-meta">
                        ${a.width ? `<span>${a.width}x${a.height}</span>` : ''}
                        <span>${formatSize(a.file_size)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    } else {
        container.className = 'asset-list';
        const headerRow = `
            <div class="asset-row asset-row-header">
                <div class="row-id">ID</div>
                <div class="row-thumb">Media</div>
                <div class="row-audio">Audio</div>
                <div class="row-show">Show</div>
                <div class="row-shot">Shot</div>
                <div class="row-name">Vault Name</div>
                <div class="row-role">Role</div>
                <div class="row-res">Resolution</div>
                <div class="row-size">Size</div>
                <div class="row-date">Created</div>
                <div class="row-star"></div>
            </div>`;
        const rows = state.assets.map((a, i) => {
            const hasAudio = a.media_type === 'audio' || (a.media_type === 'video' && a.codec && !a.codec.toLowerCase().includes('mjpeg'));
            return `
            <div class="asset-row ${state.selectedAssets.includes(a.id) ? 'asset-selected' : ''}" 
                data-aidx="${i}" onclick="handleAssetClick(event, ${i})" ondblclick="handleAssetDblClick(event, ${i})" oncontextmenu="showContextMenu(event, ${i})"
                draggable="true" ondragstart="onAssetDragStart(event, ${i})">
                <div class="row-id">${a.id}</div>
                <div class="row-thumb" ${a.media_type === 'video' ? `data-duration="${a.duration || 0}" data-codec="${a.codec || ''}" onmouseenter="handleVideoHover(this, ${a.id})" onmousemove="handleVideoMove(event, this)" onmouseleave="handleVideoLeave(this)"` : ''}>
                    <img src="/api/assets/${a.id}/thumbnail" onerror="this.outerHTML='<span>${typeIcon(a.media_type)}</span>'">
                    <span class="row-type-pip ${a.media_type}" title="${a.media_type}">${a.file_ext || ''}</span>
                </div>
                <div class="row-audio">${hasAudio ? '' : '<span style="opacity:.25"></span>'}</div>
                <div class="row-show">${esc(a.project_code || '')}</div>
                <div class="row-shot">${esc(a.shot_name || a.shot_code || '-')}</div>
                <div class="row-name">${a.is_linked ? ' ' : ''}${esc(a.vault_name)}</div>
                <div class="row-role">${a.role_name ? `<span class="role-tag" style="background:${a.role_color || '#666'}">${a.role_icon || ''} ${esc(a.role_code)}</span>` : ''}</div>
                <div class="row-res">${a.width ? `${a.width}x${a.height}` : '-'}</div>
                <div class="row-size">${formatSize(a.file_size)}</div>
                <div class="row-date">${formatDateTime(a.created_at)}</div>
                <button class="asset-star" onclick="event.stopPropagation();toggleStar(${a.id})" style="position:static">${a.starred ? '*' : '*'}</button>
            </div>`;
        }).join('');
        container.innerHTML = headerRow + rows;
    }

    updateSelectionToolbar();
}

// Click on empty space in the grid -> deselect all
// (suppressed briefly after a marquee drag so the click doesn't undo the selection)
let _suppressNextClick = false;
document.addEventListener('click', (e) => {
    if (_suppressNextClick) { _suppressNextClick = false; return; }
    const container = document.getElementById('assetContainer');
    if (!container) return;
    
    const isCard = e.target.closest('[data-aidx]');
    const isToolbar = e.target.closest('.selection-toolbar');
    const isHeader = e.target.closest('.project-sticky-header');
    const isBreadcrumb = e.target.closest('.breadcrumb');
    const isFilterBar = e.target.closest('.filter-bar');
    const inBrowserMain = e.target.closest('.browser-main');
    
    if (inBrowserMain && !isCard && !isToolbar && !isHeader && !isBreadcrumb && !isFilterBar) {
        if (state.selectedAssets.length > 0) {
            state.selectedAssets = [];
            state.lastClickedAsset = -1;
            updateSelectionClasses();
        }
    }
});

// ===========================================
//  MARQUEE (rubber-band) DRAG SELECTION
// ===========================================

(function initMarqueeSelection() {
    let active = false;
    let startX = 0, startY = 0;
    let marqueeEl = null;
    const THRESHOLD = 5; // px of movement before marquee activates
    let thresholdMet = false;
    let priorSelected = []; // selection before drag (for shift-additive)
    let dragMode = 'normal'; // 'normal', 'add', 'remove'

    function getScrollParent() {
        return document.querySelector('.browser-main') || document.documentElement;
    }

    function createMarquee() {
        const el = document.createElement('div');
        el.className = 'marquee-selection';
        const wrap = document.getElementById('assetContainerWrap');
        (wrap || document.body).appendChild(el);
        return el;
    }

    function updateRect(e) {
        const wrap = document.getElementById('assetContainerWrap');
        if (!wrap || !marqueeEl) return;
        const wr = wrap.getBoundingClientRect();
        const curX = e.clientX - wr.left;
        const curY = e.clientY - wr.top;
        const x = Math.min(startX, curX);
        const y = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);
        marqueeEl.style.left = x + 'px';
        marqueeEl.style.top = y + 'px';
        marqueeEl.style.width = w + 'px';
        marqueeEl.style.height = h + 'px';
    }

    function rectsIntersect(a, b) {
        return !(a.right < b.left || a.left > b.right ||
                 a.bottom < b.top || a.top > b.bottom);
    }

    function selectIntersecting() {
        const wrap = document.getElementById('assetContainerWrap');
        const container = document.getElementById('assetContainer');
        if (!wrap || !container || !marqueeEl) return;
        const mRect = marqueeEl.getBoundingClientRect();
        const hits = [];
        container.querySelectorAll('[data-aidx]').forEach(el => {
            const elRect = el.getBoundingClientRect();
            if (rectsIntersect(mRect, elRect)) {
                const idx = parseInt(el.dataset.aidx, 10);
                const asset = state.assets[idx];
                if (asset) hits.push(asset.id);
            }
        });
        
        if (dragMode === 'remove') {
            const hitSet = new Set(hits);
            state.selectedAssets = priorSelected.filter(id => !hitSet.has(id));
        } else if (dragMode === 'add') {
            const merged = new Set([...priorSelected, ...hits]);
            state.selectedAssets = [...merged];
        } else {
            state.selectedAssets = hits;
        }
        updateSelectionClasses();
    }

    // -- Auto-scroll while dragging near edges --
    let scrollRAF = null;
    function autoScroll(e) {
        const sp = getScrollParent();
        const rect = sp.getBoundingClientRect ? sp.getBoundingClientRect()
            : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
        const margin = 40; // px from edge to start scrolling
        const speed = 8;   // px per frame
        let dx = 0, dy = 0;
        if (e.clientY < rect.top + margin) dy = -speed;
        else if (e.clientY > rect.bottom - margin) dy = speed;
        if (dx !== 0 || dy !== 0) {
            sp.scrollTop += dy;
            sp.scrollLeft += dx;
        }
    }

    document.addEventListener('mousedown', (e) => {
        const container = document.getElementById('assetContainer');
        if (!container) return;
        if (e.button !== 0) return;               // left-click only

        const onCard = e.target.closest('[data-aidx]');
        const isModifier = e.shiftKey || e.ctrlKey || e.metaKey;
        if (onCard && !isModifier) return; // started on a card without modifier -> allow native drag
        
        if (e.target.closest('.asset-star')) return;  // star button
        if (e.target.closest('.selection-toolbar')) return;
        if (e.target.closest('.project-sticky-header')) return;
        if (e.target.closest('.sequence-chip')) return;
        if (e.target.closest('.shot-chip')) return;
        if (e.target.closest('.filter-bar')) return;
        if (e.target.closest('.breadcrumb')) return;

        // Must be inside the asset container area or browser-main
        const wrap = document.getElementById('assetContainerWrap');
        const browserMain = e.target.closest('.browser-main');
        if (!wrap && !browserMain) return;
        
        let isInside = false;
        if (wrap && wrap.contains(e.target)) isInside = true;
        if (browserMain && browserMain.contains(e.target)) isInside = true;
        if (!isInside) return;

        // If we are on a card and holding modifier, prevent default to stop native drag-and-drop
        if (onCard && isModifier) {
            e.preventDefault();
        }

        const wr = wrap ? wrap.getBoundingClientRect() : browserMain.getBoundingClientRect();
        startX = e.clientX - wr.left;
        startY = e.clientY - wr.top;
        active = true;
        thresholdMet = false;
        
        if (e.ctrlKey || e.metaKey) dragMode = 'remove';
        else if (e.shiftKey) dragMode = 'add';
        else dragMode = 'normal';
        
        priorSelected = (dragMode !== 'normal') ? [...state.selectedAssets] : [];
    });

    document.addEventListener('mousemove', (e) => {
        if (!active) return;
        const wrap = document.getElementById('assetContainerWrap');
        if (!wrap) { active = false; return; }
        const wr = wrap.getBoundingClientRect();
        const dx = (e.clientX - wr.left) - startX;
        const dy = (e.clientY - wr.top) - startY;
        if (!thresholdMet) {
            if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
            thresholdMet = true;
            marqueeEl = createMarquee();
            document.body.classList.add('marquee-active');
        }
        updateRect(e);
        selectIntersecting();
        autoScroll(e);
    });

    document.addEventListener('mouseup', (e) => {
        if (!active) return;
        const didMarquee = thresholdMet;
        active = false;
        if (marqueeEl) {
            selectIntersecting();
            marqueeEl.remove();
            marqueeEl = null;
        }
        document.body.classList.remove('marquee-active');
        priorSelected = [];
        dragMode = 'normal';
        // Suppress the click event that fires right after mouseup
        // so it doesn't clear the selection we just made
        if (didMarquee) _suppressNextClick = true;
        if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; }
    });
})();

// ===========================================
//  ASSET SELECTION (click, shift-click, bulk)
// ===========================================

function handleAssetClick(event, assetIdx) {
    if (_suppressNextClick) return;

    const asset = state.assets[assetIdx];
    if (!asset) return;

    if (event.ctrlKey || event.metaKey) {
        toggleAssetSelection(asset.id);
        state.lastClickedAsset = assetIdx;
        updateSelectionClasses();
        return;
    }

    if (event.shiftKey && state.lastClickedAsset >= 0) {
        const start = Math.min(state.lastClickedAsset, assetIdx);
        const end = Math.max(state.lastClickedAsset, assetIdx);
        state.selectedAssets = [];
        for (let i = start; i <= end; i++) {
            state.selectedAssets.push(state.assets[i].id);
        }
        updateSelectionClasses();
        return;
    }

    state.selectedAssets = [asset.id];
    state.lastClickedAsset = assetIdx;
    updateSelectionClasses();
}

function handleAssetDblClick(event, assetIdx) {
    event.preventDefault();
    const asset = state.assets[assetIdx];
    if (!asset) return;
    openInRV(asset.id);
}

/** Launch asset in RV via the rv-push endpoint */
async function openInRV(assetId) {
    try {
        const res = await api('/api/assets/rv-push', {
            method: 'POST',
            body: { ids: [assetId], mode: 'set' }
        });
        if (!res.success) {
            showToast(res.error || 'Failed to open in RV', 'error');
        }
    } catch (e) {
        showToast('Failed to open in RV: ' + e.message, 'error');
    }
}

/** Open built-in player directly, bypassing default_player setting */
function openPlayerBuiltIn(assetIdx) {
    state.playerAssets = state.assets;
    state.playerIndex = assetIdx;
    if (window.openPlayerDirect) {
        window.openPlayerDirect();
    } else {
        openPlayer(assetIdx);
    }
}

export function toggleAssetSelection(assetId) {
    const idx = state.selectedAssets.indexOf(assetId);
    if (idx >= 0) {
        state.selectedAssets.splice(idx, 1);
    } else {
        state.selectedAssets.push(assetId);
    }
}

function selectAllAssets() {
    state.selectedAssets = state.assets.map(a => a.id);
    updateSelectionClasses();
}

function clearAssetSelection() {
    state.selectedAssets = [];
    state.lastClickedAsset = -1;
    updateSelectionClasses();
}

/** Open built-in player with only the selected assets, starting from the first */
function playSelectedAssets() {
    if (state.selectedAssets.length === 0) return;
    const selectedSet = new Set(state.selectedAssets);
    const filtered = state.assets.filter(a => selectedSet.has(a.id));
    if (filtered.length === 0) return;

    state.playerAssets = filtered;
    state.playerIndex = 0;

    if (window.openPlayerDirect) {
        window.openPlayerDirect();
    }
}

function updateSelectionToolbar() {
    const toolbar = document.getElementById('selectionToolbar');
    if (!toolbar) return;
    const count = state.selectedAssets.length;
    toolbar.style.display = count > 0 ? 'flex' : 'none';
    document.getElementById('selectionCount').textContent =
        `${count} selected (${formatSize(state.assets.filter(a => state.selectedAssets.includes(a.id)).reduce((s, a) => s + (a.file_size || 0), 0))})`;
}

// ===========================================
//  STAR TOGGLE
// ===========================================

async function toggleStar(assetId) {
    try {
        await api(`/api/assets/${assetId}/star`, { method: 'POST' });
        if (state.currentProject) {
            loadProjectAssets(state.currentProject.id);
        }
    } catch (err) {
        console.error('Star toggle failed:', err);
    }
}

// ===========================================
//  DRAG & DROP - Assets -> Sequences/Shots
// ===========================================

function onAssetDragStart(event, assetIdx) {
    const asset = state.assets[assetIdx];
    if (!asset) return;

    if (!state.selectedAssets.includes(asset.id)) {
        state.selectedAssets = [asset.id];
        updateSelectionClasses();
    }

    const ids = [...state.selectedAssets];
    event.dataTransfer.setData('application/mediavault-ids', JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = ` ${ids.length} asset${ids.length > 1 ? 's' : ''}`;
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => ghost.remove(), 0);
}

function onSeqDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('drop-hover');
}

function onSeqDragLeave(event) {
    event.currentTarget.classList.remove('drop-hover');
}

async function onShotDrop(event, seqId, shotId) {
    event.preventDefault();
    event.currentTarget.classList.remove('drop-hover');

    const raw = event.dataTransfer.getData('application/mediavault-ids');
    if (!raw) return;

    const ids = JSON.parse(raw);
    if (!ids.length) return;

    try {
        await api('/api/assets/bulk-assign', {
            method: 'POST',
            body: { ids, sequence_id: seqId, shot_id: shotId },
        });

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        await window.loadTree?.();
        const pid = state.currentProject?.id;
        if (pid) {
            const proj = await api(`/api/projects/${pid}`);
            state.currentProject = proj;
            renderProjectDetail(proj);
            loadProjectAssets(pid);
        }
    } catch (err) {
        alert(' Move failed: ' + err.message);
    }
}

async function onSeqDrop(event, seqId, projectId) {
    event.preventDefault();
    event.currentTarget.classList.remove('drop-hover');

    const raw = event.dataTransfer.getData('application/mediavault-ids');
    if (!raw) return;

    const ids = JSON.parse(raw);
    if (!ids.length) return;

    try {
        await api('/api/assets/bulk-assign', {
            method: 'POST',
            body: { ids, sequence_id: seqId },
        });

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        await window.loadTree?.();
        const pid = projectId || state.currentProject?.id;
        if (pid) {
            const proj = await api(`/api/projects/${pid}`);
            state.currentProject = proj;
            renderProjectDetail(proj);
            loadProjectAssets(pid);
        }
    } catch (err) {
        alert(' Move failed: ' + err.message);
    }
}

// ===========================================
//  DRAG & DROP - Files from OS -> Import
// ===========================================

let fileDragCounter = 0;

export function initFileDropZone() {
    const wrap = document.getElementById('assetContainerWrap');
    if (!wrap) return;

    wrap.addEventListener('dragenter', onFileDragEnter);
    wrap.addEventListener('dragover', onFileDragOver);
    wrap.addEventListener('dragleave', onFileDragLeave);
    wrap.addEventListener('drop', onFileDrop);
}

function onFileDragEnter(e) {
    if (e.dataTransfer.types.includes('application/mediavault-ids')) return;
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    fileDragCounter++;
    if (fileDragCounter === 1) showFileDropOverlay();
}

function onFileDragOver(e) {
    if (!e.dataTransfer.types.includes('Files')) return;
    if (e.dataTransfer.types.includes('application/mediavault-ids')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
}

function onFileDragLeave(e) {
    if (!e.dataTransfer.types.includes('Files')) return;
    fileDragCounter--;
    if (fileDragCounter <= 0) {
        fileDragCounter = 0;
        hideFileDropOverlay();
    }
}

async function onFileDrop(e) {
    if (e.dataTransfer.types.includes('application/mediavault-ids')) return;
    if (!e.dataTransfer.types.includes('Files')) return;

    e.preventDefault();
    e.stopPropagation();
    fileDragCounter = 0;
    hideFileDropOverlay();

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const projectId = state.currentProject?.id;
    if (!projectId) {
        alert('Please select a project first.');
        return;
    }

    const formData = new FormData();
    formData.append('project_id', projectId);
    if (state.currentSequence?.id) formData.append('sequence_id', state.currentSequence.id);
    if (state.currentShot?.id) formData.append('shot_id', state.currentShot.id);

    let fileCount = 0;
    for (const file of files) {
        formData.append('files', file);
        fileCount++;
    }

    const container = document.getElementById('assetContainer');
    const prevHTML = container.innerHTML;
    container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
            <div class="empty-icon"></div>
            <p>Importing ${fileCount} file${fileCount > 1 ? 's' : ''}...</p>
        </div>
    `;

    try {
        const res = await fetch('/api/assets/upload', {
            method: 'POST',
            body: formData,
        });
        const result = await res.json();

        if (!res.ok) throw new Error(result.error || 'Upload failed');

        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        renderProjectDetail(proj);
        await loadProjectAssets(projectId);
        await window.loadTree?.();

        showToast(` Imported ${result.imported} file${result.imported !== 1 ? 's' : ''}`);
    } catch (err) {
        console.error('File drop upload failed:', err);
        alert(' Import failed: ' + err.message);
        container.innerHTML = prevHTML;
    }
}

function showFileDropOverlay() {
    const overlay = document.getElementById('fileDropOverlay');
    if (!overlay) return;

    let target = state.currentProject?.name || '';
    if (state.currentSequence) target += ' -> ' + state.currentSequence.name;
    if (state.currentShot) target += ' -> ' + state.currentShot.name;
    document.getElementById('dropTargetLabel').textContent = target;

    overlay.style.display = 'flex';
}

function hideFileDropOverlay() {
    const overlay = document.getElementById('fileDropOverlay');
    if (overlay) overlay.style.display = 'none';
}

// ===========================================
//  AUTO-REFRESH (poll for new assets)
// ===========================================

let _pollTimer = null;
let _lastPollCount = null;
let _lastPollLatest = null;
const POLL_INTERVAL = 5000;

export async function refreshAssets() {
    if (!state.currentProject) return;
    await loadProjectAssets(state.currentProject.id);
    try {
        const info = await api(`/api/assets/poll?project_id=${state.currentProject.id}`);
        _lastPollCount = info.count;
        _lastPollLatest = info.latest;
    } catch {}
    showToast('Assets refreshed', 'success');
}

function startAssetPoll() {
    stopAssetPoll();
    _pollTimer = setInterval(async () => {
        if (document.hidden) return;
        if (!state.currentProject) return;
        if (getActiveCrateId()) return;  // Don't poll while viewing a crate

        try {
            const info = await api(`/api/assets/poll?project_id=${state.currentProject.id}`);
            const changed = (_lastPollCount !== null && info.count !== _lastPollCount)
                         || (_lastPollLatest !== null && info.latest !== _lastPollLatest);
            _lastPollCount = info.count;
            _lastPollLatest = info.latest;

            if (changed) {
                await loadProjectAssets(state.currentProject.id);
                window.loadTree?.();
            }
        } catch {}
    }, POLL_INTERVAL);
}

function stopAssetPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _lastPollCount = null;
    _lastPollLatest = null;
}

// Start polling when a project is opened, stop when leaving
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => startAssetPoll(), 2000);
});

// Stop poll when leaving the browser tab
const _origSwitchTab = window.switchTab;
if (_origSwitchTab) {
    window.switchTab = function(tab) {
        if (tab !== 'browser') stopAssetPoll();
        else startAssetPoll();
        return _origSwitchTab(tab);
    };
}

// --- Filter bar event listeners (JS-based for Safari compatibility) ---
document.getElementById('filterMediaType')?.addEventListener('change', filterAssets);
document.getElementById('filterSequence')?.addEventListener('change', filterAssets);
document.getElementById('searchInput')?.addEventListener('input', filterAssets);

// ===========================================
//  EXPOSE ON WINDOW
// ===========================================

window.openProject = openProject;
window.renderProjectDetail = renderProjectDetail;
window.loadProjectAssets = loadProjectAssets;
window.selectSequence = selectSequence;
window.selectShot = selectShot;
window.filterAssets = filterAssets;
window.setView = setView;
window.handleAssetClick = handleAssetClick;
window.handleAssetDblClick = handleAssetDblClick;
window.openInRV = openInRV;
window.openPlayerBuiltIn = openPlayerBuiltIn;
window.selectAllAssets = selectAllAssets;
window.clearAssetSelection = clearAssetSelection;
window.playSelectedAssets = playSelectedAssets;
window.toggleStar = toggleStar;
window.toggleAssetSelection = toggleAssetSelection;
window.updateSelectionClasses = updateSelectionClasses;
window.onAssetDragStart = onAssetDragStart;
window.onSeqDragOver = onSeqDragOver;
window.onSeqDragLeave = onSeqDragLeave;
window.onShotDrop = onShotDrop;
window.onSeqDrop = onSeqDrop;
window.refreshAssets = refreshAssets;

// ===========================================
//  VIDEO SCRUBBING
// ===========================================

let scrubTimeout = null;

export function handleVideoHover(el, id) {
    if (el.querySelector('video')) return;
    
    scrubTimeout = setTimeout(() => {
        const img = el.querySelector('img');
        
        const video = document.createElement('video');
        
        // Check if codec is natively playable by browser
        const browserCodecs = new Set(['h264', 'h265', 'hevc', 'vp8', 'vp9', 'av1', 'avc', 'avc1']);
        const codec = el.dataset.codec || '';
        const needsTranscode = codec && !browserCodecs.has(codec.toLowerCase());
        
        video.src = needsTranscode ? `/api/assets/${id}/stream` : `/api/assets/${id}/file`;
        video.dataset.needsTranscode = needsTranscode ? 'true' : 'false';
        
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.className = 'scrub-video';
        
        const scrubBar = document.createElement('div');
        scrubBar.className = 'scrub-bar';
        scrubBar.style.width = '0%';
        
        // Use database duration if available, fallback to video metadata
        const dbDuration = parseFloat(el.dataset.duration);
        if (dbDuration && dbDuration > 0) {
            video.dataset.duration = dbDuration;
        } else {
            video.onloadedmetadata = () => {
                if (isFinite(video.duration)) {
                    video.dataset.duration = video.duration;
                }
            };
        }
        
        video.onloadeddata = () => {
            if (img) img.style.opacity = '0';
            video.play().catch(e => console.log('Autoplay prevented', e));
        };
        
        el.appendChild(video);
        el.appendChild(scrubBar);
    }, 300); // 300ms delay before loading video to prevent spam
}

export function handleVideoMove(e, el) {
    const video = el.querySelector('video');
    const scrubBar = el.querySelector('.scrub-bar');
    if (!video || !video.dataset.duration) return;
    
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percent = x / rect.width;
    
    if (scrubBar) {
        scrubBar.style.width = `${percent * 100}%`;
    }
    
    // Only scrub if it's a native file. Transcoded streams can't seek.
    if (video.dataset.needsTranscode === 'true') return;
    
    const targetTime = percent * parseFloat(video.dataset.duration);
    if (isFinite(targetTime) && video.readyState >= 1) {
        try {
            video.currentTime = targetTime;
        } catch (err) {}
    }
}

export function handleVideoLeave(el) {
    clearTimeout(scrubTimeout);
    const video = el.querySelector('video');
    if (video) video.remove();
    const scrubBar = el.querySelector('.scrub-bar');
    if (scrubBar) scrubBar.remove();
    
    const img = el.querySelector('img');
    if (img) img.style.opacity = '1';
}

window.handleVideoHover = handleVideoHover;
window.handleVideoMove = handleVideoMove;
window.handleVideoLeave = handleVideoLeave;

// Expose tree expand helper for openProject
window._treeExpandNode = null; // Set by browser.js orchestrator after treeNav loads


