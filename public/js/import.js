/**
 * DMV — Import Module
 * File browser, import flow, rename preview.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, escAttr, formatSize, showToast } from './utils.js';

// ═══════════════════════════════════════════
//  IMPORT TAB
// ═══════════════════════════════════════════

export async function loadImportTab() {
    // Populate project dropdown
    const projects = await api('/api/projects');
    const sel = document.getElementById('importProject');
    sel.innerHTML = '<option value="">-- Select Project --</option>' +
        projects.map(p => `<option value="${p.id}">${p.name} (${p.code})</option>`).join('');

    // Browse to default location or drives
    if (!state.importBrowsePath) {
        browseTo('');
    }
}

async function browseTo(dirPath) {
    const params = dirPath ? `?dir=${encodeURIComponent(dirPath)}` : '';
    try {
        const result = await api(`/api/assets/browse${params}`);
        state.importBrowsePath = result.path || '';

        document.getElementById('importPath').value = result.path || 'Computer';
        renderFileBrowser(result);
    } catch (err) {
        console.error('Browse failed:', err);
    }
}

function navigateUp() {
    if (!state.importBrowsePath) return;
    const parent = state.importBrowsePath.replace(/[\\/][^\\/]+$/, '') || '';
    browseTo(parent);
}

function renderFileBrowser(result) {
    const browser = document.getElementById('fileBrowser');

    let html = '';

    // Parent directory
    if (result.parent) {
        html += `<div class="fb-entry" ondblclick="browseTo('${escAttr(result.parent)}')">
            <span class="fb-icon">⬆️</span>
            <span class="fb-name">..</span>
        </div>`;
    }

    // Store file entries for shift-select
    state.browsedFiles = result.entries.filter(e => !e.isDirectory);
    state.lastClickedIndex = -1;

    for (const entry of result.entries) {
        const isSelected = state.selectedFiles.some(f => f.path === entry.path);

        if (entry.isDirectory) {
            html += `<div class="fb-entry" ondblclick="browseTo('${escAttr(entry.path)}')">
                <span class="fb-icon">${entry.icon || '📁'}</span>
                <span class="fb-name">${esc(entry.name)}</span>
            </div>`;
        } else {
            const fileIdx = state.browsedFiles.findIndex(f => f.path === entry.path);
            html += `<div class="fb-entry ${isSelected ? 'selected' : ''}" data-fidx="${fileIdx}"
                onclick="toggleFileSelect(event, ${fileIdx})">
                <span class="fb-icon">${entry.icon}</span>
                <span class="fb-name">${esc(entry.name)}</span>
                <span class="fb-size">${formatSize(entry.size)}</span>
            </div>`;
        }
    }

    // Select All / Deselect All buttons
    if (state.browsedFiles.length > 0) {
        html += `<div style="padding:6px 8px;display:flex;gap:8px;border-top:1px solid var(--border-color);margin-top:4px;">
            <button class="btn-small" onclick="selectAllFiles()" style="font-size:0.75rem;padding:3px 8px;cursor:pointer;">☑ Select All Media</button>
            <button class="btn-small" onclick="deselectAllFiles()" style="font-size:0.75rem;padding:3px 8px;cursor:pointer;">☐ Deselect All</button>
        </div>`;
    }

    if (result.entries.length === 0) {
        html += '<div class="fb-entry" style="color:var(--text-muted)"><span class="fb-icon">📭</span><span>Empty folder</span></div>';
    }

    browser.innerHTML = html;
}

function toggleFileSelect(event, fileIdx) {
    const entry = state.browsedFiles[fileIdx];
    if (!entry) return;

    if (event.shiftKey && state.lastClickedIndex >= 0) {
        const start = Math.min(state.lastClickedIndex, fileIdx);
        const end = Math.max(state.lastClickedIndex, fileIdx);
        for (let i = start; i <= end; i++) {
            const f = state.browsedFiles[i];
            if (!state.selectedFiles.some(s => s.path === f.path)) {
                state.selectedFiles.push({
                    path: f.path, name: f.name, size: f.size,
                    mediaType: f.mediaType || '', icon: f.icon || '📎'
                });
            }
        }
    } else {
        const idx = state.selectedFiles.findIndex(f => f.path === entry.path);
        if (idx >= 0) {
            state.selectedFiles.splice(idx, 1);
        } else {
            state.selectedFiles.push({
                path: entry.path, name: entry.name, size: entry.size,
                mediaType: entry.mediaType || '', icon: entry.icon || '📎'
            });
        }
    }

    state.lastClickedIndex = fileIdx;
    updateSelectedList();
    updateRenamePreview();
    refreshBrowserSelection();
}

function selectAllFiles() {
    for (const f of state.browsedFiles) {
        if (!state.selectedFiles.some(s => s.path === f.path)) {
            state.selectedFiles.push({
                path: f.path, name: f.name, size: f.size,
                mediaType: f.mediaType || '', icon: f.icon || '📎'
            });
        }
    }
    updateSelectedList();
    updateRenamePreview();
    refreshBrowserSelection();
}

function deselectAllFiles() {
    const browsedPaths = new Set(state.browsedFiles.map(f => f.path));
    state.selectedFiles = state.selectedFiles.filter(f => !browsedPaths.has(f.path));
    updateSelectedList();
    updateRenamePreview();
    refreshBrowserSelection();
}

function refreshBrowserSelection() {
    document.querySelectorAll('.fb-entry[data-fidx]').forEach(el => {
        const idx = parseInt(el.dataset.fidx);
        const entry = state.browsedFiles[idx];
        if (entry) {
            el.classList.toggle('selected', state.selectedFiles.some(f => f.path === entry.path));
        }
    });
}

function updateSelectedList() {
    const count = state.selectedFiles.length;
    document.getElementById('selectedCount').textContent = count;
    document.getElementById('importBtn').disabled = count === 0 || !document.getElementById('importProject').value;

    document.getElementById('selectedFilesList').innerHTML = state.selectedFiles.map(f => `
        <div class="selected-item">
            <span>${f.icon} ${esc(f.name)}</span>
            <button class="remove-btn" onclick="removeSelectedFile('${escAttr(f.path)}')">✕</button>
        </div>
    `).join('');
}

function removeSelectedFile(filePath) {
    state.selectedFiles = state.selectedFiles.filter(f => f.path !== filePath);
    updateSelectedList();
    updateRenamePreview();
}

async function onImportProjectChange() {
    const projectId = document.getElementById('importProject').value;
    const shotFields = document.getElementById('importShotFields');

    if (projectId) {
        const project = await api(`/api/projects/${projectId}`);
        if (project.type !== 'simple' && project.sequences?.length > 0) {
            shotFields.style.display = 'block';
            const seqSel = document.getElementById('importSequence');
            seqSel.innerHTML = '<option value="">-- None --</option>' +
                project.sequences.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
        } else {
            shotFields.style.display = project.type === 'simple' ? 'none' : 'block';
            document.getElementById('importSequence').innerHTML = '<option value="">-- None (create one first) --</option>';
        }

        // Populate roles dropdown
        try {
            const roles = await api('/api/roles');
            const roleSel = document.getElementById('importRole');
            if (roleSel) {
                roleSel.innerHTML = '<option value="">-- None --</option>' +
                    roles.map(r => `<option value="${r.id}" data-code="${r.code}">${r.icon} ${r.name}</option>`).join('');
            }
        } catch { /* roles not available */ }
    } else {
        shotFields.style.display = 'none';
    }

    updateSelectedList();
    updateRenamePreview();
}

