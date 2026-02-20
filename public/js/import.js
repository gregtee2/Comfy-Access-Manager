/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV - Import Module
 * File browser, import flow, rename preview.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, escAttr, formatSize, showToast } from './utils.js';

// ===========================================
//  SSE Import Progress Helper
// ===========================================

/**
 * POST to /api/assets/import?stream=1 and read SSE progress events.
 * Updates progress bar in real-time, returns the final result JSON.
 */
async function importWithProgress(body, progressFill, progressText) {
    return new Promise(async (resolve, reject) => {
        try {
            const userId = localStorage.getItem('cam_user_id');
            const response = await fetch('/api/assets/import?stream=1', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(userId ? { 'X-CAM-User': userId } : {}),
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({ error: response.statusText }));
                return reject(new Error(err.error || 'Import failed'));
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Parse SSE events from buffer
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line

                let eventType = 'message';
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.slice(7).trim();
                    } else if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            if (eventType === 'done') {
                                finalResult = parsed;
                            } else {
                                // Progress update
                                const pct = Math.round((parsed.current / parsed.total) * 100);
                                if (progressFill) progressFill.style.width = pct + '%';
                                if (progressText) {
                                    const shortName = parsed.file?.length > 40
                                        ? '...' + parsed.file.slice(-37) : parsed.file;
                                    progressText.textContent = `${parsed.current} / ${parsed.total}  -  ${shortName || ''}`;
                                }
                            }
                        } catch {}
                        eventType = 'message'; // reset after data line
                    }
                }
            }

            if (finalResult) {
                if (progressFill) progressFill.style.width = '100%';
                if (progressText) progressText.textContent = ` ${finalResult.imported} imported`;
                resolve(finalResult);
            } else {
                reject(new Error('Import stream ended without result'));
            }
        } catch (err) {
            reject(err);
        }
    });
}

// ===========================================
//  IMPORT TAB
// ===========================================

export async function loadImportTab() {
    // Populate project dropdown
    const projects = await api('/api/projects');
    const sel = document.getElementById('importProject');
    sel.innerHTML = '<option value="">-- Select Project --</option>' +
        projects.map(p => `<option value="${p.id}">${p.name} (${p.code})</option>`).join('');

    // Set up auto-code generation for inline create forms
    setupInlineAutoCode('newSeqName', 'newSeqCode', 'SQ');
    setupInlineAutoCode('newShotName', 'newShotCode', 'SH');

    // Load Quick Access favorites
    loadQuickAccess();

    // Load inbox watch folders
    loadInboxes();

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
    const current = state.importBrowsePath;
    // Detect drive root: "C:\" or "C:" on Windows, "/" on Mac/Linux
    const isDriveRoot = /^[A-Z]:[\\/]?$/i.test(current) || current === '/';
    if (isDriveRoot) {
        browseTo('');  // Back to drive/volume list
        return;
    }
    const parent = current.replace(/[\\/][^\\/]+$/, '') || '';
    browseTo(parent);
}

