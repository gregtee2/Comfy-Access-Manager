/**
 * DMV — Player Module
 * Built-in media player, external player launch (mrViewer2), compare view.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, formatSize, formatDuration, showToast } from './utils.js';

// ═══════════════════════════════════════════
//  COMPARE STATE
// ═══════════════════════════════════════════
let compareMode = null;       // null | 'side-by-side' | 'toggle'
let compareRoles = [];        // Array of { role, assets } for comparison
let compareActiveIdx = 0;     // Index into compareRoles for toggle mode

// ═══════════════════════════════════════════
//  MEDIA PLAYER
// ═══════════════════════════════════════════

export function openPlayer(index) {
    state.playerAssets = state.assets;
    state.playerIndex = index;

    // If external player is the default, launch it instead of modal
    const defPlayer = state.settings?.default_player || 'browser';
    if (defPlayer !== 'browser') {
        const asset = state.playerAssets[index];
        if (asset) {
            openInExternalPlayer(asset.id);
            return;
        }
    }

    renderPlayer();
    document.getElementById('playerModal').style.display = 'flex';

    // Keyboard navigation
    document.addEventListener('keydown', playerKeyHandler);
}

function closePlayer() {
    document.getElementById('playerModal').style.display = 'none';
    document.removeEventListener('keydown', playerKeyHandler);

    // Stop video if playing
    const video = document.querySelector('#playerContent video');
    if (video) video.pause();
}

function playerKeyHandler(e) {
    // Compare mode key handling
    if (compareMode) {
        if (e.key === 'Escape') { exitCompareMode(); return; }
        if (compareMode === 'toggle') {
            if (e.key === 'ArrowRight') {
                compareActiveIdx = (compareActiveIdx + 1) % compareRoles.length;
                renderRoleCompare();
                return;
            }
            if (e.key === 'ArrowLeft') {
                compareActiveIdx = (compareActiveIdx - 1 + compareRoles.length) % compareRoles.length;
                renderRoleCompare();
                return;
            }
        }
        return;
    }

    // Normal player key handling
    if (e.key === 'Escape') closePlayer();
    if (e.key === 'ArrowRight') playerNext();
    if (e.key === 'ArrowLeft') playerPrev();
    if (e.key === ' ') {
        e.preventDefault();
        const video = document.querySelector('#playerContent video');
        if (video) video.paused ? video.play() : video.pause();
    }
}

function playerNext() {
    if (state.playerIndex < state.playerAssets.length - 1) {
        state.playerIndex++;
        renderPlayer();
    }
}

function playerPrev() {
    if (state.playerIndex > 0) {
        state.playerIndex--;
        renderPlayer();
    }
}

function renderPlayer() {
    const asset = state.playerAssets[state.playerIndex];
    if (!asset) return;

    document.getElementById('playerTitle').textContent = asset.vault_name;
    document.getElementById('playerIndex').textContent = `${state.playerIndex + 1} / ${state.playerAssets.length}`;

    const content = document.getElementById('playerContent');
    const fileUrl = `/api/assets/${asset.id}/file`;

    // Codecs browsers can play natively
    const browserCodecs = new Set(['h264', 'h265', 'hevc', 'vp8', 'vp9', 'av1', 'avc', 'avc1']);
    const needsTranscode = asset.media_type === 'video' && asset.codec && !browserCodecs.has(asset.codec.toLowerCase());

    if (asset.media_type === 'video') {
        const videoUrl = needsTranscode ? `/api/assets/${asset.id}/stream` : fileUrl;
        content.innerHTML = `
            ${needsTranscode ? '<div style="text-align:center;color:var(--accent);font-size:0.75rem;margin-bottom:6px;">⚡ Transcoding from ' + esc(asset.codec) + ' — may take a moment to start</div>' : ''}
            <video controls autoplay loop src="${videoUrl}" style="max-width:100%;max-height:70vh;"></video>
        `;
    } else if (asset.media_type === 'image' || asset.media_type === 'exr') {
        content.innerHTML = `<img src="${fileUrl}" alt="${esc(asset.vault_name)}">`;
    } else if (asset.media_type === 'audio') {
        content.innerHTML = `
            <div style="text-align:center;padding:40px;">
                <div style="font-size:4rem;margin-bottom:20px;">🔊</div>
                <audio controls autoplay src="${fileUrl}" style="width:400px;"></audio>
            </div>
        `;
    } else {
        content.innerHTML = `
            <div style="text-align:center;padding:40px;color:var(--text-dim);">
                <div style="font-size:4rem;margin-bottom:12px;">📎</div>
                <p>Preview not available for this file type.</p>
                <a href="${fileUrl}" download style="color:var(--accent-light);">Download File</a>
            </div>
        `;
    }

    // Meta info
    const meta = document.getElementById('playerMeta');
    const parts = [];
    if (asset.width && asset.height) parts.push(`<span>📐 ${asset.width}×${asset.height}</span>`);
    if (asset.duration) parts.push(`<span>⏱️ ${formatDuration(asset.duration)}</span>`);
    if (asset.fps) parts.push(`<span>🎞️ ${asset.fps} fps</span>`);
    if (asset.codec) parts.push(`<span>🔧 ${asset.codec}</span>`);
    parts.push(`<span>📦 ${formatSize(asset.file_size)}</span>`);
    if (asset.original_name !== asset.vault_name) {
        parts.push(`<span>📄 Originally: ${esc(asset.original_name)}</span>`);
    }
    parts.push(`<button class="player-mrv2-btn" onclick="openInMrViewer2(${asset.id})" title="Open in mrViewer2">🎬 mrViewer2</button>`);
    parts.push(`<button class="player-mrv2-btn" onclick="openInRV(${asset.id})" title="Open in RV (ShotGrid)">🎬 RV</button>`);
    meta.innerHTML = parts.join('');
}

// ═══════════════════════════════════════════
//  EXTERNAL PLAYER LAUNCH
// ═══════════════════════════════════════════

async function openInExternalPlayer(assetId) {
    try {
        const player = state.settings?.default_player || 'mrviewer2';
        const customPath = state.settings?.custom_player_path || '';
        await api(`/api/assets/${assetId}/open-external`, {
            method: 'POST',
            body: { player, customPath }
        });
        showToast('Launched in external player');
        window.blur();
    } catch (err) {
        showToast('Failed to launch player: ' + err.message, 5000);
    }
}

async function openInMrViewer2(assetId) {
    try {
        await api(`/api/assets/${assetId}/open-external`, { method: 'POST', body: { player: 'mrviewer2' } });
        showToast('Launched in mrViewer2');
        window.blur();
    } catch (err) {
        showToast('Failed to launch mrViewer2: ' + err.message, 5000);
    }
}

async function openCompareInMrViewer2() {
    if (state.selectedAssets.length < 2) {
        showToast('Select at least 2 clips to compare (Ctrl-click or Shift-click)', 4000);
        return;
    }
    try {
        const res = await api('/api/assets/open-compare', {
            method: 'POST',
            body: { ids: state.selectedAssets, viewer: 'mrviewer2' }
        });
        showToast(`Loaded ${res.count} clips in mrViewer2 — use Panel → Compare → Wipe`);
        window.blur();
    } catch (err) {
        showToast('Failed to launch compare: ' + err.message, 5000);
    }
}

async function openInRV(assetId) {
    try {
        await api(`/api/assets/${assetId}/open-external`, { method: 'POST', body: { player: 'rv' } });
        showToast('Launched in RV');
        window.blur();
    } catch (err) {
        showToast('Failed to launch RV: ' + err.message, 5000);
    }
}

async function openCompareInRV() {
    if (state.selectedAssets.length < 2) {
        showToast('Select at least 2 clips to compare (Ctrl-click or Shift-click)', 4000);
        return;
    }
    try {
        const res = await api('/api/assets/open-compare', {
            method: 'POST',
            body: { ids: state.selectedAssets, viewer: 'rv' }
        });
        showToast(`Loaded ${res.count} clips in RV — wipe mode`);
        window.blur();
    } catch (err) {
        showToast('Failed to launch RV compare: ' + err.message, 5000);
    }
}

// ═══════════════════════════════════════════
//  ROLE COMPARISON MODE
// ═══════════════════════════════════════════

async function openRoleCompare(shotId) {
    if (!shotId && !state.currentShot?.id) {
        showToast('Select a shot first to compare roles', 4000);
        return;
    }
    const targetShot = shotId || state.currentShot.id;
    const projectId = state.currentProject?.id;
    if (!projectId) return;

    try {
        // Get all assets in this shot, grouped by role
        const result = await api(`/api/assets?project_id=${projectId}&shot_id=${targetShot}`);
        const assets = result.assets || [];

        // Group by role
        const grouped = {};
        for (const a of assets) {
            const key = a.role_id || 0;
            if (!grouped[key]) {
                grouped[key] = {
                    role: a.role_id ? { id: a.role_id, name: a.role_name, code: a.role_code, color: a.role_color, icon: a.role_icon } : { id: 0, name: 'Unassigned', code: 'NONE', color: '#888', icon: '📎' },
                    assets: [],
                };
            }
            grouped[key].assets.push(a);
        }

        compareRoles = Object.values(grouped).filter(g => g.assets.length > 0);
        if (compareRoles.length < 2) {
            showToast('Need assets in at least 2 roles to compare', 4000);
            return;
        }

        compareActiveIdx = 0;
        compareMode = 'side-by-side';
        renderRoleCompare();

        document.getElementById('playerModal').style.display = 'flex';
        document.addEventListener('keydown', playerKeyHandler);
    } catch (err) {
        showToast('Failed to load role comparison: ' + err.message, 4000);
    }
}

function renderRoleCompare() {
    const content = document.getElementById('playerContent');
    const compare = document.getElementById('playerCompare');
    const roleBar = document.getElementById('playerRoleBar');

    if (!compareMode || compareRoles.length < 2) {
        compare.style.display = 'none';
        roleBar.style.display = 'none';
        return;
    }

    content.style.display = 'none';
    compare.style.display = 'flex';
    roleBar.style.display = 'flex';

    // Title
    document.getElementById('playerTitle').textContent = 'Role Comparison';
    document.getElementById('playerIndex').textContent = `${compareRoles.length} roles`;

    // Mode toggle bar
    roleBar.innerHTML = `
        <div class="compare-mode-toggle">
            <button class="${compareMode === 'side-by-side' ? 'active' : ''}" onclick="setCompareMode('side-by-side')">⬛⬜ Side by Side</button>
            <button class="${compareMode === 'toggle' ? 'active' : ''}" onclick="setCompareMode('toggle')">🔄 Toggle</button>
            <button onclick="exitCompareMode()">✕ Exit Compare</button>
        </div>
        <div class="compare-role-pills">
            ${compareRoles.map((g, i) => `
                <span class="compare-pill ${compareMode === 'toggle' && compareActiveIdx === i ? 'active' : ''}" 
                    style="border-color:${g.role.color};${compareMode === 'toggle' && compareActiveIdx === i ? `background:${g.role.color}30` : ''}"
                    onclick="setCompareActive(${i})">
                    ${g.role.icon} ${esc(g.role.name)} <span class="pill-count">${g.assets.length}</span>
                </span>
            `).join('')}
        </div>
    `;

    if (compareMode === 'side-by-side') {
        renderSideBySide();
    } else {
        renderToggleView();
    }
}

function renderSideBySide() {
    const compare = document.getElementById('playerCompare');
    compare.className = 'player-compare side-by-side';

    compare.innerHTML = compareRoles.map(g => {
        const a = g.assets[0]; // Show first asset per role
        if (!a) return '';
        const fileUrl = `/api/assets/${a.id}/file`;
        const isVideo = a.media_type === 'video';
        return `
            <div class="compare-panel">
                <div class="compare-panel-header" style="border-bottom-color:${g.role.color}">
                    ${g.role.icon} <strong style="color:${g.role.color}">${esc(g.role.name)}</strong>
                    <span style="opacity:.6;font-size:.8em;margin-left:8px;">${esc(a.vault_name)}</span>
                </div>
                <div class="compare-panel-media">
                    ${isVideo 
                        ? `<video controls loop src="${fileUrl}" style="max-width:100%;max-height:60vh;"></video>`
                        : `<img src="${fileUrl}" alt="${esc(a.vault_name)}" style="max-width:100%;max-height:60vh;object-fit:contain;">`
                    }
                </div>
                ${g.assets.length > 1 ? `<div class="compare-panel-nav">
                    ${g.assets.map((aa, j) => `<span class="compare-thumb-pill${j === 0 ? ' active' : ''}" onclick="swapCompareAsset(${compareRoles.indexOf(g)}, ${j})">${j + 1}</span>`).join('')}
                </div>` : ''}
            </div>
        `;
    }).join('');
}

function renderToggleView() {
    const compare = document.getElementById('playerCompare');
    compare.className = 'player-compare toggle-view';

    const g = compareRoles[compareActiveIdx];
    if (!g) return;
    const a = g.assets[0];
    if (!a) return;
    const fileUrl = `/api/assets/${a.id}/file`;
    const isVideo = a.media_type === 'video';

    compare.innerHTML = `
        <div class="compare-panel full">
            <div class="compare-panel-header" style="border-bottom-color:${g.role.color}">
                ${g.role.icon} <strong style="color:${g.role.color}">${esc(g.role.name)}</strong>
                <span style="opacity:.6;font-size:.8em;margin-left:8px;">${esc(a.vault_name)}</span>
                <span style="margin-left:auto;font-size:.8em;color:var(--text-dim);">← → to switch roles</span>
            </div>
            <div class="compare-panel-media">
                ${isVideo 
                    ? `<video controls loop src="${fileUrl}" style="max-width:100%;max-height:65vh;"></video>`
                    : `<img src="${fileUrl}" alt="${esc(a.vault_name)}" style="max-width:100%;max-height:65vh;object-fit:contain;">`
                }
            </div>
        </div>
    `;
}

function setCompareMode(mode) {
    compareMode = mode;
    renderRoleCompare();
}

function setCompareActive(idx) {
    compareActiveIdx = idx;
    renderRoleCompare();
}

function swapCompareAsset(roleIdx, assetIdx) {
    const g = compareRoles[roleIdx];
    if (!g || !g.assets[assetIdx]) return;
    // Move the selected asset to front
    const selected = g.assets.splice(assetIdx, 1)[0];
    g.assets.unshift(selected);
    renderRoleCompare();
}

function exitCompareMode() {
    compareMode = null;
    compareRoles = [];
    const content = document.getElementById('playerContent');
    const compare = document.getElementById('playerCompare');
    const roleBar = document.getElementById('playerRoleBar');
    content.style.display = '';
    compare.style.display = 'none';
    roleBar.style.display = 'none';
    closePlayer();
}

// ═══════════════════════════════════════════
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ═══════════════════════════════════════════

window.openPlayer = openPlayer;
window.closePlayer = closePlayer;
window.playerPrev = playerPrev;
window.playerNext = playerNext;
window.openInExternalPlayer = openInExternalPlayer;
window.openInMrViewer2 = openInMrViewer2;
window.openCompareInMrViewer2 = openCompareInMrViewer2;
window.openInRV = openInRV;
window.openCompareInRV = openCompareInRV;
window.openRoleCompare = openRoleCompare;
window.setCompareMode = setCompareMode;
window.setCompareActive = setCompareActive;
window.swapCompareAsset = swapCompareAsset;
window.exitCompareMode = exitCompareMode;

// Open player by asset ID (for format variant sub-menu)
function openPlayerById(assetId) {
    // Find index in current state.assets
    const idx = state.assets.findIndex(a => a.id === assetId);
    if (idx >= 0) {
        openPlayer(idx);
    } else {
        // Asset not in current view — fetch it and play directly
        fetch(`/api/assets/${assetId}`)
            .then(r => r.json())
            .then(asset => {
                if (asset && asset.id) {
                    state.playerAssets = [asset];
                    state.playerIndex = 0;
                    const defPlayer = state.settings?.default_player || 'browser';
                    if (defPlayer !== 'browser') {
                        openInExternalPlayer(asset.id);
                    } else {
                        renderPlayer();
                        document.getElementById('playerModal').style.display = 'flex';
                        document.addEventListener('keydown', playerKeyHandler);
                    }
                }
            })
            .catch(() => showToast('Failed to load asset', 3000));
    }
}
window.openPlayerById = openPlayerById;