async function onImportSequenceChange() {
    const projectId = document.getElementById('importProject').value;
    const seqId = document.getElementById('importSequence').value;
    const shotSel = document.getElementById('importShot');

    if (seqId && projectId) {
        const shots = await api(`/api/projects/${projectId}/sequences/${seqId}/shots`);
        shotSel.innerHTML = '<option value="">-- None --</option>' +
            shots.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
    } else {
        shotSel.innerHTML = '<option value="">-- None --</option>';
    }
    updateRenamePreview();
}

async function updateRenamePreview() {
    const preview = document.getElementById('renamePreview');
    const projectId = document.getElementById('importProject').value;
    const customName = document.getElementById('importCustomName')?.value?.trim();

    if (!state.selectedFiles.length || !projectId) {
        preview.textContent = 'Select files and project to preview...';
        return;
    }

    try {
        const projects = state.projects.length ? state.projects : await api('/api/projects');
        const project = projects.find(p => p.id == projectId);
        if (!project) { preview.textContent = 'Project not found'; return; }

        const seqId = document.getElementById('importSequence')?.value;
        const shotId = document.getElementById('importShot')?.value;
        const take = document.getElementById('importTake')?.value || 1;

        let seqCode = '', shotCode = '';
        if (seqId) {
            const seqSel = document.getElementById('importSequence');
            const opt = seqSel.options[seqSel.selectedIndex];
            seqCode = opt?.textContent?.split(' — ')[0]?.trim() || '';
        }
        if (shotId) {
            const shotSel = document.getElementById('importShot');
            const opt = shotSel.options[shotSel.selectedIndex];
            shotCode = opt?.textContent?.split(' — ')[0]?.trim() || '';
        }

        // Get role code for naming
        let roleCode;
        const roleId = document.getElementById('importRole')?.value;
        if (roleId) {
            const roleSel = document.getElementById('importRole');
            const roleOpt = roleSel.options[roleSel.selectedIndex];
            roleCode = roleOpt?.dataset?.code;
        }

        const firstFile = state.selectedFiles[0];
        const result = await api('/api/assets/preview-name', {
            method: 'POST',
            body: {
                originalName: firstFile.name,
                projectCode: project.code,
                sequenceCode: seqCode || undefined,
                shotCode: shotCode || undefined,
                roleCode: roleCode || undefined,
                takeNumber: parseInt(take),
                customName: customName || undefined,
            },
        });

        let previewText = `${firstFile.name}\n  → ${result.vaultName}`;
        if (state.selectedFiles.length > 1) {
            previewText += `\n  ... and ${state.selectedFiles.length - 1} more files`;
        }
        preview.textContent = previewText;
    } catch (err) {
        preview.textContent = 'Preview error: ' + err.message;
    }
}