function renderFileBrowser(result) {
    const browser = document.getElementById('fileBrowser');

    let html = '';

    // Parent directory (parent='' means "go to drive list", parent=null means "already at top")
    if (result.parent != null) {
        html += `<div class="fb-entry" ondblclick="browseTo('${escAttr(result.parent)}')">
            <span class="fb-icon">Up</span>
            <span class="fb-name">..</span>
        </div>`;
    }

    // Store file entries for shift-select
    state.browsedFiles = result.entries.filter(e => !e.isDirectory);
    state.lastClickedIndex = -1;

    for (const entry of result.entries) {
        const isSelected = state.selectedFiles.some(f => f.path === entry.path);

        if (entry.isDirectory) {
            html += `<div class="fb-entry" draggable="true"
                ondblclick="browseTo('${escAttr(entry.path)}')"
                ondragstart="onFolderDragStart(event, '${escAttr(entry.path)}', '${escAttr(entry.name)}')"
                oncontextmenu="onFolderContextMenu(event, '${escAttr(entry.path)}', '${escAttr(entry.name)}')">
                <span class="fb-icon">${entry.icon || ''}</span>
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

    // Show/hide the fixed Select All / Deselect All bar below the scroll area
    const selBar = document.getElementById('fileBrowserSelectBar');
    if (selBar) selBar.style.display = state.browsedFiles.length > 0 ? 'flex' : 'none';

    if (result.entries.length === 0) {
        html += '<div class="fb-entry" style="color:var(--text-muted)"><span class="fb-icon"></span><span>Empty folder</span></div>';
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
                    mediaType: f.mediaType || '', icon: f.icon || ''
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
                mediaType: entry.mediaType || '', icon: entry.icon || ''
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
                mediaType: f.mediaType || '', icon: f.icon || ''
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
            <button class="remove-btn" onclick="removeSelectedFile('${escAttr(f.path)}')">x</button>
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

    // Hide inline create forms when project changes
    hideInlineNewSequence();
    hideInlineNewShot();

    if (projectId) {
        const project = await api(`/api/projects/${projectId}`);

        // Always show shot fields for non-simple projects (user can create sequences inline)
        shotFields.style.display = project.type === 'simple' ? 'none' : 'block';

        const seqSel = document.getElementById('importSequence');
        if (project.sequences?.length > 0) {
            seqSel.innerHTML = '<option value="">-- None --</option>' +
                project.sequences.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
        } else {
            seqSel.innerHTML = '<option value="">-- None --</option>';
        }

        // Reset shot dropdown
        document.getElementById('importShot').innerHTML = '<option value="">-- None --</option>';

        // Enable/disable shot + button based on whether a sequence is selected
        const btnNewShot = document.getElementById('btnNewShot');
        if (btnNewShot) btnNewShot.disabled = !seqSel.value;

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

    // Hide shot inline form when sequence changes
    hideInlineNewShot();

    // Enable/disable the shot + button
    const btnNewShot = document.getElementById('btnNewShot');
    if (btnNewShot) btnNewShot.disabled = !seqId;

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
    const keepOriginal = document.getElementById('keepOriginalNames')?.checked;

    // Toggle naming options visibility
    const namingOpts = document.getElementById('namingOptions');
    if (namingOpts) namingOpts.style.display = keepOriginal ? 'none' : '';

    if (keepOriginal) {
        if (state.selectedFiles.length) {
            const first = state.selectedFiles[0];
            let txt = `${first.name}  ->  ${first.name} (unchanged)`;
            if (state.selectedFiles.length > 1) txt += `\n  ... and ${state.selectedFiles.length - 1} more files`;
            preview.textContent = txt;
        }
        return;
    }

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
            seqCode = opt?.textContent?.split(' - ')[0]?.trim() || '';
        }
        if (shotId) {
            const shotSel = document.getElementById('importShot');
            const opt = shotSel.options[shotSel.selectedIndex];
            shotCode = opt?.textContent?.split(' - ')[0]?.trim() || '';
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

        let previewText = `${firstFile.name}\n  -> ${result.vaultName}`;
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

    // --- Auto-create any pending inline sequence/shot ---
    const pendingSeqForm = document.getElementById('inlineNewSequence');
    if (pendingSeqForm && pendingSeqForm.style.display !== 'none') {
        const seqName = document.getElementById('newSeqName').value.trim();
        if (seqName) {
            await createInlineSequence();
            // If creation failed (form still visible), abort import
            if (pendingSeqForm.style.display !== 'none') return;
        }
    }
    const pendingShotForm = document.getElementById('inlineNewShot');
    if (pendingShotForm && pendingShotForm.style.display !== 'none') {
        const shotName = document.getElementById('newShotName').value.trim();
        if (shotName) {
            await createInlineShot();
            // If creation failed (form still visible), abort import
            if (pendingShotForm.style.display !== 'none') return;
        }
    }

    // --- Move-mode confirmation gate ---
    const importMode = document.querySelector('input[name="importMode"]:checked')?.value || 'move';
    if (importMode === 'move') {
        const confirmed = await showMoveConfirmation(state.selectedFiles.length);
        if (!confirmed) return;
    }

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
    btn.textContent = ' Importing...';
    progress.style.display = 'block';
    progressFill.style.width = '0%';
    const progressText = document.getElementById('importProgressText');
    if (progressText) progressText.textContent = `0 / ${state.selectedFiles.length}`;
    resultDiv.style.display = 'none';

    try {
        // Import mode already determined above (for the confirmation gate)
        const keepOriginals = importMode === 'copy';
        const registerInPlace = importMode === 'register';

        // Derivative options
        const generateDerivatives = document.getElementById('generateDerivatives')?.checked || false;
        const derivativeFormats = [];
        if (generateDerivatives) {
            document.querySelectorAll('.derivFormat:checked').forEach(cb => derivativeFormats.push(cb.value));
        }
        const derivativeFps = parseInt(document.getElementById('derivativeFps')?.value) || 24;

        const body = {
            files: state.selectedFiles.map(f => f.path),
            project_id: parseInt(projectId),
            sequence_id: seqId ? parseInt(seqId) : undefined,
            shot_id: shotId ? parseInt(shotId) : undefined,
            role_id: roleId ? parseInt(roleId) : undefined,
            take_number: parseInt(take),
            custom_name: customName,
            keep_originals: keepOriginals,
            keep_original_names: !!document.getElementById('keepOriginalNames')?.checked,
            register_in_place: registerInPlace,
            generate_derivatives: generateDerivatives,
            derivative_formats: derivativeFormats,
            derivative_fps: derivativeFps,
        };

        // Use SSE streaming for progress on imports with 2+ files
        const useStream = state.selectedFiles.length >= 2;
        let result;

        if (useStream) {
            result = await importWithProgress(body, progressFill, progressText);
        } else {
            const r = await api('/api/assets/import', { method: 'POST', body });
            progressFill.style.width = '100%';
            if (progressText) progressText.textContent = '';
            result = r;
        }

        resultDiv.style.display = 'block';
        let resultHtml = '';
        if (result.imported > 0) {
            resultDiv.className = 'import-result success';
            resultHtml = ` Imported ${result.imported} asset(s) successfully!`;
            if (result.sequences_detected > 0) {
                resultHtml += `<br> ${result.sequences_detected} frame sequence(s) detected`;
            }
            if (result.errors > 0) {
                resultHtml += `<br> ${result.errors} error(s)`;
            }
            if (result.derivative_jobs?.length > 0) {
                resultHtml += `<br> ${result.derivative_jobs.length} derivative job(s) queued`;
                startDerivativePolling(result.derivative_jobs);
            }
        } else {
            resultDiv.className = 'import-result error';
            resultHtml = ` No files imported. ` +
                (result.errors_detail?.map(e => e.error).join(', ') || '');
        }
        resultDiv.innerHTML = resultHtml;

        // Clear selection
        state.selectedFiles = [];
        updateSelectedList();
        updateRenamePreview();

        // Refresh counts
        window.checkSetup();
    } catch (err) {
        resultDiv.style.display = 'block';
        resultDiv.className = 'import-result error';
        resultDiv.innerHTML = ` Import failed: ${err.message}`;
    }

    btn.disabled = false;
    btn.textContent = document.getElementById('keepOriginalNames')?.checked ? ' Import' : ' Import & Rename';
    setTimeout(() => { progress.style.display = 'none'; }, 2000);
}

// ===========================================
//  DERIVATIVE PROGRESS POLLING
// ===========================================

let derivativePoller = null;

function startDerivativePolling(jobIds) {
    const statusDiv = document.getElementById('derivativeStatus');
    if (!statusDiv) return;
    statusDiv.style.display = 'block';
    statusDiv.textContent = ` Processing ${jobIds.length} derivative(s)...`;

    let completedCount = 0;

    derivativePoller = setInterval(async () => {
        try {
            const jobs = await api('/api/transcode/jobs');
            const relevant = jobs.filter(j => jobIds.includes(j.id));
            const done = relevant.filter(j => j.status === 'completed' || j.status === 'failed');
            const active = relevant.find(j => j.status === 'running');

            completedCount = done.length;
            let msg = ` Derivatives: ${completedCount}/${jobIds.length} complete`;
            if (active) {
                msg += ` - ${active.formatKey} ${Math.round(active.progress || 0)}%`;
            }

            const errCount = done.filter(j => j.status === 'failed').length;
            if (errCount > 0) msg += ` (${errCount} failed)`;

            statusDiv.textContent = msg;

            if (completedCount >= jobIds.length) {
                clearInterval(derivativePoller);
                derivativePoller = null;
                statusDiv.textContent = errCount > 0
                    ? ` Derivatives: ${completedCount - errCount} done, ${errCount} failed`
                    : ` All ${completedCount} derivative(s) complete!`;
                setTimeout(() => { statusDiv.style.display = 'none'; }, 8000);
                // Refresh browser if user switches to it
                window.checkSetup?.();
            }
        } catch {
            // Ignore polling errors silently
        }
    }, 2000);
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

// ===========================================
//  INIT - Event listeners for rename preview
// ===========================================

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('importCustomName')?.addEventListener('input', updateRenamePreview);
    document.getElementById('importTake')?.addEventListener('input', updateRenamePreview);

    // Keep original filenames toggle
    document.getElementById('keepOriginalNames')?.addEventListener('change', () => {
        const btn = document.getElementById('importBtn');
        const keepOrig = document.getElementById('keepOriginalNames').checked;
        btn.textContent = keepOrig ? ' Import' : ' Import & Rename';
        updateRenamePreview();
    });

    // Derivative checkbox toggle
    const derivCb = document.getElementById('generateDerivatives');
    const derivOpts = document.getElementById('derivativeOptions');
    if (derivCb && derivOpts) {
        derivCb.addEventListener('change', () => {
            derivOpts.style.display = derivCb.checked ? 'block' : 'none';
        });
    }

    // Import mode: show register warning
    document.querySelectorAll('input[name="importMode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const warn = document.getElementById('registerWarning');
            if (warn) warn.style.display = radio.value === 'register' && radio.checked ? 'block' : 'none';
        });
    });
});

// ===========================================
//  MOVE-MODE CONFIRMATION DIALOG
// ===========================================

function showMoveConfirmation(fileCount) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'move-confirm-overlay';
        overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };

        const plural = fileCount === 1 ? 'file' : 'files';

        overlay.innerHTML = `
            <div class="move-confirm-card">
                <h3> Move & Rename - Are you sure?</h3>
                <p>You're about to <strong>move ${fileCount} ${plural}</strong> into the vault folder structure. This will:</p>
                <div class="warn-highlight">
                    <strong>* Rename files</strong> using the ShotGrid naming convention<br>
                    <strong>* Move files</strong> from their current location into the vault<br>
                    <strong>* Delete the originals</strong> - the source files will be removed
                </div>
                <p>Original file names and locations <strong>cannot be recovered</strong> after this operation.</p>
                <div class="alt-tip">
                    <strong> Alternatives:</strong><br>
                    <em>Copy into vault</em> - does the same renaming but keeps your originals untouched.<br>
                    <em>Register in place</em> - files stay exactly where they are, nothing is moved or renamed.
                </div>
                <div class="move-confirm-actions">
                    <button class="btn-cancel" id="moveConfirmCancel">Cancel</button>
                    <button class="btn-confirm-move" id="moveConfirmOk">Yes, Move & Rename</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector('#moveConfirmCancel').onclick = () => { overlay.remove(); resolve(false); };
        overlay.querySelector('#moveConfirmOk').onclick = () => { overlay.remove(); resolve(true); };

        // Escape key cancels
        const escHandler = (e) => {
            if (e.key === 'Escape') { overlay.remove(); resolve(false); document.removeEventListener('keydown', escHandler); }
        };
        document.addEventListener('keydown', escHandler);
    });
}

