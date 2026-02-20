/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * Shot Builder - Drag-and-drop naming convention builder
 */

// ===========================================
//  TILE DEFINITIONS
// ===========================================

const TILE_DEFS = [
    { type: 'project',   label: 'Project',   icon: '[P]', example: 'myproj',   color: '#5b8c6b',  hint: 'Your project code (set when creating the project)' },
    { type: 'episode',   label: 'Episode',   icon: '[S]', example: 'E01',      color: '#6b7b8c',  hint: 'Episode code (you define these in your sequences)' },
    { type: 'sequence',  label: 'Sequence',  icon: '', example: 'SQ010',    color: '#8c7b5b',  hint: 'Sequence code (SQ010, SQ020, etc.)' },
    { type: 'shot',      label: 'Shot',      icon: '', example: 'SH010',    color: '#8c5b5b',  hint: 'Shot code (SH010, SH020, etc.)' },
    { type: 'role',      label: 'Role',      icon: '[R]', example: 'comp',     color: '#7b5b8c',  hint: 'Pipeline step (comp, light, anim, fx, etc.)' },
    { type: 'version',   label: 'Version',   icon: '', example: 'v001',     color: '#5b7b8c',  hint: 'Auto-incremented version number' },
    { type: 'take',      label: 'Take',      icon: '[S]', example: 'T01',      color: '#8c8c5b',  hint: 'Take number' },
    { type: 'date',      label: 'Date',      icon: '[D]', example: '20260217', color: '#5b8c8c',  hint: 'Import date (auto-filled)' },
    { type: 'counter',   label: 'Counter',   icon: '[#]', example: '0001',     color: '#7b8c5b',  hint: 'Auto counter' },
    { type: 'wildcard',  label: 'Wildcard',  icon: '[W]', example: '???',      color: '#b89050',  hint: 'Custom value (you name it, you fill it)' },
];

// ===========================================
//  STATE
// ===========================================

let assemblyTokens = [];  // Array of { type, separator, label?, value?, askAtImport? }
let dragSource = null;     // { from: 'inventory'|'assembly', index?, type, def }
let dropTargetIndex = -1;
let projectContext = null; // { code, name } - set when editing an existing project

// ===========================================
//  RENDER
// ===========================================

/**
 * Render the entire Shot Builder into a container element.
 * @param {HTMLElement} container - The DOM element to render into
 * @param {Array|null} existingConvention - Existing convention to load (for editing)
 * @param {Object|null} context - Optional { code, name } for the project (used in preview)
 */
export function renderShotBuilder(container, existingConvention = null, context = null) {
    projectContext = context;
    if (existingConvention && Array.isArray(existingConvention)) {
        assemblyTokens = existingConvention.map(t => ({ ...t }));
    } else {
        assemblyTokens = [];
    }

    container.innerHTML = `
        <div class="sb-wrapper">
            <div class="sb-header">
                <span class="sb-title"> Naming Convention</span>
                <span class="sb-subtitle">Click or drag tokens to build pattern</span>
            </div>

            <div class="sb-inventory" id="sbInventory">
                ${TILE_DEFS.map(def => renderInventoryTile(def)).join('')}
            </div>

            <div class="sb-assembly-label">
                <span>Filename pattern</span>
                ${assemblyTokens.length > 0 ? '<button class="sb-clear-btn" id="sbClearAll">x Clear</button>' : ''}
            </div>
            <div class="sb-assembly" id="sbAssembly">
                ${assemblyTokens.length === 0
                    ? '<div class="sb-assembly-empty">Click or drag tokens from above</div>'
                    : renderAssemblyTokens()
                }
            </div>

            <div class="sb-preview-label">Preview</div>
            <div class="sb-preview" id="sbPreview">${generatePreview()}</div>
        </div>
    `;

    // Bind events
    _activeContainer = container;
    bindInventoryDragEvents(container);
    bindAssemblyDropZone(container);
    bindAssemblyDragEvents(container);
    bindControlEvents(container);

    const clearBtn = container.querySelector('#sbClearAll');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            assemblyTokens = [];
            renderShotBuilder(container, null, projectContext);
        });
    }
}

