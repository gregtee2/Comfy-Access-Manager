/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV - Export Module
 * Video transcoding/export via FFmpeg backend.
 * Supports single & batch export, resolution presets, codec selection,
 * templated output naming, and folder browsing.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, showToast, closeModal } from './utils.js';

// Cache presets after first load
let presetCache = null;

async function getPresets() {
    if (presetCache) return presetCache;
    presetCache = await api('/api/export/presets');
    return presetCache;
}

// ===========================================
//  EXPORT MODAL
// ===========================================

/**
 * Show the export modal for selected assets or a specific asset id.
 * @param {number|null} singleId - If provided, export just this one asset
 */
export async function showExportModal(singleId = null) {
    const ids = singleId ? [singleId] : [...state.selectedAssets];
    if (ids.length === 0) {
        showToast('Select at least one video asset to export', 4000);
        return;
    }

    // Probe the first asset to get source info + suggest defaults
    let probeInfo = null;
    try {
        probeInfo = await api(`/api/export/probe/${ids[0]}`);
    } catch (err) {
        showToast('Cannot export: ' + err.message, 4000);
        return;
    }

    const presets = await getPresets();

    const sourceRes = `${probeInfo.width}x${probeInfo.height}`;
    const sourceFps = probeInfo.fps ? `${Math.round(probeInfo.fps * 100) / 100} fps` : '';
    const sourceDur = probeInfo.duration ? formatDuration(probeInfo.duration) : '';
    const sourceSize = probeInfo.file_size ? formatFileSize(probeInfo.file_size) : '';

    // Build resolution options
    const resOptions = Object.entries(presets.resolutions).map(([key, p]) => {
        const selected = key === '720p' ? 'selected' : '';
        return `<option value="${key}" ${selected}>${p.label}</option>`;
    }).join('');

    // Build codec options - put the suggested one first as selected
    const codecOptions = [
        `<option value="match_source"> Match Source (${esc(probeInfo.codec)})</option>`,
        ...Object.entries(presets.codecs).map(([key, c]) => {
            return `<option value="${key}">${esc(c.label)}</option>`;
        }),
    ].join('');

    // Build filename template
    const baseName = probeInfo.vault_name.replace(/\.[^.]+$/, '');
    const defaultTemplate = `${baseName}_{resolution}`;

    const modalContent = document.getElementById('modalContent');
    modalContent.innerHTML = `
        <h3> Export Video${ids.length > 1 ? 's' : ''}</h3>

        <div class="export-source-info">
            <div class="export-source-row">
                <span class="export-source-label">Source:</span>
                <span>${esc(probeInfo.vault_name)}</span>
            </div>
            <div class="export-source-row">
                <span class="export-source-label">Resolution:</span>
                <span>${sourceRes} ${sourceFps}</span>
            </div>
            <div class="export-source-row">
                <span class="export-source-label">Codec:</span>
                <span>${esc(probeInfo.codec_long || probeInfo.codec)}</span>
            </div>
            ${sourceDur ? `<div class="export-source-row">
                <span class="export-source-label">Duration:</span>
                <span>${sourceDur}</span>
            </div>` : ''}
            ${sourceSize ? `<div class="export-source-row">
                <span class="export-source-label">Size:</span>
                <span>${sourceSize}</span>
            </div>` : ''}
            ${ids.length > 1 ? `<div class="export-source-row">
                <span class="export-source-label">Batch:</span>
                <span>${ids.length} video(s) selected</span>
            </div>` : ''}
            ${probeInfo.hierarchy ? `<div class="export-source-row">
                <span class="export-source-label">Path:</span>
                <span class="export-hierarchy-path">${buildHierarchyDisplay(probeInfo.hierarchy)}</span>
            </div>` : ''}
        </div>

        <div class="export-settings">
            <label>Resolution</label>
            <select id="exportResolution" onchange="updateExportPreview()">
                ${resOptions}
            </select>

            <label>Codec</label>
            <select id="exportCodec" onchange="updateExportPreview()">
                ${codecOptions}
            </select>

            <label>Output Name</label>
            <div class="export-name-row">
                <input type="text" id="exportName" value="${esc(defaultTemplate)}" 
                    placeholder="filename_{resolution}_{codec}" oninput="updateExportPreview()">
            </div>
            <div class="export-tokens">
                Tokens: 
                <code onclick="insertExportToken('{original}')">{original}</code>
                <code onclick="insertExportToken('{resolution}')">{resolution}</code>
                <code onclick="insertExportToken('{codec}')">{codec}</code>
                <code onclick="insertExportToken('{role}')">{role}</code>
                <code onclick="insertExportToken('{date}')">{date}</code>
            </div>
            <div class="export-preview" id="exportPreview"></div>
            <div class="export-folder-preview" id="exportFolderPreview"></div>

            <label>Destination</label>
            <div class="export-dest-row">
                <input type="text" id="exportDest" placeholder="Leave empty -> vault/exports/ folder" value="">
                <button class="btn-browse" onclick="browseExportDest()" title="Browse..."></button>
            </div>
        </div>

        <div class="form-actions" style="margin-top:20px">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" id="exportStartBtn" onclick="executeExport()">
                 Export${ids.length > 1 ? ` (${ids.length})` : ''}
            </button>
        </div>
    `;

    // Stash ids and hierarchy on the button for later retrieval
    document.getElementById('exportStartBtn').dataset.assetIds = JSON.stringify(ids);
    document.getElementById('exportStartBtn').dataset.hierarchy = JSON.stringify(probeInfo.hierarchy || {});

    document.getElementById('modal').style.display = 'flex';
    updateExportPreview();
}