// ===========================================
//  INLINE CREATE - Sequence & Shot from Import
// ===========================================

function showInlineNewSequence() {
    const form = document.getElementById('inlineNewSequence');
    // Always show (don't toggle - Cancel button hides)
    form.style.display = 'flex';
    // Auto-suggest code based on current sequence count
    const seqSel = document.getElementById('importSequence');
    const count = Math.max(seqSel.options.length - 1, 0); // minus the "-- None --" option
    const nextNum = (count + 1) * 10;
    document.getElementById('newSeqCode').value = `SQ${String(nextNum).padStart(3, '0')}`;
    document.getElementById('newSeqCode').dataset.defaultCode = `SQ${String(nextNum).padStart(3, '0')}`;
    document.getElementById('newSeqCode').dataset.manual = 'false';
    document.getElementById('newSeqName').value = '';
    document.getElementById('newSeqName').focus();
}

function hideInlineNewSequence() {
    document.getElementById('inlineNewSequence').style.display = 'none';
}

// Auto-generate code from name as user types
function setupInlineAutoCode(nameId, codeId, prefix) {
    const nameEl = document.getElementById(nameId);
    const codeEl = document.getElementById(codeId);
    if (!nameEl || !codeEl) return;

    nameEl.addEventListener('input', () => {
        // Only auto-fill if user hasn't manually edited the code
        if (codeEl.dataset.manual === 'true') return;
        const raw = nameEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if (raw) {
            codeEl.value = raw;
        } else {
            // Revert to default SQ/SH code
            codeEl.value = codeEl.dataset.defaultCode || '';
        }
    });

    codeEl.addEventListener('input', () => {
        codeEl.dataset.manual = 'true';
        codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    });

    // Reset manual flag when form re-opens
    codeEl.dataset.manual = 'false';
}