function renderInventoryTile(def) {
    return `<div class="sb-tile sb-tile-inv" draggable="true" data-type="${def.type}"
                 style="--tile-color: ${def.color};"
                 title="${def.hint || def.label} - click to add, or drag to position">
        <span class="sb-tile-icon">${def.icon}</span>
        <span class="sb-tile-label">${def.label}</span>
    </div>`;
}

function renderAssemblyTokens() {
    // Build the inline token row (tiles + separators)
    const tokenRow = assemblyTokens.map((tok, i) => {
        const def = TILE_DEFS.find(d => d.type === tok.type) || TILE_DEFS[TILE_DEFS.length - 1];
        const sepValue = tok.separator || '';

        // Separator input (between tokens)
        const sepHtml = i > 0
            ? `<input class="sb-sep" type="text" maxlength="4"
                      data-sep-index="${i}" value="${escHtml(sepValue)}"
                      placeholder="." title="Separator - click to edit (e.g. _ - . or empty)">`
            : '';

        const label = tok.type === 'wildcard' ? (tok.label || 'Wildcard') : def.label;

        return `${sepHtml}<div class="sb-tile sb-tile-asm" draggable="true" data-asm-index="${i}"
                     style="--tile-color: ${def.color};">
            <span class="sb-tile-icon">${def.icon}</span>
            <span class="sb-tile-label">${label}</span>
            <button class="sb-tile-remove" data-remove="${i}" title="Remove">x</button>
        </div>`;
    }).join('');

    // Build wildcard control rows (rendered below the token row)
    const wcRows = assemblyTokens.map((tok, i) => {
        if (tok.type !== 'wildcard') return '';
        return `<div class="sb-wc-row" data-wc-for="${i}">
            <span class="sb-wc-tag" style="background: #b89050;">[W] ${escHtml(tok.label || 'Wildcard')}</span>
            <input class="sb-wc-label" type="text" value="${escHtml(tok.label || 'Custom')}"
                   placeholder="Label" data-wc-label="${i}" title="Name for this wildcard">
            <input class="sb-wc-value" type="text" value="${escHtml(tok.value || '')}"
                   placeholder="Default value" data-wc-value="${i}" title="Default value used in filename">
            <label class="sb-wc-ask" title="Prompt for this value during import">
                <input type="checkbox" data-wc-ask="${i}" ${tok.askAtImport ? 'checked' : ''}>
                Ask at import
            </label>
        </div>`;
    }).filter(Boolean).join('');

    return tokenRow + (wcRows ? `<div class="sb-wc-section">${wcRows}</div>` : '');
}

function getExampleForToken(tok) {
    if (tok.type === 'wildcard') return tok.value || tok.label || '???';
    // Use real project data when available
    if (tok.type === 'project' && projectContext?.code) return projectContext.code.toLowerCase();
    if (tok.type === 'episode' && projectContext?.episode) return projectContext.episode;
    if (projectContext?.sequences?.length) {
        const firstSeq = projectContext.sequences[0];
        if (tok.type === 'sequence') return firstSeq.name;
        if (tok.type === 'shot' && firstSeq.shots?.length) return firstSeq.shots[0].name;
    }
    const def = TILE_DEFS.find(d => d.type === tok.type);
    return def?.example || '???';
}

function generatePreview() {
    if (assemblyTokens.length === 0) return '<span class="sb-preview-empty">- no tokens yet -</span>';

    // Line 1: the filename with color-coded tokens
    const filenameParts = assemblyTokens.map((tok, i) => {
        const def = TILE_DEFS.find(d => d.type === tok.type);
        const example = getExampleForToken(tok);
        const sep = i > 0 ? escHtml(tok.separator || '') : '';
        return `${sep}<span class="sb-preview-token" style="color: ${def?.color || '#aaa'}">${escHtml(example)}</span>`;
    });
    const filenameLine = filenameParts.join('');

    // Line 2: legend showing token name = resolved value, so user knows exactly where each part comes from
    const legendParts = assemblyTokens.map(tok => {
        const def = TILE_DEFS.find(d => d.type === tok.type);
        const label = tok.type === 'wildcard' ? (tok.label || 'wildcard') : def.label.toLowerCase();
        const val = getExampleForToken(tok);
        return `<span style="color: ${def?.color || '#aaa'}">${label}:<b>${escHtml(val)}</b></span>`;
    });
    const legendLine = legendParts.join(' . ');

    // Note: role + version + extension are appended by the Saver node at save time
    return `<div>${filenameLine}<span class="sb-preview-ext">_role_v001.ext</span></div>`
        + `<div class="sb-prev-legend">-> ${legendLine} <span style="color:#666">+ role, version, format added at save time</span></div>`;
}

