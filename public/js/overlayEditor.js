/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM -- Overlay Editor Module
 * Visual canvas-based overlay burn-in editor with preset management.
 * Opens as a full-screen modal with a live preview and element controls.
 */

import { api } from './api.js';
import { esc, showToast, closeModal } from './utils.js';

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════

let editorModal = null;
let canvas = null;
let ctx = null;
let sampleImage = null;
let hierarchy = {};
let currentPresetId = null;
let currentPresetName = '';
let elements = [];
let presetsCache = [];
let onCloseCallback = null;
let currentAssetId = null;
let imageAspect = 16 / 9;

const ELEMENT_TYPES = {
    shot_name:      { label: 'Shot Name',       preview: h => h.shot_name || 'SH010' },
    sequence_name:  { label: 'Sequence',         preview: h => h.sequence_name || 'SEQ010' },
    project_name:   { label: 'Project',          preview: h => h.project_code || 'PROJECT' },
    role:           { label: 'Role',             preview: h => h.role_code || 'COMP' },
    frame_number:   { label: 'Frame Number',     preview: () => '0042' },
    timecode:       { label: 'Timecode',         preview: () => '00:00:01:18' },
    date:           { label: 'Date',             preview: () => new Date().toISOString().slice(0, 10) },
    filename:       { label: 'Filename',         preview: h => (h.vault_name || 'filename_v001').replace(/\.[^.]+$/, '') },
    custom:         { label: 'Custom Text',      preview: (h, el) => el.text || 'Custom Text' },
    shot_and_frame: { label: 'Shot + Frame',     preview: h => (h.shot_name || 'SH010') + '  0042' },
};

const ANCHOR_OPTIONS = [
    { value: 'top-left',      label: 'Top Left' },
    { value: 'top-center',    label: 'Top Center' },
    { value: 'top-right',     label: 'Top Right' },
    { value: 'bottom-left',   label: 'Bottom Left' },
    { value: 'bottom-center', label: 'Bottom Center' },
    { value: 'bottom-right',  label: 'Bottom Right' },
    { value: 'center',        label: 'Center' },
];

const DEFAULT_ELEMENT = {
    enabled: true,
    type: 'shot_name',
    text: '',
    anchor: 'bottom-left',
    offsetX: 20,
    offsetY: 20,
    fontSize: 24,
    fontColor: '#ffffff',
    fontOpacity: 1.0,
    fontFamily: 'monospace',
    bgEnabled: true,
    bgColor: '#000000',
    bgOpacity: 0.5,
    bgPadding: 8,
};

// ═══════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════

/**
 * Open the overlay editor for a given asset or project.
 * @param {number|null} assetId - Asset to preview (null if opening from project)
 * @param {number|null} presetId - Load this preset (null = blank)
 * @param {function|null} callback - Called on close with (presetId|null)
 * @param {object} [opts] - Additional options
 * @param {number} [opts.projectId] - Project ID (for fetching a sample asset when assetId is null)
 * @param {object} [opts.projectInfo] - Project hierarchy fallback { project_code, project_name }
 */
export async function showOverlayEditor(assetId, presetId = null, callback = null, opts = {}) {
    currentAssetId = assetId;
    onCloseCallback = callback;
    currentPresetId = presetId;
    currentPresetName = '';
    elements = [];

    // If no assetId but we have a projectId, try to find a sample asset from the project
    if (!assetId && opts.projectId) {
        try {
            const assets = await api(`/api/assets?project_id=${opts.projectId}&limit=1`);
            if (assets?.data?.length > 0) {
                currentAssetId = assets.data[0].id;
                assetId = currentAssetId;
            }
        } catch (_) { /* no assets — will use placeholder */ }
    }

    // Fetch hierarchy info + presets in parallel
    let info = {};
    if (assetId) {
        const [assetInfo, presets] = await Promise.all([
            api(`/api/overlay/asset-info/${assetId}`),
            api('/api/overlay/presets'),
        ]);
        info = assetInfo || {};
        presetsCache = presets || [];
    } else {
        // No asset available — use project-level fallback info
        presetsCache = await api('/api/overlay/presets') || [];
        if (opts.projectInfo) {
            info = {
                project_code: opts.projectInfo.code || opts.projectInfo.project_code || '',
                project_name: opts.projectInfo.name || opts.projectInfo.project_name || '',
                shot_name: 'SH010',
                sequence_name: 'SEQ010',
                role_code: 'comp',
                vault_name: 'example_v001.exr',
            };
        }
    }
    hierarchy = info;

    // Load preset if given
    if (presetId) {
        const preset = presetsCache.find(p => p.id === presetId);
        if (preset) {
            currentPresetName = preset.name;
            elements = JSON.parse(JSON.stringify(preset.config.elements || []));
        }
    }

    // If no elements, start with one default
    if (elements.length === 0) {
        elements.push(makeElement('shot_and_frame', 'bottom-left'));
    }

    buildModal();
    loadSampleFrame(assetId);
}