async function createInlineSequence() {
    const projectId = document.getElementById('importProject').value;
    if (!projectId) return showToast('Select a project first', 'error');

    const name = document.getElementById('newSeqName').value.trim();
    const code = document.getElementById('newSeqCode').value.trim().toUpperCase();

    if (!name) return showToast('Sequence name is required', 'error');
    if (!code) return showToast('Sequence code is required', 'error');

    try {
        const newSeq = await api(`/api/projects/${projectId}/sequences`, {
            method: 'POST',
            body: { name, code }
        });

        showToast(` Sequence "${name}" (${code}) created!`, 'success');
        hideInlineNewSequence();

        // Refresh the sequence dropdown and auto-select the new one
        const project = await api(`/api/projects/${projectId}`);
        const seqSel = document.getElementById('importSequence');
        seqSel.innerHTML = '<option value="">-- None --</option>' +
            project.sequences.map(s =>
                `<option value="${s.id}" ${s.id === newSeq.id ? 'selected' : ''}>${s.name} (${s.code})</option>`
            ).join('');

        // Enable the Shot + button now
        document.getElementById('btnNewShot').disabled = false;

        // Trigger shot dropdown load for the new sequence
        onImportSequenceChange();
        updateRenamePreview();
    } catch (err) {
        showToast(' ' + (err.message || 'Failed to create sequence'), 'error');
    }
}