async function executeImport() {
    const projectId = document.getElementById('importProject').value;
    if (!projectId || !state.selectedFiles.length) return;

    const seqId = document.getElementById('importSequence')?.value || undefined;
    const shotId = document.getElementById('importShot')?.value || undefined;
    const roleId = document.getElementById('importRole')?.value || undefined;
    const take = document.getElementById('importTake')?.value || 1;
    const customName = document.getElementById('importCustomName')?.value?.trim() || undefined;

    const btn = document.getElementById('importBtn');
    const progress = document.getElementById('importProgress');
    const progressFill = document.getElementById('importProgressFill');
    const resultDiv = document.getElementById('importResult');

    btn.disabled = true;
    btn.textContent = '⏳ Importing...';
    progress.style.display = 'block';
    progressFill.style.width = '10%';
    resultDiv.style.display = 'none';

    try {
        // Determine import mode from radio buttons
        const importMode = document.querySelector('input[name="importMode"]:checked')?.value || 'move';
        const keepOriginals = importMode === 'copy';
        const registerInPlace = importMode === 'register';

        const result = await api('/api/assets/import', {
            method: 'POST',
            body: {
                files: state.selectedFiles.map(f => f.path),
                project_id: parseInt(projectId),
                sequence_id: seqId ? parseInt(seqId) : undefined,
                shot_id: shotId ? parseInt(shotId) : undefined,
                role_id: roleId ? parseInt(roleId) : undefined,
                take_number: parseInt(take),
                custom_name: customName,
                keep_originals: keepOriginals,
                register_in_place: registerInPlace,
            },
        });

        progressFill.style.width = '100%';

        resultDiv.style.display = 'block';
        if (result.imported > 0) {
            resultDiv.className = 'import-result success';
            resultDiv.innerHTML = `✅ Imported ${result.imported} file(s) successfully!` +
                (result.errors > 0 ? `<br>⚠️ ${result.errors} error(s)` : '');
        } else {
            resultDiv.className = 'import-result error';
            resultDiv.innerHTML = `❌ No files imported. ` +
                (result.errors_detail?.map(e => e.error).join(', ') || '');
        }

        // Clear selection
        state.selectedFiles = [];
        updateSelectedList();
        updateRenamePreview();

        // Refresh counts
        window.checkSetup();
    } catch (err) {
        resultDiv.style.display = 'block';
        resultDiv.className = 'import-result error';
        resultDiv.innerHTML = `❌ Import failed: ${err.message}`;
    }

    btn.disabled = false;
    btn.textContent = '📥 Import & Rename';
    setTimeout(() => { progress.style.display = 'none'; }, 2000);
}

function importToProject() {
    window.switchTab('import');
    // Pre-select current project
    setTimeout(() => {
        if (state.currentProject) {
            document.getElementById('importProject').value = state.currentProject.id;
            onImportProjectChange();
        }
    }, 100);
}

// ═══════════════════════════════════════════
//  INIT — Event listeners for rename preview
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('importCustomName')?.addEventListener('input', updateRenamePreview);
    document.getElementById('importTake')?.addEventListener('input', updateRenamePreview);
});

// ═══════════════════════════════════════════
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ═══════════════════════════════════════════

window.browseTo = browseTo;
window.navigateUp = navigateUp;
window.toggleFileSelect = toggleFileSelect;
window.selectAllFiles = selectAllFiles;
window.deselectAllFiles = deselectAllFiles;
window.removeSelectedFile = removeSelectedFile;
window.onImportProjectChange = onImportProjectChange;
window.onImportSequenceChange = onImportSequenceChange;
window.updateRenamePreview = updateRenamePreview;
window.executeImport = executeImport;
window.importToProject = importToProject;