// ===========================================
//  NAME PREVIEW & TOKEN INSERTION
// ===========================================

function updateExportPreview() {
    const nameInput = document.getElementById('exportName');
    const resolution = document.getElementById('exportResolution')?.value || 'original';
    const codec = document.getElementById('exportCodec')?.value || 'h264_nvenc';
    if (!nameInput) return;

    // Get hierarchy from stashed data
    const btn = document.getElementById('exportStartBtn');
    const hierarchy = btn ? JSON.parse(btn.dataset.hierarchy || '{}') : {};
    const roleCode = hierarchy.role_code || '';

    let preview = nameInput.value
        .replace(/{original}/g, '<<original>>')
        .replace(/{resolution}/g, resolution)
        .replace(/{codec}/g, codec)
        .replace(/{role}/g, roleCode)
        .replace(/{date}/g, new Date().toISOString().slice(0, 10));

    // Add extension hint
    const codecPreset = presetCache?.codecs?.[codec];
    const ext = codecPreset?.ext || '.mp4';
    if (!preview.includes('.')) preview += ext;

    const el = document.getElementById('exportPreview');
    if (el) el.textContent = `File: ${preview}`;

    // Show folder structure preview
    const folderEl = document.getElementById('exportFolderPreview');
    if (folderEl) {
        const parts = ['exports'];
        if (hierarchy.project_code)  parts.push(hierarchy.project_code);
        if (hierarchy.sequence_name) parts.push(hierarchy.sequence_name);
        if (hierarchy.shot_name)     parts.push(hierarchy.shot_name);
        if (hierarchy.role_code)     parts.push(hierarchy.role_code);
        parts.push(preview);
        folderEl.textContent = ` ${parts.join(' / ')}`;
    }
}

function insertExportToken(token) {
    const input = document.getElementById('exportName');
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const val = input.value;
    input.value = val.substring(0, start) + token + val.substring(end);
    input.focus();
    input.setSelectionRange(start + token.length, start + token.length);
    updateExportPreview();
}