// ===========================================
//  DRAG & DROP - INVENTORY
// ===========================================

function bindInventoryDragEvents(container) {
    container.querySelectorAll('.sb-tile-inv').forEach(tile => {
        tile.addEventListener('dragstart', (e) => {
            const type = tile.dataset.type;
            const def = TILE_DEFS.find(d => d.type === type);
            dragSource = { from: 'inventory', type, def };
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', type);
            tile.classList.add('sb-dragging');
        });
        tile.addEventListener('dragend', () => {
            tile.classList.remove('sb-dragging');
            dragSource = null;
            clearDropIndicators(container);
        });
        // Click to append token to end of flow
        tile.addEventListener('click', () => {
            const type = tile.dataset.type;
            const newToken = { type, separator: assemblyTokens.length > 0 ? '_' : '' };
            if (type === 'wildcard') {
                newToken.label = 'Custom';
                newToken.value = '';
                newToken.askAtImport = false;
            }
            assemblyTokens.push(newToken);
            renderShotBuilder(container, assemblyTokens, projectContext);
        });
    });
}

// ===========================================
//  DRAG & DROP - ASSEMBLY ZONE
// ===========================================

function bindAssemblyDropZone(container) {
    const zone = container.querySelector('#sbAssembly');
    if (!zone) return;

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = dragSource?.from === 'assembly' ? 'move' : 'copy';

        // Calculate drop position
        const tiles = Array.from(zone.querySelectorAll('.sb-tile-asm'));
        const dropIdx = getDropIndex(e, tiles, zone);
        highlightDropPosition(zone, tiles, dropIdx);
    });

    zone.addEventListener('dragleave', (e) => {
        if (!zone.contains(e.relatedTarget)) {
            clearDropIndicators(container);
        }
    });

    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        clearDropIndicators(container);

        const tiles = Array.from(zone.querySelectorAll('.sb-tile-asm'));
        const dropIdx = getDropIndex(e, tiles, zone);

        if (dragSource?.from === 'inventory') {
            // Add new token from inventory
            const newToken = { type: dragSource.type, separator: assemblyTokens.length > 0 ? '_' : '' };
            if (dragSource.type === 'wildcard') {
                newToken.label = 'Custom';
                newToken.value = '';
                newToken.askAtImport = false;
            }
            assemblyTokens.splice(dropIdx, 0, newToken);
            // First token never has a separator
            if (assemblyTokens.length > 0) assemblyTokens[0].separator = '';
        } else if (dragSource?.from === 'assembly') {
            // Reorder within assembly
            const fromIdx = dragSource.index;
            if (fromIdx !== dropIdx && fromIdx !== dropIdx - 1) {
                const [moved] = assemblyTokens.splice(fromIdx, 1);
                const insertAt = fromIdx < dropIdx ? dropIdx - 1 : dropIdx;
                assemblyTokens.splice(insertAt, 0, moved);
                // First token never has a separator
                if (assemblyTokens.length > 0) assemblyTokens[0].separator = '';
            }
        }

        dragSource = null;
        renderShotBuilder(container, assemblyTokens, projectContext);
    });
}

function bindAssemblyDragEvents(container) {
    container.querySelectorAll('.sb-tile-asm').forEach(tile => {
        tile.addEventListener('dragstart', (e) => {
            const idx = parseInt(tile.dataset.asmIndex);
            dragSource = { from: 'assembly', index: idx, type: assemblyTokens[idx].type };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'reorder');
            tile.classList.add('sb-dragging');
        });
        tile.addEventListener('dragend', () => {
            tile.classList.remove('sb-dragging');
            dragSource = null;
            clearDropIndicators(container);
        });
    });
}