function showInlineNewShot() {
    const seqId = document.getElementById('importSequence').value;
    if (!seqId) return showToast('Select a sequence first', 'error');

    const form = document.getElementById('inlineNewShot');
    // Always show (don't toggle - Cancel button hides)
    form.style.display = 'flex';
    const shotSel = document.getElementById('importShot');
    const count = Math.max(shotSel.options.length - 1, 0);
    const nextNum = (count + 1) * 10;
    document.getElementById('newShotCode').value = `SH${String(nextNum).padStart(3, '0')}`;
    document.getElementById('newShotCode').dataset.defaultCode = `SH${String(nextNum).padStart(3, '0')}`;
    document.getElementById('newShotCode').dataset.manual = 'false';
    document.getElementById('newShotName').value = '';
    document.getElementById('newShotName').focus();
}

function hideInlineNewShot() {
    document.getElementById('inlineNewShot').style.display = 'none';
}

async function createInlineShot() {
    const projectId = document.getElementById('importProject').value;
    const seqId = document.getElementById('importSequence').value;
    if (!projectId || !seqId) return showToast('Select project and sequence first', 'error');

    const name = document.getElementById('newShotName').value.trim();
    const code = document.getElementById('newShotCode').value.trim().toUpperCase();

    if (!name) return showToast('Shot name is required', 'error');
    if (!code) return showToast('Shot code is required', 'error');

    try {
        const newShot = await api(`/api/projects/${projectId}/sequences/${seqId}/shots`, {
            method: 'POST',
            body: { name, code }
        });

        showToast(` Shot "${name}" (${code}) created!`, 'success');
        hideInlineNewShot();

        // Refresh the shot dropdown and auto-select the new one
        const shots = await api(`/api/projects/${projectId}/sequences/${seqId}/shots`);
        const shotSel = document.getElementById('importShot');
        shotSel.innerHTML = '<option value="">-- None --</option>' +
            shots.map(s =>
                `<option value="${s.id}" ${s.id === newShot.id ? 'selected' : ''}>${s.name} (${s.code})</option>`
            ).join('');

        updateRenamePreview();
    } catch (err) {
        showToast(' ' + (err.message || 'Failed to create shot'), 'error');
    }
}

// ===========================================
//  QUICK ACCESS (Saved Locations)
// ===========================================

let quickAccessItems = [];

async function loadQuickAccess() {
    try {
        const settings = await api('/api/settings');
        const raw = settings.quick_access;
        quickAccessItems = raw ? JSON.parse(raw) : [];
    } catch { quickAccessItems = []; }
    renderQuickAccess();
    initQuickAccessDropZone();
}

async function saveQuickAccess() {
    try {
        await api('/api/settings', {
            method: 'POST',
            body: { quick_access: JSON.stringify(quickAccessItems) }
        });
    } catch (e) { console.error('Failed to save Quick Access:', e); }
}

function renderQuickAccess() {
    const list = document.getElementById('quickAccessList');
    if (!list) return;

    if (quickAccessItems.length === 0) {
        list.innerHTML = '<div class="qa-empty">Drag a folder here<br>or right-click -> Add</div>';
        return;
    }

    list.innerHTML = quickAccessItems.map((item, i) => `
        <div class="qa-item" onclick="browseTo('${escAttr(item.path)}')" title="${esc(item.path)}">
            <span class="qa-icon">${item.icon || ''}</span>
            <span class="qa-label">${esc(item.label)}</span>
            <span class="qa-remove" onclick="event.stopPropagation(); removeQuickAccess(${i})" title="Remove">x</span>
        </div>
    `).join('');
}

function addQuickAccess(path, name) {
    // Don't add duplicates
    if (quickAccessItems.some(q => q.path === path)) {
        showToast('Already in Quick Access', 'info');
        return;
    }
    // Determine icon based on path pattern
    let icon = '';
    const lp = path.toLowerCase();
    if (lp.startsWith('\\\\') || lp.startsWith('//') || lp.includes('smb') || lp.includes('nfs')) icon = '';
    else if (/^[a-z]:\\/i.test(lp)) icon = '';
    else if (lp.startsWith('/volumes/') || lp.startsWith('/mnt/') || lp.startsWith('/media/')) icon = '';

    quickAccessItems.push({ path, label: name, icon });
    saveQuickAccess();
    renderQuickAccess();
    showToast(` "${name}" added to Quick Access`, 'success');
}

function removeQuickAccess(index) {
    const removed = quickAccessItems.splice(index, 1);
    saveQuickAccess();
    renderQuickAccess();
    if (removed.length) showToast(`Removed "${removed[0].label}"`, 'info');
}

function addCurrentFolderToQuickAccess() {
    const currentPath = state.importBrowsePath;
    if (!currentPath) { showToast('Navigate to a folder first', 'error'); return; }
    const name = currentPath.split(/[\\/]/).filter(Boolean).pop() || currentPath;
    addQuickAccess(currentPath, name);
}