function browseExportDest() {
    // Reuse the folder picker if available (from settings module)
    if (window.openFolderPicker) {
        window.openFolderPicker('exportDest');
    } else {
        showToast('Folder picker not available - type a path manually', 4000);
    }
}

// ===========================================
//  EXECUTE EXPORT
// ===========================================

async function executeExport() {
    const btn = document.getElementById('exportStartBtn');
    const ids = JSON.parse(btn.dataset.assetIds || '[]');
    const resolution = document.getElementById('exportResolution').value;
    const codec = document.getElementById('exportCodec').value;
    const outputName = document.getElementById('exportName').value.trim();
    const destination = document.getElementById('exportDest').value.trim() || undefined;

    if (ids.length === 0) return;

    // Disable button during export
    btn.disabled = true;
    btn.textContent = 'Wait: Starting...';

    try {
        const result = await api('/api/export/start', {
            method: 'POST',
            body: { assetIds: ids, resolution, codec, outputName, destination },
        });

        closeModal();
        showToast(` Export started: ${result.total} file(s)`, 3000);

        // Start polling for progress
        pollExportJob(result.jobId);

    } catch (err) {
        btn.disabled = false;
        btn.textContent = ` Export${ids.length > 1 ? ` (${ids.length})` : ''}`;
        showToast('Error: Export failed: ' + err.message, 5000);
    }
}

// ===========================================
//  PROGRESS POLLING & TOAST
// ===========================================

function pollExportJob(jobId) {
    // Show a persistent progress toast
    let toastEl = document.createElement('div');
    toastEl.className = 'export-progress-toast';
    toastEl.id = `export-toast-${jobId}`;
    toastEl.innerHTML = `
        <div class="export-progress-header"> Exporting...</div>
        <div class="export-progress-bar-wrap">
            <div class="export-progress-bar" style="width:0%"></div>
        </div>
        <div class="export-progress-text">Starting...</div>
    `;
    document.body.appendChild(toastEl);

    // Slide in
    requestAnimationFrame(() => toastEl.classList.add('visible'));

    const interval = setInterval(async () => {
        try {
            const job = await api(`/api/export/status/${jobId}`);
            const pct = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;

            const bar = toastEl.querySelector('.export-progress-bar');
            const text = toastEl.querySelector('.export-progress-text');
            if (bar) bar.style.width = `${pct}%`;

            if (job.status === 'running') {
                text.textContent = `${job.completed}/${job.total} - ${job.current || '...'}`;
            } else {
                // Done
                clearInterval(interval);

                if (job.failed > 0) {
                    text.textContent = `Success: ${job.completed - job.failed} exported, Error: ${job.failed} failed`;
                    if (bar) bar.style.background = '#ff9800';
                } else {
                    text.textContent = `Success: ${job.completed} file(s) exported successfully`;
                    if (bar) bar.style.background = '#4caf50';
                }

                // Auto-dismiss after 5 seconds
                setTimeout(() => {
                    toastEl.classList.remove('visible');
                    setTimeout(() => toastEl.remove(), 400);
                }, 5000);
            }
        } catch {
            clearInterval(interval);
            toastEl.remove();
        }
    }, 1000);
}

// ===========================================
//  HELPERS
// ===========================================

function buildHierarchyDisplay(h) {
    if (!h) return '';
    const parts = [];
    if (h.project_code)   parts.push(h.project_code);
    if (h.sequence_name)  parts.push(h.sequence_name);
    if (h.shot_name)      parts.push(h.shot_name);
    if (h.role_code)      parts.push(`<span class="export-role-badge" style="color:var(--accent)">${h.role_code}</span>`);
    return parts.join(' / ') || '<em>not assigned</em>';
}

function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatFileSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
    return bytes + ' B';
}

// ===========================================
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ===========================================

window.showExportModal = showExportModal;
window.executeExport = executeExport;
window.updateExportPreview = updateExportPreview;
window.insertExportToken = insertExportToken;
window.browseExportDest = browseExportDest;