function getDropIndex(e, tiles, zone) {
    if (tiles.length === 0) return 0;

    for (let i = 0; i < tiles.length; i++) {
        const rect = tiles[i].getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (e.clientX < midX) return i;
    }
    return tiles.length;
}

function highlightDropPosition(zone, tiles, dropIdx) {
    clearDropIndicators(zone.closest('.sb-wrapper'));

    if (tiles.length === 0) {
        zone.classList.add('sb-drop-here');
        return;
    }

    if (dropIdx < tiles.length) {
        tiles[dropIdx].classList.add('sb-drop-before');
    } else if (tiles.length > 0) {
        tiles[tiles.length - 1].classList.add('sb-drop-after');
    }
}

function clearDropIndicators(container) {
    if (!container) return;
    container.querySelectorAll('.sb-drop-before, .sb-drop-after').forEach(el => {
        el.classList.remove('sb-drop-before', 'sb-drop-after');
    });
    const zone = container.querySelector('#sbAssembly');
    if (zone) zone.classList.remove('sb-drop-here');
}

// ===========================================
//  CONTROL EVENTS (separators, remove, wildcard)
// ===========================================

function bindControlEvents(container) {
    // Separator inputs
    container.querySelectorAll('.sb-sep').forEach(input => {
        input.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.sepIndex);
            assemblyTokens[idx].separator = e.target.value;
            updatePreview(container);
        });
        // Prevent drag when editing
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('pointerdown', e => e.stopPropagation());
    });

    // Remove buttons
    container.querySelectorAll('.sb-tile-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.remove);
            assemblyTokens.splice(idx, 1);
            if (assemblyTokens.length > 0) assemblyTokens[0].separator = '';
            renderShotBuilder(container, assemblyTokens, projectContext);
        });
    });

    // Wildcard label
    container.querySelectorAll('.sb-wc-label').forEach(input => {
        input.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.wcLabel);
            assemblyTokens[idx].label = e.target.value;
            updatePreview(container);
        });
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('pointerdown', e => e.stopPropagation());
    });

    // Wildcard default value
    container.querySelectorAll('.sb-wc-value').forEach(input => {
        input.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.wcValue);
            assemblyTokens[idx].value = e.target.value;
            updatePreview(container);
        });
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('pointerdown', e => e.stopPropagation());
    });

    // Wildcard ask-at-import checkbox
    container.querySelectorAll('[data-wc-ask]').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.wcAsk);
            assemblyTokens[idx].askAtImport = e.target.checked;
        });
        cb.addEventListener('mousedown', e => e.stopPropagation());
        cb.addEventListener('pointerdown', e => e.stopPropagation());
    });
}

function updatePreview(container) {
    const previewEl = container.querySelector('#sbPreview');
    if (previewEl) previewEl.innerHTML = generatePreview();
}

// Live project code updater - called from browser.js when user types in code input
let _activeContainer = null;
window._sbSetProjectCode = function(code) {
    projectContext = code ? { code, name: code } : null;
    if (_activeContainer) updatePreview(_activeContainer);
};

// Live episode updater - called from browser.js when user types in episode input
window._sbSetEpisode = function(ep) {
    if (projectContext) projectContext.episode = ep;
    if (_activeContainer) updatePreview(_activeContainer);
};

// ===========================================
//  PUBLIC API
// ===========================================

/** Get the current convention as a JSON-serializable array */
export function getConvention() {
    if (assemblyTokens.length === 0) return null;
    return assemblyTokens.map(t => {
        const out = { type: t.type, separator: t.separator || '' };
        if (t.type === 'wildcard') {
            out.label = t.label || 'Custom';
            out.value = t.value || '';
            out.askAtImport = !!t.askAtImport;
        }
        return out;
    });
}

/** Check if any wildcard tokens have "ask at import" enabled */
export function getAskAtImportWildcards() {
    return assemblyTokens
        .filter(t => t.type === 'wildcard' && t.askAtImport)
        .map(t => ({ label: t.label || 'Custom', defaultValue: t.value || '' }));
}

// ===========================================
//  UTILITY
// ===========================================

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}