// --- Drag & Drop onto Quick Access panel ---

function onFolderDragStart(event, path, name) {
    event.dataTransfer.setData('text/plain', JSON.stringify({ path, name }));
    event.dataTransfer.effectAllowed = 'copy';
    // Show the drop zone
    const dz = document.getElementById('qaDropZone');
    if (dz) dz.classList.add('active');
}

function initQuickAccessDropZone() {
    const panel = document.getElementById('quickAccessPanel');
    const dropZone = document.getElementById('qaDropZone');
    if (!panel || !dropZone) return;

    // Hide drop zone when drag ends anywhere
    document.addEventListener('dragend', () => {
        dropZone.classList.remove('active');
    });

    panel.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropZone.classList.add('active');
    });

    panel.addEventListener('dragleave', (e) => {
        // Only hide if leaving the panel entirely
        if (!panel.contains(e.relatedTarget)) {
            dropZone.classList.remove('active');
        }
    });

    panel.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('active');
        try {
            const data = JSON.parse(e.dataTransfer.getData('text/plain'));
            if (data.path) addQuickAccess(data.path, data.name || 'Folder');
        } catch { /* ignore non-folder drops */ }
    });
}

// --- Right-click context menu on folders ---

let _qaContextMenu = null;

function onFolderContextMenu(event, path, name) {
    event.preventDefault();
    event.stopPropagation();

    // Remove any existing menu
    if (_qaContextMenu) { _qaContextMenu.remove(); _qaContextMenu = null; }

    const menu = document.createElement('div');
    menu.className = 'qa-context-menu';
    menu.style.cssText = `
        position: fixed; left: ${event.clientX}px; top: ${event.clientY}px;
        z-index: 9999; background: #2a2a30; border: 1px solid #444;
        border-radius: 6px; padding: 4px 0; min-width: 180px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5); font-size: 0.82rem;
    `;

    const addItem = document.createElement('div');
    addItem.textContent = ' Add to Quick Access';
    addItem.style.cssText = 'padding: 8px 14px; cursor: pointer; color: #ddd; transition: background .15s;';
    addItem.onmouseenter = () => addItem.style.background = '#383840';
    addItem.onmouseleave = () => addItem.style.background = '';
    addItem.onclick = () => { addQuickAccess(path, name); menu.remove(); _qaContextMenu = null; };
    menu.appendChild(addItem);

    const openItem = document.createElement('div');
    openItem.textContent = ' Open Folder';
    openItem.style.cssText = 'padding: 8px 14px; cursor: pointer; color: #ddd; transition: background .15s;';
    openItem.onmouseenter = () => openItem.style.background = '#383840';
    openItem.onmouseleave = () => openItem.style.background = '';
    openItem.onclick = () => { browseTo(path); menu.remove(); _qaContextMenu = null; };
    menu.appendChild(openItem);

    document.body.appendChild(menu);
    _qaContextMenu = menu;

    // Close on click elsewhere
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            _qaContextMenu = null;
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ===========================================
//  INBOX (Watch Folder Ingest)
// ===========================================

let inboxWatches = [];
let activeInboxId = null;
let inboxFiles = [];

/**
 * Load inbox watch folders and render in Quick Access sidebar
 */
async function loadInboxes() {
    try {
        inboxWatches = await api('/api/settings/watches/inbox');
    } catch { inboxWatches = []; }
    renderInboxes();
}

function renderInboxes() {
    const section = document.getElementById('inboxSection');
    const list = document.getElementById('inboxList');
    if (!section || !list) return;

    if (inboxWatches.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = inboxWatches.map(w => {
        const folderName = w.path.split(/[\\/]/).filter(Boolean).pop() || w.path;
        const isActive = activeInboxId === w.id;
        const badgeClass = w.file_count > 0 ? 'inbox-badge active' : 'inbox-badge';
        return `
        <div class="inbox-item ${isActive ? 'selected' : ''}" onclick="openInbox(${w.id})" title="${esc(w.path)}">
            <span class="inbox-icon"></span>
            <span class="inbox-label">${esc(folderName)}</span>
            ${w.project_name ? `<span class="inbox-project">${esc(w.project_name)}</span>` : ''}
            <span class="${badgeClass}">${w.file_count}</span>
        </div>`;
    }).join('');
}

/**
 * Open an inbox - load its files into the center panel
 */
async function openInbox(watchId) {
    activeInboxId = watchId;
    renderInboxes(); // highlight active

    const watch = inboxWatches.find(w => w.id === watchId);
    if (!watch) return;

    // Clear normal file selection
    state.selectedFiles = [];

    try {
        const result = await api(`/api/settings/watches/${watchId}/files`);
        inboxFiles = result.files || [];
    } catch (err) {
        inboxFiles = [];
        showToast('Failed to load inbox: ' + err.message, 'error');
    }

    renderInboxFileList(watch);

    // Pre-fill project dropdown if watch folder has a project
    if (watch.project_id) {
        const projSel = document.getElementById('importProject');
        if (projSel) {
            projSel.value = String(watch.project_id);
            await onImportProjectChange();
        }
    }

    // Update the import button to say Ingest
    updateIngestButton();
}

function renderInboxFileList(watch) {
    const browser = document.getElementById('fileBrowser');
    const folderName = watch.path.split(/[\\/]/).filter(Boolean).pop() || watch.path;

    if (inboxFiles.length === 0) {
        browser.innerHTML = `
            <div style="padding:20px;text-align:center;color:var(--text-muted);">
                <div style="font-size:2rem;margin-bottom:8px;"></div>
                <div>No media files in this inbox</div>
                <div style="font-size:0.8rem;margin-top:4px;">${esc(watch.path)}</div>
            </div>`;
        // Hide select bar
        const selBar = document.getElementById('fileBrowserSelectBar');
        if (selBar) selBar.style.display = 'none';
        return;
    }

    // Select all files by default
    state.selectedFiles = inboxFiles.map(f => ({
        path: f.path, name: f.name, size: f.size,
        mediaType: f.mediaType || '', icon: f.icon || ''
    }));

    let html = `<div class="inbox-header-bar">
        <span> <strong>${esc(folderName)}</strong> - ${inboxFiles.length} file${inboxFiles.length !== 1 ? 's' : ''}</span>
        <button class="btn-small" onclick="refreshInbox()" title="Refresh" style="font-size:0.75rem;padding:3px 8px;cursor:pointer;"> Refresh</button>
    </div>`;

    for (const f of inboxFiles) {
        const isSelected = state.selectedFiles.some(s => s.path === f.path);
        html += `<div class="fb-entry ${isSelected ? 'selected' : ''}" onclick="toggleInboxFile('${escAttr(f.path)}')">
            <span class="fb-icon">${f.icon || ''}</span>
            <span class="fb-name">${esc(f.name)}</span>
            <span class="fb-size">${formatSize(f.size)}</span>
        </div>`;
    }

    browser.innerHTML = html;

    // Show select bar
    const selBar = document.getElementById('fileBrowserSelectBar');
    if (selBar) selBar.style.display = 'flex';

    // Update path bar to show inbox path
    document.getElementById('importPath').value = watch.path;

    updateSelectedList();
}

function toggleInboxFile(filePath) {
    const idx = state.selectedFiles.findIndex(f => f.path === filePath);
    if (idx >= 0) {
        state.selectedFiles.splice(idx, 1);
    } else {
        const file = inboxFiles.find(f => f.path === filePath);
        if (file) {
            state.selectedFiles.push({
                path: file.path, name: file.name, size: file.size,
                mediaType: file.mediaType || '', icon: file.icon || ''
            });
        }
    }
    // Re-render checkmarks
    const entries = document.querySelectorAll('#fileBrowser .fb-entry[onclick]');
    entries.forEach(el => {
        const onclick = el.getAttribute('onclick');
        if (!onclick) return;
        const match = onclick.match(/toggleInboxFile\('(.+?)'\)/);
        if (match) {
            const p = match[1].replace(/\\'/g, "'");
            el.classList.toggle('selected', state.selectedFiles.some(f => f.path === p));
        }
    });
    updateSelectedList();
    updateIngestButton();
}

function updateIngestButton() {
    const btn = document.getElementById('importBtn');
    if (!btn) return;

    if (activeInboxId) {
        btn.textContent = ' Ingest Selected';
        btn.onclick = executeIngest;
        btn.disabled = state.selectedFiles.length === 0 || !document.getElementById('importProject').value;
    } else {
        const keepOrig = document.getElementById('keepOriginalNames')?.checked;
        btn.textContent = keepOrig ? ' Import' : ' Import & Rename';
        btn.onclick = executeImport;
    }
}

async function refreshInbox() {
    if (activeInboxId) {
        await openInbox(activeInboxId);
        showToast('Inbox refreshed', 'info');
    }
}

/**
 * Ingest: import selected files via the standard import endpoint (copy mode),
 * then move originals to _ingested/ subfolder.
 */
async function executeIngest() {
    const projectId = document.getElementById('importProject').value;
    if (!projectId || !state.selectedFiles.length || !activeInboxId) return;

    // Respect the import mode radio (Copy keeps originals, Move cleans up)
    const importMode = document.querySelector('input[name="importMode"]:checked')?.value || 'copy';
    const keepOriginals = importMode === 'copy';
    const registerInPlace = importMode === 'register';

    // Move-mode confirmation gate
    if (importMode === 'move') {
        const confirmed = await showMoveConfirmation(state.selectedFiles.length);
        if (!confirmed) return;
    }

    const seqId = document.getElementById('importSequence')?.value || undefined;
    const shotId = document.getElementById('importShot')?.value || undefined;
    const roleId = document.getElementById('importRole')?.value || undefined;
    const take = document.getElementById('importTake')?.value || 1;

    const btn = document.getElementById('importBtn');
    const progress = document.getElementById('importProgress');
    const progressFill = document.getElementById('importProgressFill');
    const progressText = document.getElementById('importProgressText');
    const resultDiv = document.getElementById('importResult');

    btn.disabled = true;
    btn.textContent = ' Ingesting...';
    progress.style.display = 'block';
    progressFill.style.width = '0%';
    if (progressText) progressText.textContent = `0 / ${state.selectedFiles.length}`;
    resultDiv.style.display = 'none';

    const filePaths = state.selectedFiles.map(f => f.path);

    try {
        const body = {
            files: filePaths,
            project_id: parseInt(projectId),
            sequence_id: seqId ? parseInt(seqId) : undefined,
            shot_id: shotId ? parseInt(shotId) : undefined,
            role_id: roleId ? parseInt(roleId) : undefined,
            take_number: parseInt(take),
            keep_originals: keepOriginals,
            register_in_place: registerInPlace,
        };

        // Use SSE for 2+ files
        const useStream = filePaths.length >= 2;
        let result;

        if (useStream) {
            result = await importWithProgress(body, progressFill, progressText);
        } else {
            result = await api('/api/assets/import', { method: 'POST', body });
            progressFill.style.width = '100%';
            if (progressText) progressText.textContent = '';
        }

        // Only clean up (move to _ingested/) when NOT in copy mode
        // Copy mode: originals stay exactly where they are
        // Move/Register mode: move originals to _ingested/ so they leave the inbox
        if (result.imported > 0 && !keepOriginals && !registerInPlace) {
            try {
                await api(`/api/settings/watches/${activeInboxId}/cleanup`, {
                    method: 'POST',
                    body: { files: filePaths },
                });
            } catch (cleanupErr) {
                console.warn('Cleanup failed:', cleanupErr);
            }
        }

        const modeLabel = keepOriginals ? 'copied' : registerInPlace ? 'registered' : 'moved';
        resultDiv.style.display = 'block';
        if (result.imported > 0) {
            resultDiv.className = 'import-result success';
            resultDiv.innerHTML = ` Ingested ${result.imported} file(s) - ${modeLabel} to vault.` +
                (result.errors > 0 ? `<br> ${result.errors} error(s)` : '') +
                (keepOriginals ? '<br> Originals kept in place.' : '');
        } else {
            resultDiv.className = 'import-result error';
            resultDiv.innerHTML = ` No files ingested. ` +
                (result.errors_detail?.map(e => e.error).join(', ') || '');
        }

        // Refresh inbox to show updated file list
        state.selectedFiles = [];
        updateSelectedList();
        await openInbox(activeInboxId);

        // Refresh global counts
        if (window.checkSetup) window.checkSetup();

    } catch (err) {
        resultDiv.style.display = 'block';
        resultDiv.className = 'import-result error';
        resultDiv.innerHTML = ` Ingest failed: ${err.message}`;
    }

    btn.disabled = false;
    btn.textContent = ' Ingest Selected';
    setTimeout(() => { progress.style.display = 'none'; }, 2000);
}

/**
 * Exit inbox mode and return to normal file browser
 */
function exitInbox() {
    activeInboxId = null;
    inboxFiles = [];
    renderInboxes();

    const btn = document.getElementById('importBtn');
    if (btn) {
        const keepOrig = document.getElementById('keepOriginalNames')?.checked;
        btn.textContent = keepOrig ? ' Import' : ' Import & Rename';
        btn.onclick = executeImport;
    }

    state.selectedFiles = [];
    updateSelectedList();

    // Return to file browser
    if (state.importBrowsePath) {
        browseTo(state.importBrowsePath);
    } else {
        browseTo('');
    }
}

// ===========================================
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ===========================================

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
window.showInlineNewSequence = showInlineNewSequence;
window.hideInlineNewSequence = hideInlineNewSequence;
window.createInlineSequence = createInlineSequence;
window.showInlineNewShot = showInlineNewShot;
window.hideInlineNewShot = hideInlineNewShot;
window.createInlineShot = createInlineShot;
window.onFolderDragStart = onFolderDragStart;
window.onFolderContextMenu = onFolderContextMenu;
window.removeQuickAccess = removeQuickAccess;
window.addCurrentFolderToQuickAccess = addCurrentFolderToQuickAccess;
window.openInbox = openInbox;
window.toggleInboxFile = toggleInboxFile;
window.refreshInbox = refreshInbox;
window.executeIngest = executeIngest;
window.exitInbox = exitInbox;