/**
 * Get the currently selected preset ID (for use in export).
 */
export function getSelectedOverlayPreset() {
    return currentPresetId;
}

// ═══════════════════════════════════════════
//  MODAL BUILD
// ═══════════════════════════════════════════

function buildModal() {
    // Remove any existing editor
    if (editorModal) editorModal.remove();

    editorModal = document.createElement('div');
    editorModal.className = 'overlay-editor-backdrop';
    editorModal.onclick = (e) => { if (e.target === editorModal) closeEditor(); };

    editorModal.innerHTML = `
        <div class="overlay-editor-modal">
            <div class="overlay-editor-header">
                <h3>Overlay Editor</h3>
                <button class="overlay-editor-close" onclick="window._overlayEditorClose()">&times;</button>
            </div>
            <div class="overlay-editor-body">
                <div class="overlay-editor-preview">
                    <div class="overlay-canvas-wrap" id="overlayCanvasWrap">
                        <canvas id="overlayCanvas" width="960" height="540"></canvas>
                        <div class="overlay-canvas-res" id="overlayResLabel"></div>
                    </div>
                </div>
                <div class="overlay-editor-controls">
                    <div class="overlay-preset-bar">
                        <label>Preset</label>
                        <select id="overlayPresetSelect" onchange="window._overlayLoadPreset(this.value)">
                            <option value="">(unsaved)</option>
                            ${presetsCache.map(p => `<option value="${p.id}" ${p.id === currentPresetId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
                        </select>
                        <button class="overlay-btn-sm" onclick="window._overlaySavePreset()" title="Save preset">Save</button>
                        <button class="overlay-btn-sm" onclick="window._overlaySaveAsPreset()" title="Save as new">Save As</button>
                        <button class="overlay-btn-sm overlay-btn-danger" onclick="window._overlayDeletePreset()" title="Delete preset">Del</button>
                    </div>

                    <div class="overlay-elements-header">
                        <span>Elements</span>
                        <button class="overlay-btn-sm overlay-btn-add" onclick="window._overlayAddElement()">+ Add</button>
                    </div>
                    <div class="overlay-elements-list" id="overlayElementsList">
                        <!-- Populated by renderElementControls() -->
                    </div>
                </div>
            </div>
            <div class="overlay-editor-footer">
                <button class="btn-cancel" onclick="window._overlayEditorClose()">Cancel</button>
                <button class="btn-primary" onclick="window._overlayApply()">Apply</button>
            </div>
        </div>
    `;

    document.body.appendChild(editorModal);
    requestAnimationFrame(() => editorModal.classList.add('visible'));

    canvas = document.getElementById('overlayCanvas');
    ctx = canvas.getContext('2d');

    renderElementControls();
}

// ═══════════════════════════════════════════
//  SAMPLE FRAME LOADING
// ═══════════════════════════════════════════

function loadSampleFrame(assetId) {
    if (!assetId) {
        // No asset available — render with a dark-gray placeholder canvas
        sampleImage = null;
        imageAspect = 16 / 9;
        resizeCanvas();
        renderOverlay();
        const label = document.getElementById('overlayResLabel');
        if (label) label.textContent = 'No preview asset — using placeholder';
        return;
    }
    sampleImage = new Image();
    sampleImage.crossOrigin = 'anonymous';
    sampleImage.onload = () => {
        imageAspect = sampleImage.naturalWidth / sampleImage.naturalHeight;
        resizeCanvas();
        renderOverlay();

        // Show original resolution
        const label = document.getElementById('overlayResLabel');
        if (label) {
            const w = hierarchy.width || sampleImage.naturalWidth;
            const h = hierarchy.height || sampleImage.naturalHeight;
            label.textContent = `Source: ${w} x ${h}`;
        }
    };
    sampleImage.onerror = () => {
        sampleImage = null;
        imageAspect = 16 / 9;
        resizeCanvas();
        showToast('Could not load sample frame', 3000);
        renderOverlay(); // Render on gray background
    };
    sampleImage.src = `/api/overlay/sample-frame/${assetId}?maxw=960&t=${Date.now()}`;
}

function resizeCanvas() {
    const wrap = document.getElementById('overlayCanvasWrap');
    if (!wrap || !canvas) return;

    // CSS display size (small preview)
    const maxW = wrap.clientWidth || 640;
    const cssW = Math.min(maxW, 960);
    const cssH = Math.round(cssW / imageAspect);

    // Internal canvas buffer at reference resolution so font sizes
    // map 1:1 with RV pixels — the browser downscales for display.
    const refW = hierarchy.width || 1920;
    const refH = hierarchy.height || 1080;
    canvas.width = refW;
    canvas.height = refH;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
}

// ═══════════════════════════════════════════
//  CANVAS RENDERING
// ═══════════════════════════════════════════

function renderOverlay() {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;

    // Clear + draw background
    ctx.clearRect(0, 0, w, h);
    if (sampleImage && sampleImage.complete && sampleImage.naturalWidth > 0) {
        ctx.drawImage(sampleImage, 0, 0, w, h);
    } else {
        // Gray checkerboard pattern (scale grid to reference resolution)
        const gridSize = Math.round(20 * (w / 960));
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, 0, w, h);
        for (let y = 0; y < h; y += gridSize) {
            for (let x = 0; x < w; x += gridSize) {
                if ((x / gridSize + y / gridSize) % 2 === 0) {
                    ctx.fillStyle = '#333';
                    ctx.fillRect(x, y, gridSize, gridSize);
                }
            }
        }
    }

    // Draw each enabled element
    ctx.textBaseline = 'top';
    for (const el of elements) {
        if (!el.enabled) continue;
        drawElement(ctx, w, h, el);
    }
}

function drawElement(ctx, cw, ch, el) {
    const text = resolvePreviewText(el);
    if (!text) return;

    // ── Match RV Qt font sizing ─────────────────────────────────
    // Canvas buffer is at reference resolution (1920×1080), so
    // font sizes map 1:1 with RV pixel sizes.
    const fontPx = Math.max(8, el.fontSize);

    // Map font family to actual font stacks
    const FONT_MAP = {
        'monospace':  "'Consolas', 'Courier New', monospace",
        'sans-serif': "Arial, Helvetica, sans-serif",
        'serif':      "'Times New Roman', Georgia, serif",
    };
    const fontStack = FONT_MAP[el.fontFamily] || FONT_MAP['monospace'];

    ctx.font = `bold ${fontPx}px ${fontStack}`;
    ctx.textBaseline = 'top';

    const metrics = ctx.measureText(text);
    const tw = metrics.width;
    const th = fontPx;

    // ── Margins matching RV ──
    const margin = 15;      // RV uses 15px margin
    const transport = 40;   // RV transport bar clearance

    const ox = el.offsetX;
    const oy = el.offsetY;
    let x, y;

    switch (el.anchor) {
        case 'top-left':      x = margin + ox;             y = margin + oy; break;
        case 'top-center':    x = (cw - tw) / 2 + ox;     y = margin + oy; break;
        case 'top-right':     x = cw - margin - tw - ox;   y = margin + oy; break;
        case 'bottom-left':   x = margin + ox;             y = ch - margin - transport - th - oy; break;
        case 'bottom-center': x = (cw - tw) / 2 + ox;     y = ch - margin - transport - th - oy; break;
        case 'bottom-right':  x = cw - margin - tw - ox;   y = ch - margin - transport - th - oy; break;
        case 'center':        x = (cw - tw) / 2 + ox;     y = (ch - th) / 2 + oy; break;
        default:              x = margin + ox;             y = ch - margin - transport - th - oy; break;
    }

    // Background box
    if (el.bgEnabled) {
        const pad = Math.max(1, Math.round(el.bgPadding));
        ctx.fillStyle = hexToRgba(el.bgColor || '#000000', el.bgOpacity ?? 0.5);
        ctx.fillRect(x - pad, y - pad, tw + pad * 2, th + pad * 2);
    }

    // Text
    ctx.fillStyle = hexToRgba(el.fontColor || '#ffffff', el.fontOpacity ?? 1.0);
    ctx.fillText(text, x, y);
}

function resolvePreviewText(el) {
    const typeInfo = ELEMENT_TYPES[el.type];
    if (!typeInfo) return el.text || 'Text';
    return typeInfo.preview(hierarchy, el);
}

// ═══════════════════════════════════════════
//  ELEMENT CONTROLS
// ═══════════════════════════════════════════

function renderElementControls() {
    const list = document.getElementById('overlayElementsList');
    if (!list) return;

    if (elements.length === 0) {
        list.innerHTML = '<div class="overlay-empty">No elements. Click + Add to create one.</div>';
        return;
    }

    list.innerHTML = elements.map((el, i) => {
        const typeInfo = ELEMENT_TYPES[el.type] || { label: el.type };
        const isCustom = el.type === 'custom';

        return `
        <div class="overlay-element-card ${el.enabled ? '' : 'disabled'}" data-index="${i}">
            <div class="overlay-element-header">
                <label class="overlay-element-toggle" title="Enable/Disable">
                    <input type="checkbox" ${el.enabled ? 'checked' : ''}
                        onchange="window._overlayToggleEl(${i}, this.checked)"
                        onpointerdown="event.stopPropagation()">
                </label>
                <span class="overlay-element-title">${esc(typeInfo.label)}</span>
                <button class="overlay-btn-sm overlay-btn-danger" onclick="window._overlayRemoveEl(${i})" title="Remove element">&times;</button>
            </div>
            <div class="overlay-element-body">
                <div class="overlay-ctrl-row">
                    <label>Type</label>
                    <select onchange="window._overlaySetElProp(${i}, 'type', this.value)" onpointerdown="event.stopPropagation()">
                        ${Object.entries(ELEMENT_TYPES).map(([k, v]) => `<option value="${k}" ${el.type === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
                    </select>
                </div>
                ${isCustom ? `
                <div class="overlay-ctrl-row">
                    <label>Text</label>
                    <input type="text" value="${esc(el.text)}" placeholder="Enter text..."
                        oninput="window._overlaySetElProp(${i}, 'text', this.value)"
                        onpointerdown="event.stopPropagation()">
                </div>` : ''}
                <div class="overlay-ctrl-row">
                    <label>Position</label>
                    <select onchange="window._overlaySetElProp(${i}, 'anchor', this.value)" onpointerdown="event.stopPropagation()">
                        ${ANCHOR_OPTIONS.map(a => `<option value="${a.value}" ${el.anchor === a.value ? 'selected' : ''}>${a.label}</option>`).join('')}
                    </select>
                </div>
                <div class="overlay-ctrl-row overlay-ctrl-inline">
                    <div>
                        <label>Offset X</label>
                        <input type="number" min="0" max="500" value="${el.offsetX}"
                            oninput="window._overlaySetElProp(${i}, 'offsetX', +this.value)"
                            onpointerdown="event.stopPropagation()">
                    </div>
                    <div>
                        <label>Offset Y</label>
                        <input type="number" min="0" max="500" value="${el.offsetY}"
                            oninput="window._overlaySetElProp(${i}, 'offsetY', +this.value)"
                            onpointerdown="event.stopPropagation()">
                    </div>
                </div>
                <div class="overlay-ctrl-row">
                    <label>Font Size (px)</label>
                    <input type="range" min="10" max="120" value="${el.fontSize}"
                        oninput="this.nextElementSibling.textContent=this.value; window._overlaySetElProp(${i}, 'fontSize', +this.value)"
                        onpointerdown="event.stopPropagation()">
                    <span class="overlay-range-val">${el.fontSize}</span>
                </div>
                <div class="overlay-ctrl-row overlay-ctrl-inline">
                    <div>
                        <label>Font Color</label>
                        <input type="color" value="${el.fontColor}"
                            oninput="window._overlaySetElProp(${i}, 'fontColor', this.value)"
                            onpointerdown="event.stopPropagation()">
                    </div>
                    <div>
                        <label>Opacity</label>
                        <input type="range" min="0" max="100" value="${Math.round((el.fontOpacity ?? 1) * 100)}"
                            oninput="window._overlaySetElProp(${i}, 'fontOpacity', this.value / 100)"
                            onpointerdown="event.stopPropagation()">
                    </div>
                </div>
                <div class="overlay-ctrl-row">
                    <label>Font</label>
                    <select onchange="window._overlaySetElProp(${i}, 'fontFamily', this.value)" onpointerdown="event.stopPropagation()">
                        <option value="monospace" ${el.fontFamily === 'monospace' ? 'selected' : ''}>Monospace</option>
                        <option value="sans-serif" ${el.fontFamily === 'sans-serif' ? 'selected' : ''}>Sans-serif</option>
                        <option value="serif" ${el.fontFamily === 'serif' ? 'selected' : ''}>Serif</option>
                    </select>
                </div>
                <div class="overlay-ctrl-row overlay-bg-section">
                    <label class="overlay-element-toggle">
                        <input type="checkbox" ${el.bgEnabled ? 'checked' : ''}
                            onchange="window._overlaySetElProp(${i}, 'bgEnabled', this.checked)"
                            onpointerdown="event.stopPropagation()">
                        Background Box
                    </label>
                </div>
                ${el.bgEnabled ? `
                <div class="overlay-ctrl-row overlay-ctrl-inline overlay-bg-controls">
                    <div>
                        <label>BG Color</label>
                        <input type="color" value="${el.bgColor}"
                            oninput="window._overlaySetElProp(${i}, 'bgColor', this.value)"
                            onpointerdown="event.stopPropagation()">
                    </div>
                    <div>
                        <label>BG Opacity</label>
                        <input type="range" min="0" max="100" value="${Math.round((el.bgOpacity ?? 0.5) * 100)}"
                            oninput="window._overlaySetElProp(${i}, 'bgOpacity', this.value / 100)"
                            onpointerdown="event.stopPropagation()">
                    </div>
                    <div>
                        <label>Padding</label>
                        <input type="number" min="0" max="40" value="${el.bgPadding}"
                            oninput="window._overlaySetElProp(${i}, 'bgPadding', +this.value)"
                            onpointerdown="event.stopPropagation()">
                    </div>
                </div>` : ''}
            </div>
        </div>`;
    }).join('');
}

// ═══════════════════════════════════════════
//  ELEMENT CRUD
// ═══════════════════════════════════════════

function makeElement(type = 'shot_name', anchor = 'top-left') {
    return {
        ...JSON.parse(JSON.stringify(DEFAULT_ELEMENT)),
        id: 'el_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        type,
        anchor,
    };
}

window._overlayAddElement = function () {
    elements.push(makeElement('custom', 'top-left'));
    renderElementControls();
    renderOverlay();
};

window._overlayRemoveEl = function (idx) {
    elements.splice(idx, 1);
    renderElementControls();
    renderOverlay();
};

window._overlayToggleEl = function (idx, checked) {
    elements[idx].enabled = checked;
    renderElementControls();
    renderOverlay();
};

window._overlaySetElProp = function (idx, prop, value) {
    elements[idx][prop] = value;
    // If type changed, re-render controls (to show/hide custom text input)
    if (prop === 'type' || prop === 'bgEnabled') {
        renderElementControls();
    }
    renderOverlay();
};

// ═══════════════════════════════════════════
//  PRESET MANAGEMENT
// ═══════════════════════════════════════════

window._overlayLoadPreset = async function (id) {
    if (!id) {
        currentPresetId = null;
        currentPresetName = '';
        elements = [makeElement('shot_and_frame', 'bottom-left')];
        renderElementControls();
        renderOverlay();
        return;
    }

    try {
        const preset = await api(`/api/overlay/presets/${id}`);
        currentPresetId = preset.id;
        currentPresetName = preset.name;
        elements = JSON.parse(JSON.stringify(preset.config.elements || []));
        renderElementControls();
        renderOverlay();
    } catch (e) {
        showToast('Failed to load preset: ' + e.message, 3000);
    }
};

window._overlaySavePreset = async function () {
    if (!currentPresetId) {
        return window._overlaySaveAsPreset();
    }

    try {
        await api(`/api/overlay/presets/${currentPresetId}`, {
            method: 'PUT',
            body: { name: currentPresetName, config: { elements } },
        });
        showToast('Preset saved', 2000);
        await refreshPresetDropdown();
    } catch (e) {
        showToast('Save failed: ' + e.message, 3000);
    }
};

window._overlaySaveAsPreset = async function () {
    const name = prompt('Preset name:', currentPresetName || 'My Overlay');
    if (!name) return;

    try {
        const result = await api('/api/overlay/presets', {
            method: 'POST',
            body: { name, config: { elements } },
        });
        currentPresetId = result.id;
        currentPresetName = name;
        showToast(`Preset "${name}" saved`, 2000);
        await refreshPresetDropdown();
    } catch (e) {
        showToast('Save failed: ' + e.message, 3000);
    }
};

window._overlayDeletePreset = async function () {
    if (!currentPresetId) {
        showToast('No preset selected', 2000);
        return;
    }
    if (!confirm(`Delete preset "${currentPresetName}"?`)) return;

    try {
        await api(`/api/overlay/presets/${currentPresetId}`, { method: 'DELETE' });
        showToast('Preset deleted', 2000);
        currentPresetId = null;
        currentPresetName = '';
        await refreshPresetDropdown();
    } catch (e) {
        showToast('Delete failed: ' + e.message, 3000);
    }
};

async function refreshPresetDropdown() {
    presetsCache = await api('/api/overlay/presets');
    const select = document.getElementById('overlayPresetSelect');
    if (!select) return;

    select.innerHTML = `
        <option value="">(unsaved)</option>
        ${presetsCache.map(p => `<option value="${p.id}" ${p.id === currentPresetId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
    `;
}

// ═══════════════════════════════════════════
//  CLOSE / APPLY
// ═══════════════════════════════════════════

window._overlayEditorClose = function () {
    closeEditor();
};

window._overlayApply = function () {
    closeEditor(currentPresetId);
};

function closeEditor(resultPresetId = null) {
    if (editorModal) {
        editorModal.classList.remove('visible');
        setTimeout(() => {
            editorModal.remove();
            editorModal = null;
        }, 300);
    }
    canvas = null;
    ctx = null;
    sampleImage = null;

    if (onCloseCallback) {
        onCloseCallback(resultPresetId);
        onCloseCallback = null;
    }
}

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════

function hexToRgba(hex, opacity) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16) || 0;
    const g = parseInt(c.substring(2, 4), 16) || 0;
    const b = parseInt(c.substring(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${opacity !== undefined ? opacity : 1})`;
}

// ═══════════════════════════════════════════
//  WINDOW GLOBALS (for onclick handlers in template HTML)
// ═══════════════════════════════════════════

window.showOverlayEditor = showOverlayEditor;
