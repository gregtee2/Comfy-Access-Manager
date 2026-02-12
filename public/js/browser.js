/**
 * DMV — Browser Module
 * Projects, tree navigation, asset grid, selection, drag-drop, sequences/shots CRUD.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, escAttr, formatSize, formatDuration, formatDate, formatDateTime, typeIcon, showToast, closeModal } from './utils.js';
import { openPlayer } from './player.js';

// ═══════════════════════════════════════════
//  PROJECTS
// ═══════════════════════════════════════════

export async function loadProjects() {
    try {
        state.projects = await api('/api/projects');
        renderProjectGrid();
    } catch (err) {
        console.error('Failed to load projects:', err);
    }
}

function renderProjectGrid() {
    const grid = document.getElementById('projectGrid');

    if (state.projects.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-icon">📁</div>
                <p>No projects yet. Create your first project to start organizing media.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = state.projects.map(p => `
        <div class="project-card fade-in" onclick="openProject(${p.id})">
            <div class="card-icon">${p.type === 'shot_based' ? '🎬' : '📁'}</div>
            <h3>${esc(p.name)}</h3>
            <span class="card-type badge badge-dim">${p.code}</span>
            <div class="card-meta">
                <span>📎 ${p.asset_count || 0} assets</span>
                <span>📋 ${p.sequence_count || 0} sequences</span>
            </div>
        </div>
    `).join('');
}

function showCreateProjectModal() {
    const modal = document.getElementById('modal');
    document.getElementById('modalContent').innerHTML = `
        <h3>Create New Project</h3>
        <label>Project Name</label>
        <input type="text" id="newProjectName" placeholder="My Awesome Project" autofocus>
        
        <label>Project Code (short, uppercase)</label>
        <input type="text" id="newProjectCode" placeholder="AWESOME" 
            oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9_]/g,'')" maxlength="12">
        
        <label>Type</label>
        <select id="newProjectType">
            <option value="flexible">Flexible (simple folders + optional shots)</option>
            <option value="shot_based">Shot-Based (sequences → shots → takes)</option>
            <option value="simple">Simple (just organize by media type)</option>
        </select>
        
        <label>Description (optional)</label>
        <textarea id="newProjectDesc" rows="2" placeholder="What is this project about?"></textarea>
        
        <div class="form-actions">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="createProject()">Create Project</button>
        </div>
    `;
    modal.style.display = 'flex';

    // Auto-generate code from name
    document.getElementById('newProjectName').addEventListener('input', (e) => {
        const code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        document.getElementById('newProjectCode').value = code;
    });
}

async function createProject() {
    const name = document.getElementById('newProjectName').value.trim();
    const code = document.getElementById('newProjectCode').value.trim();
    const type = document.getElementById('newProjectType').value;
    const description = document.getElementById('newProjectDesc').value.trim();

    if (!name || !code) return alert('Name and code are required.');

    try {
        await api('/api/projects', { method: 'POST', body: { name, code, type, description } });
        closeModal();
        loadProjects();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  TREE NAVIGATION
// ═══════════════════════════════════════════
let treeData = [];
let treeExpanded = {};  // { 'p_1': true, 'seq_3': true } — tracks open/closed nodes

export async function loadTree() {
    try {
        treeData = await api('/api/projects/tree');
        renderTree();
    } catch (err) {
        console.error('Failed to load tree:', err);
        document.getElementById('treeContainer').innerHTML =
            '<div style="color:var(--text-muted);padding:8px;font-size:0.8rem;">Failed to load tree</div>';
    }
}

function refreshTree() { loadTree(); }

function renderTree() {
    const container = document.getElementById('treeContainer');
    if (!container) return;

    if (treeData.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);padding:12px;font-size:0.8rem;">No projects yet</div>';
        return;
    }

    let html = '';
    for (const project of treeData) {
        const pKey = `p_${project.id}`;
        const isOpen = treeExpanded[pKey];
        const isActive = state.currentProject?.id === project.id && !state.currentSequence && !state.currentShot;
        const hasChildren = project.sequences.length > 0;
        const icon = project.type === 'shot_based' ? '🎬' : '📁';

        html += `<div class="tree-node ${isActive ? 'tree-active' : ''}" onclick="treeSelectProject(${project.id})"
            oncontextmenu="treeSelectProject(${project.id});showProjectContextMenu(event)">
            <span class="tree-toggle" onclick="event.stopPropagation();treeToggle('${pKey}')">${hasChildren ? (isOpen ? '▼' : '▶') : '  '}</span>
            <span class="tree-icon">${icon}</span>
            <span class="tree-label">${esc(project.name)}</span>
            <span class="tree-count">${project.asset_count}</span>
        </div>`;

        if (isOpen && hasChildren) {
            for (const seq of project.sequences) {
                const sKey = `seq_${seq.id}`;
                const sOpen = treeExpanded[sKey];
                const sActive = state.currentSequence?.id === seq.id && !state.currentShot;
                const sHasChildren = seq.shots.length > 0;

                html += `<div class="tree-node tree-indent-1 ${sActive ? 'tree-active' : ''}" onclick="treeSelectSequence(${project.id}, ${seq.id})"
                    oncontextmenu="showSeqContextMenu(event, ${seq.id}, '${esc(seq.name).replace(/'/g, "\\'")}')"
                    ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                    ondrop="onSeqDrop(event, ${seq.id}, ${project.id})">
                    <span class="tree-toggle" onclick="event.stopPropagation();treeToggle('${sKey}')">${sHasChildren ? (sOpen ? '▼' : '▶') : '  '}</span>
                    <span class="tree-icon">📋</span>
                    <span class="tree-label">${esc(seq.name)}</span>
                    <span class="tree-count">${seq.asset_count}</span>
                </div>`;

                if (sOpen && sHasChildren) {
                    for (const shot of seq.shots) {
                        const shKey = `sh_${shot.id}`;
                        const shOpen = treeExpanded[shKey];
                        const shActive = state.currentShot?.id === shot.id && !state.currentRole;
                        const shHasRoles = shot.roles && shot.roles.length > 0;
                        html += `<div class="tree-node tree-indent-2 ${shActive ? 'tree-active' : ''}" onclick="treeSelectShot(${project.id}, ${seq.id}, ${shot.id})"
                            oncontextmenu="showShotContextMenu(event, ${seq.id}, ${shot.id}, '${esc(shot.name).replace(/'/g, "\\'")}')"
                            ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                            ondrop="event.stopPropagation();onShotDrop(event, ${seq.id}, ${shot.id})">
                            <span class="tree-toggle" onclick="event.stopPropagation();treeToggle('${shKey}')">${shHasRoles ? (shOpen ? '▼' : '▶') : '  '}</span>
                            <span class="tree-icon">🎬</span>
                            <span class="tree-label">${esc(shot.name)}</span>
                            <span class="tree-count">${shot.asset_count}</span>
                        </div>`;

                        if (shOpen && shHasRoles) {
                            for (const role of shot.roles) {
                                const rActive = state.currentRole?.id === role.role_id && state.currentShot?.id === shot.id;
                                html += `<div class="tree-node tree-indent-3 ${rActive ? 'tree-active' : ''}" onclick="treeSelectRole(${project.id}, ${seq.id}, ${shot.id}, ${role.role_id})">
                                    <span class="tree-toggle">  </span>
                                    <span class="tree-icon">${role.role_icon || '🎭'}</span>
                                    <span class="tree-label" style="color:${role.role_color || 'inherit'}">${esc(role.role_name)}</span>
                                    <span class="tree-count">${role.asset_count}</span>
                                </div>`;
                            }
                        }
                    }
                }
            }
        }
    }

    container.innerHTML = html;
}

function treeToggle(key) {
    treeExpanded[key] = !treeExpanded[key];
    renderTree();
}

async function treeSelectProject(projectId) {
    treeExpanded[`p_${projectId}`] = true;

    try {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
        state.currentSequence = null;
        state.currentShot = null;
        state.currentRole = null;
        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        renderProjectDetail(project);
        loadProjectAssets(project.id);
        renderTree();
    } catch (err) {
        console.error('Failed to select project:', err);
    }
}

async function treeSelectSequence(projectId, seqId) {
    if (!state.currentProject || state.currentProject.id !== projectId) {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
    }

    const seq = state.currentProject.sequences?.find(s => s.id === seqId);
    state.currentSequence = seq || { id: seqId };
    state.currentShot = null;
    state.currentRole = null;
    state.selectedAssets = [];

    treeExpanded[`p_${projectId}`] = true;
    treeExpanded[`seq_${seqId}`] = true;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
    renderTree();
}

async function treeSelectShot(projectId, seqId, shotId) {
    if (!state.currentProject || state.currentProject.id !== projectId) {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
    }

    const seq = state.currentProject.sequences?.find(s => s.id === seqId);
    state.currentSequence = seq || { id: seqId };

    try {
        const shots = await api(`/api/projects/${projectId}/sequences/${seqId}/shots`);
        state.currentShot = shots.find(sh => sh.id === shotId) || { id: shotId };
    } catch {
        state.currentShot = { id: shotId };
    }

    state.currentRole = null;
    state.selectedAssets = [];

    treeExpanded[`p_${projectId}`] = true;
    treeExpanded[`seq_${seqId}`] = true;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
    renderTree();
}

async function treeSelectRole(projectId, seqId, shotId, roleId) {
    if (!state.currentProject || state.currentProject.id !== projectId) {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
    }

    const seq = state.currentProject.sequences?.find(s => s.id === seqId);
    state.currentSequence = seq || { id: seqId };

    try {
        const shots = await api(`/api/projects/${projectId}/sequences/${seqId}/shots`);
        state.currentShot = shots.find(sh => sh.id === shotId) || { id: shotId };
    } catch {
        state.currentShot = { id: shotId };
    }

    // Fetch roles to get the full role object
    try {
        const roles = await api('/api/roles');
        state.currentRole = roles.find(r => r.id === roleId) || { id: roleId };
    } catch {
        state.currentRole = { id: roleId };
    }

    state.selectedAssets = [];

    treeExpanded[`p_${projectId}`] = true;
    treeExpanded[`seq_${seqId}`] = true;
    treeExpanded[`sh_${shotId}`] = true;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
    renderTree();
}

// ═══════════════════════════════════════════
//  PROJECT DETAIL / BROWSER
// ═══════════════════════════════════════════

async function openProject(id) {
    try {
        const project = await api(`/api/projects/${id}`);
        state.currentProject = project;
        state.currentSequence = null;
        state.currentShot = null;

        treeExpanded[`p_${id}`] = true;
        window.switchTab('browser');
        renderProjectDetail(project);
        loadProjectAssets(project.id);
        loadTree();
    } catch (err) {
        console.error('Failed to open project:', err);
    }
}

function renderProjectDetail(project) {
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
    document.getElementById('projectPath').textContent = projectFolder ? `📂 ${projectFolder}` : '';
    document.getElementById('projectPath').title = projectFolder;

    // Sequences panel
    const seqPanel = document.getElementById('sequencesPanel');
    const seqList = document.getElementById('sequenceList');
    const filterSeq = document.getElementById('filterSequence');

    if (project.type !== 'simple' && project.sequences?.length > 0) {
        seqPanel.style.display = 'block';
        filterSeq.style.display = 'block';

        seqList.innerHTML = project.sequences.map(s => {
            const isActive = state.currentSequence?.id === s.id;
            let shotHtml = '';
            if (isActive && s.shots?.length > 0) {
                shotHtml = `<div class="shot-chips">${s.shots.map(sh => {
                    const isShActive = state.currentShot?.id === sh.id;
                    let roleHtml = '';
                    if (isShActive) {
                        roleHtml = `<button class="shot-chip role-compare-btn" onclick="event.stopPropagation();openRoleCompare(${sh.id})" title="Compare roles side-by-side">🎭 Compare Roles</button>`;
                    }
                    return `
                    <span class="shot-chip ${isShActive ? 'active' : ''}" 
                          onclick="event.stopPropagation();selectShot(${s.id}, ${sh.id})"
                          oncontextmenu="event.stopPropagation();showShotContextMenu(event, ${s.id}, ${sh.id}, '${esc(sh.name).replace(/'/g, "\\'")}')"
                          ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                          ondrop="event.stopPropagation();onShotDrop(event, ${s.id}, ${sh.id})"
                          >🎬 ${esc(sh.name)} <span class="chip-count">${sh.asset_count || 0}</span></span>${roleHtml}`;
                }).join('')}
                    <span class="shot-chip shot-add" onclick="event.stopPropagation();showAddShotModal(${s.id})">+ Shot</span>
                </div>`;
            } else if (isActive) {
                shotHtml = `<div class="shot-chips">
                    <span class="shot-chip shot-add" onclick="event.stopPropagation();showAddShotModal(${s.id})">+ Shot</span>
                </div>`;
            }
            return `
            <div class="sequence-chip ${isActive ? 'active' : ''}" 
                 onclick="selectSequence(${s.id})"
                 oncontextmenu="showSeqContextMenu(event, ${s.id}, '${esc(s.name).replace(/'/g, "\\'")}')"
                 ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                 ondrop="onSeqDrop(event, ${s.id})">
                📋 ${esc(s.name)} <span style="opacity:.5;font-size:.8em">${esc(s.code)}</span>
                <span class="chip-count">${s.asset_count || 0}</span>
            </div>${shotHtml}`;
        }).join('');

        // Populate dropdown
        filterSeq.innerHTML = '<option value="">All Sequences</option>' +
            project.sequences.map(s => `<option value="${s.id}">${s.name} (${s.code})</option>`).join('');
    } else {
        seqPanel.style.display = project.type === 'simple' ? 'none' : 'block';
        seqList.innerHTML = project.type === 'simple' ? '' :
            '<div style="color:var(--text-muted);font-size:0.82rem;padding:8px;">No sequences yet. Click "+ Sequence" to add one.</div>';
        filterSeq.style.display = 'none';
    }
}

async function selectSequence(seqId) {
    const db = state.currentProject;
    const seq = db.sequences.find(s => s.id === seqId);
    state.currentSequence = state.currentSequence?.id === seqId ? null : seq;
    state.currentShot = null;
    state.currentRole = null;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
}

function selectShot(seqId, shotId) {
    const seq = state.currentProject?.sequences?.find(s => s.id === seqId);
    if (!seq) return;
    state.currentSequence = seq;
    const shot = seq.shots?.find(sh => sh.id === shotId);
    state.currentShot = state.currentShot?.id === shotId ? null : shot;
    state.currentRole = null;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
}

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
        renderProjectDetail(proj);
        await loadTree();
    } catch (err) {
        alert('❌ Rename failed: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  ASSET LOADING & RENDERING
// ═══════════════════════════════════════════

export async function loadProjectAssets(projectId) {
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

function renderAssets() {
    const container = document.getElementById('assetContainer');

    if (state.assets.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-icon">📭</div>
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
                <div class="asset-thumb">
                    <img src="/api/assets/${a.id}/thumbnail" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <div class="thumb-placeholder" style="display:none">${typeIcon(a.media_type)}</div>
                    <span class="asset-type-badge ${a.media_type}">${a.media_type}</span>
                    ${a.is_linked ? '<span class="asset-link-badge" title="Linked – file remains at original location">🔗</span>' : ''}
                    ${a.role_name ? `<span class="asset-role-badge" style="background:${a.role_color || '#666'}">${a.role_icon || '🎭'} ${esc(a.role_code)}</span>` : ''}
                    ${a.duration ? `<span class="asset-duration">${formatDuration(a.duration)}</span>` : ''}
                </div>
                ${state.selectedAssets.includes(a.id) ? '<div class="asset-check">✓</div>' : ''}
                <button class="asset-star" onclick="event.stopPropagation();toggleStar(${a.id})">${a.starred ? '⭐' : '☆'}</button>
                <div class="asset-info">
                    <div class="asset-name" title="${esc(a.vault_name)}">${esc(a.vault_name)}</div>
                    <div class="asset-meta">
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
                ${state.selectedAssets.includes(a.id) ? '<div class="asset-check-row">✓</div>' : ''}
                <div class="row-id">${a.id}</div>
                <div class="row-thumb">
                    <img src="/api/assets/${a.id}/thumbnail" onerror="this.outerHTML='<span>${typeIcon(a.media_type)}</span>'">
                    <span class="row-type-pip ${a.media_type}" title="${a.media_type}">${a.file_ext || ''}</span>
                </div>
                <div class="row-audio">${hasAudio ? '🔊' : '<span style="opacity:.25">🔇</span>'}</div>
                <div class="row-show">${esc(a.project_code || '')}</div>
                <div class="row-shot">${esc(a.shot_code || a.shot_name || '—')}</div>
                <div class="row-name">${a.is_linked ? '🔗 ' : ''}${esc(a.vault_name)}</div>
                <div class="row-role">${a.role_name ? `<span class="role-tag" style="background:${a.role_color || '#666'}">${a.role_icon || ''} ${esc(a.role_code)}</span>` : ''}</div>
                <div class="row-res">${a.width ? `${a.width}×${a.height}` : '—'}</div>
                <div class="row-size">${formatSize(a.file_size)}</div>
                <div class="row-date">${formatDateTime(a.created_at)}</div>
                <button class="asset-star" onclick="event.stopPropagation();toggleStar(${a.id})" style="position:static">${a.starred ? '⭐' : '☆'}</button>
            </div>`;
        }).join('');
        container.innerHTML = headerRow + rows;
    }

    updateSelectionToolbar();
}

// ═══════════════════════════════════════════
//  ASSET SELECTION (click, shift-click, bulk)
// ═══════════════════════════════════════════

function handleAssetClick(event, assetIdx) {
    const asset = state.assets[assetIdx];
    if (!asset) return;

    if (event.ctrlKey || event.metaKey) {
        toggleAssetSelection(asset.id);
        state.lastClickedAsset = assetIdx;
        renderAssets();
        return;
    }

    if (event.shiftKey && state.lastClickedAsset >= 0) {
        const start = Math.min(state.lastClickedAsset, assetIdx);
        const end = Math.max(state.lastClickedAsset, assetIdx);
        for (let i = start; i <= end; i++) {
            const id = state.assets[i].id;
            if (!state.selectedAssets.includes(id)) {
                state.selectedAssets.push(id);
            }
        }
        renderAssets();
        return;
    }

    if (state.selectedAssets.length > 0) {
        toggleAssetSelection(asset.id);
        state.lastClickedAsset = assetIdx;
        renderAssets();
        return;
    }

    state.lastClickedAsset = assetIdx;
}

function handleAssetDblClick(event, assetIdx) {
    event.preventDefault();
    const asset = state.assets[assetIdx];
    if (!asset) return;
    openPlayer(assetIdx);
}
window.handleAssetDblClick = handleAssetDblClick;

function toggleAssetSelection(assetId) {
    const idx = state.selectedAssets.indexOf(assetId);
    if (idx >= 0) {
        state.selectedAssets.splice(idx, 1);
    } else {
        state.selectedAssets.push(assetId);
    }
}

function selectAllAssets() {
    state.selectedAssets = state.assets.map(a => a.id);
    renderAssets();
}

function clearAssetSelection() {
    state.selectedAssets = [];
    state.lastClickedAsset = -1;
    renderAssets();
}

function updateSelectionToolbar() {
    const toolbar = document.getElementById('selectionToolbar');
    if (!toolbar) return;
    const count = state.selectedAssets.length;
    toolbar.style.display = count > 0 ? 'flex' : 'none';
    document.getElementById('selectionCount').textContent =
        `${count} selected (${formatSize(state.assets.filter(a => state.selectedAssets.includes(a.id)).reduce((s, a) => s + (a.file_size || 0), 0))})`;
}

// ═══════════════════════════════════════════
//  RIGHT-CLICK CONTEXT MENU
// ═══════════════════════════════════════════

async function showContextMenu(event, assetIdx) {
    event.preventDefault();
    event.stopPropagation();

    const asset = state.assets[assetIdx];
    if (!asset) return;

    // If right-clicked tile isn't already selected, select only it
    if (!state.selectedAssets.includes(asset.id)) {
        state.selectedAssets = [asset.id];
        state.lastClickedAsset = assetIdx;
        renderAssets();
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
            // Single format — show extension inline, no sub-menu
            const ext = (asset.file_ext || '').toLowerCase();
            html += `<div class="ctx-item" data-action="play">▶️ Play ${ext}</div>`;
            html += `<div class="ctx-item" data-action="mrv2">🎬 mrViewer2 ${ext}</div>`;
        } else {
            // Multiple formats — show sub-menus
            html += `<div class="ctx-item ctx-item-parent">▶️ Play`;
            html += `<div class="ctx-submenu">`;
            for (const f of formats) {
                const ext = (f.file_ext || '').toLowerCase();
                html += `<div class="ctx-sub-item" data-play-id="${f.id}"><span class="ctx-sub-ext">${ext}</span><span class="ctx-sub-size">${fmtSize(f.file_size)}</span></div>`;
            }
            html += `</div></div>`;

            html += `<div class="ctx-item ctx-item-parent">🎬 mrViewer2`;
            html += `<div class="ctx-submenu">`;
            for (const f of formats) {
                const ext = (f.file_ext || '').toLowerCase();
                html += `<div class="ctx-sub-item" data-mrv2-id="${f.id}"><span class="ctx-sub-ext">${ext}</span><span class="ctx-sub-size">${fmtSize(f.file_size)}</span></div>`;
            }
            html += `</div></div>`;
        }
        html += `<div class="ctx-item" data-action="star">${asset.starred ? '☆' : '⭐'} ${asset.starred ? 'Unstar' : 'Star'}</div>`;
        html += `<div class="ctx-separator"></div>`;
    }

    // Multi-asset actions (always available)
    html += `<div class="ctx-item" data-action="move">📋 Move to Sequence${!isSingle ? ` (${count})` : ''}</div>`;
    html += `<div class="ctx-item" data-action="role">🎭 Set Role${!isSingle ? ` (${count})` : ''}</div>`;
    html += `<div class="ctx-item" data-action="export">📤 Export${!isSingle ? ` (${count})` : ''}</div>`;

    if (count >= 2) {
        html += `<div class="ctx-item" data-action="compare">🎬 Compare in mrViewer2 (${count})</div>`;
    }

    html += `<div class="ctx-separator"></div>`;
    html += `<div class="ctx-item" data-action="selectAll">☑ Select All</div>`;
    if (count > 0) {
        html += `<div class="ctx-item" data-action="deselectAll">☐ Deselect All</div>`;
    }

    html += `<div class="ctx-separator"></div>`;
    html += `<div class="ctx-item ctx-danger" data-action="delete">🗑 Delete${!isSingle ? ` (${count})` : ''}</div>`;
    html += `<div class="ctx-item ctx-muted" data-action="removeDb">🗑 Remove from DB only${!isSingle ? ` (${count})` : ''}</div>`;

    menu.innerHTML = html;
    document.body.appendChild(menu);

    // Wire up click handlers
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action], [data-play-id], [data-mrv2-id]');
        if (!item) return;
        dismissContextMenu();

        const action = item.dataset.action;
        const playId = item.dataset.playId;
        const mrv2Id = item.dataset.mrv2Id;

        if (playId) { window.openPlayerById?.(parseInt(playId)); return; }
        if (mrv2Id) { window.openInMrViewer2?.(parseInt(mrv2Id)); return; }

        switch (action) {
            case 'play': openPlayer(assetIdx); break;
            case 'mrv2': window.openInMrViewer2?.(asset.id); break;
            case 'star': toggleStar(asset.id); break;
            case 'move': showMoveToSequenceModal(); break;
            case 'role': showAssignRoleModal(); break;
            case 'export': window.showExportModal?.(); break;
            case 'compare': window.openCompareInMrViewer2?.(); break;
            case 'selectAll': selectAllAssets(); break;
            case 'deselectAll': clearAssetSelection(); break;
            case 'delete': bulkDeleteAssets(); break;
            case 'removeDb': bulkDeleteAssets(true); break;
        }
    });

    // Position: ensure menu stays within viewport
    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    // Need to show it first to get dimensions, then reposition
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    requestAnimationFrame(() => {
        const mRect = menu.getBoundingClientRect();
        if (x + mRect.width > window.innerWidth) x = window.innerWidth - mRect.width - 8;
        if (y + mRect.height > window.innerHeight) y = window.innerHeight - mRect.height - 8;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        // Flip sub-menus to the left if they'd go off-screen
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
            <button class="btn-primary" onclick="executeMoveToSequence()">📋 Move</button>
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
        alert(`✅ Moved ${result.moved} asset(s).` +
            (result.errors > 0 ? `\n⚠️ ${result.errors} error(s)` : ''));

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        await loadTree();
        if (state.currentProject) {
            const proj = await api(`/api/projects/${state.currentProject.id}`);
            state.currentProject = proj;
            loadProjectAssets(state.currentProject.id);
        }
    } catch (err) {
        alert('❌ Move failed: ' + err.message);
    }
}

async function showAssignRoleModal() {
    if (state.selectedAssets.length === 0) return;

    let roles = [];
    try { roles = await api('/api/roles'); } catch { /* no roles */ }

    if (roles.length === 0) {
        alert('No roles defined. Go to Settings → Roles to create some.');
        return;
    }

    document.getElementById('modalContent').innerHTML = `
        <h3>🎭 Assign Role to ${state.selectedAssets.length} Asset(s)</h3>
        <p style="color:var(--text-dim);margin-bottom:16px">Categorize assets by department/role.</p>
        <label>Role</label>
        <select id="assignRoleSelect">
            <option value="">-- Clear Role --</option>
            ${roles.map(r => `<option value="${r.id}" style="color:${r.color}">${r.icon} ${esc(r.name)}</option>`).join('')}
        </select>
        <div class="form-actions" style="margin-top:20px">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="executeAssignRole()">🎭 Assign</button>
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
        showToast(`✅ ${action} ${state.selectedAssets.length} asset(s)`);

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        await loadTree();
        if (state.currentProject) {
            loadProjectAssets(state.currentProject.id);
        }
    } catch (err) {
        alert('❌ Role assignment failed: ' + err.message);
    }
}

async function bulkDeleteAssets(dbOnly = false) {
    const count = state.selectedAssets.length;
    if (count === 0) return;

    const msg = dbOnly
        ? `Remove ${count} asset(s) from the database?\n\nFiles will be KEPT on disk.`
        : `DELETE ${count} asset(s)?\n\n⚠️ This will permanently delete the files from disk!\n\nThis cannot be undone.`;

    if (!confirm(msg)) return;

    try {
        const result = await api('/api/assets/bulk-delete', {
            method: 'POST',
            body: {
                ids: state.selectedAssets,
                delete_files: !dbOnly,
            },
        });

        alert(`✅ Deleted ${result.deleted} asset(s).` +
            (result.errors > 0 ? `\n⚠️ ${result.errors} error(s)` : ''));

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        if (state.currentProject) {
            loadProjectAssets(state.currentProject.id);
        }
        window.checkSetup();
    } catch (err) {
        alert('❌ Delete failed: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  SEQUENCES & SHOTS CRUD
// ═══════════════════════════════════════════

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
        openProject(state.currentProject.id);
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
        openProject(state.currentProject.id);
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  HIERARCHY RIGHT-CLICK CONTEXT MENUS
// ═══════════════════════════════════════════

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
    dismissContextMenu(); // dismiss asset menu if open

    const menu = document.createElement('div');
    menu.id = 'hierarchyContextMenu';
    menu.className = 'context-menu';

    menu.innerHTML = `
        <div class="ctx-header">🎬 ${esc(shotName)}</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="select">👆 Select Shot</div>
        <div class="ctx-item" data-action="rename">✏️ Rename</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item ctx-danger" data-action="delete">🗑 Delete Shot</div>
    `;

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        dismissHierarchyMenu();

        switch (item.dataset.action) {
            case 'select': selectShot(seqId, shotId); break;
            case 'rename': renameShot(seqId, shotId, shotName); break;
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
        <div class="ctx-header">📋 ${esc(seqName)}</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="select">👆 Select Sequence</div>
        <div class="ctx-item" data-action="rename">✏️ Rename</div>
        <div class="ctx-item" data-action="addShot">➕ Add Shot</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item ctx-danger" data-action="delete">🗑 Delete Sequence${shotCount > 0 ? ` (${shotCount} shots)` : ''}</div>
    `;

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        dismissHierarchyMenu();

        switch (item.dataset.action) {
            case 'select': selectSequence(seqId); break;
            case 'rename': renameSequence(seqId, seqName); break;
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
        <div class="ctx-header">${project.type === 'shot_based' ? '🎬' : '📁'} ${esc(project.name)}</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item" data-action="addSeq">➕ Add Sequence</div>
        <div class="ctx-separator"></div>
        <div class="ctx-item ctx-danger" data-action="delete">🗑 Delete Project${seqCount > 0 ? ` (${seqCount} sequences)` : ''}</div>
    `;

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        dismissHierarchyMenu();

        switch (item.dataset.action) {
            case 'addSeq': showAddSequenceModal(); break;
            case 'delete': deleteCurrentProject(); break;
        }
    });

    positionContextMenu(menu, event);
}

async function deleteShot(seqId, shotId, shotName) {
    if (!state.currentProject) return;
    if (!confirm(`Delete shot "${shotName}"? Assets in this shot will become unassigned (not deleted).`)) return;
    const projectId = state.currentProject.id;
    try {
        await api(`/api/projects/${projectId}/sequences/${seqId}/shots/${shotId}`, { method: 'DELETE' });
        state.currentShot = null;
        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        renderProjectDetail(proj);
        loadProjectAssets(projectId);
        await loadTree();
    } catch (err) {
        alert('❌ Delete shot failed: ' + err.message);
    }
}

async function deleteSequence(seqId, seqName) {
    if (!state.currentProject) return;
    if (!confirm(`Delete sequence "${seqName}" and all its shots? Assets will become unassigned (not deleted).`)) return;
    const projectId = state.currentProject.id;
    try {
        await api(`/api/projects/${projectId}/sequences/${seqId}`, { method: 'DELETE' });
        state.currentSequence = null;
        state.currentShot = null;
        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        renderProjectDetail(proj);
        loadProjectAssets(projectId);
        await loadTree();
    } catch (err) {
        alert('❌ Delete sequence failed: ' + err.message);
    }
}

async function deleteCurrentProject() {
    if (!state.currentProject) return;
    if (!confirm(`⚠️ DELETE ENTIRE PROJECT "${state.currentProject.name}"?\n\nThis will delete ALL sequences, shots, and assets!\n\nThis cannot be undone!`)) return;

    try {
        await api(`/api/projects/${state.currentProject.id}`, { method: 'DELETE' });
        state.currentProject = null;
        window.switchTab('projects');
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  STAR TOGGLE
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
//  DRAG & DROP — Assets → Sequences
// ═══════════════════════════════════════════

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
        renderProjectDetail(proj);
        await loadTree();
    } catch (err) {
        alert('❌ Rename failed: ' + err.message);
    }
}

function onAssetDragStart(event, assetIdx) {
    const asset = state.assets[assetIdx];
    if (!asset) return;

    if (!state.selectedAssets.includes(asset.id)) {
        state.selectedAssets = [asset.id];
        renderAssets();
    }

    const ids = [...state.selectedAssets];
    event.dataTransfer.setData('application/mediavault-ids', JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = `📦 ${ids.length} asset${ids.length > 1 ? 's' : ''}`;
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

        await loadTree();
        const pid = state.currentProject?.id;
        if (pid) {
            const proj = await api(`/api/projects/${pid}`);
            state.currentProject = proj;
            renderProjectDetail(proj);
            loadProjectAssets(pid);
        }
    } catch (err) {
        alert('❌ Move failed: ' + err.message);
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

        await loadTree();
        const pid = projectId || state.currentProject?.id;
        if (pid) {
            const proj = await api(`/api/projects/${pid}`);
            state.currentProject = proj;
            renderProjectDetail(proj);
            loadProjectAssets(pid);
        }
    } catch (err) {
        alert('❌ Move failed: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  DRAG & DROP — Files from OS → Import
// ═══════════════════════════════════════════

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
            <div class="empty-icon">⏳</div>
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
        await loadTree();

        showToast(`✅ Imported ${result.imported} file${result.imported !== 1 ? 's' : ''}`);
    } catch (err) {
        console.error('File drop upload failed:', err);
        alert('❌ Import failed: ' + err.message);
        container.innerHTML = prevHTML;
    }
}

function showFileDropOverlay() {
    const overlay = document.getElementById('fileDropOverlay');
    if (!overlay) return;

    let target = state.currentProject?.name || '';
    if (state.currentSequence) target += ' → ' + state.currentSequence.name;
    if (state.currentShot) target += ' → ' + state.currentShot.name;
    document.getElementById('dropTargetLabel').textContent = target;

    overlay.style.display = 'flex';
}

function hideFileDropOverlay() {
    const overlay = document.getElementById('fileDropOverlay');
    if (overlay) overlay.style.display = 'none';
}

// ═══════════════════════════════════════════
//  AUTO-REFRESH (poll for new assets)
// ═══════════════════════════════════════════

let _pollTimer = null;
let _lastPollCount = null;
let _lastPollLatest = null;
const POLL_INTERVAL = 5000; // 5 seconds

/**
 * Manual refresh: re-fetch assets for the current project view.
 * Also resets the poll baseline so we don't double-trigger.
 */
export async function refreshAssets() {
    if (!state.currentProject) return;
    await loadProjectAssets(state.currentProject.id);
    // Update poll baseline
    try {
        const info = await api(`/api/assets/poll?project_id=${state.currentProject.id}`);
        _lastPollCount = info.count;
        _lastPollLatest = info.latest;
    } catch {}
    showToast('Assets refreshed', 'success');
}

/**
 * Start polling for new assets. Only polls when the tab is visible
 * and a project is currently open.
 */
function startAssetPoll() {
    stopAssetPoll();
    _pollTimer = setInterval(async () => {
        if (document.hidden) return;           // Tab not visible
        if (!state.currentProject) return;     // No project open

        try {
            const info = await api(`/api/assets/poll?project_id=${state.currentProject.id}`);
            const changed = (_lastPollCount !== null && info.count !== _lastPollCount)
                         || (_lastPollLatest !== null && info.latest !== _lastPollLatest);
            _lastPollCount = info.count;
            _lastPollLatest = info.latest;

            if (changed) {
                await loadProjectAssets(state.currentProject.id);
                loadTree();  // Update counts in the tree too
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
const _origOpenProject = openProject;
async function openProjectWithPoll(id) {
    await _origOpenProject(id);
    startAssetPoll();
}
// Re-assign the wrapped version
window.addEventListener('DOMContentLoaded', () => {
    // Defer so the original openProject reference is set first
    setTimeout(() => startAssetPoll(), 2000);
});

// Stop poll when leaving the browser tab (switching to projects/import/settings)
const _origSwitchTab = window.switchTab;
if (_origSwitchTab) {
    window.switchTab = function(tab) {
        if (tab !== 'browser') stopAssetPoll();
        else startAssetPoll();
        return _origSwitchTab(tab);
    };
}

// ═══════════════════════════════════════════
//  EXPOSE ON WINDOW (for HTML onclick handlers)
// ═══════════════════════════════════════════

window.openProject = openProject;
window.loadProjects = loadProjects;
window.loadTree = loadTree;
window.refreshTree = refreshTree;
window.showCreateProjectModal = showCreateProjectModal;
window.createProject = createProject;
window.treeSelectProject = treeSelectProject;
window.treeSelectSequence = treeSelectSequence;
window.treeSelectShot = treeSelectShot;
window.treeToggle = treeToggle;
window.renderProjectDetail = renderProjectDetail;
window.selectSequence = selectSequence;
window.selectShot = selectShot;
window.renameShot = renameShot;
window.filterAssets = filterAssets;
window.setView = setView;
window.handleAssetClick = handleAssetClick;
window.selectAllAssets = selectAllAssets;
window.clearAssetSelection = clearAssetSelection;
window.showMoveToSequenceModal = showMoveToSequenceModal;
window.executeMoveToSequence = executeMoveToSequence;
window.showAssignRoleModal = showAssignRoleModal;
window.executeAssignRole = executeAssignRole;
window.treeSelectRole = treeSelectRole;
window.bulkDeleteAssets = bulkDeleteAssets;
window.showAddSequenceModal = showAddSequenceModal;
window.createSequence = createSequence;
window.showAddShotModal = showAddShotModal;
window.createShot = createShot;
window.deleteCurrentProject = deleteCurrentProject;
window.deleteShot = deleteShot;
window.deleteSequence = deleteSequence;
window.toggleStar = toggleStar;
window.renameSequence = renameSequence;
window.onAssetDragStart = onAssetDragStart;
window.onSeqDragOver = onSeqDragOver;
window.onSeqDragLeave = onSeqDragLeave;
window.onShotDrop = onShotDrop;
window.onSeqDrop = onSeqDrop;
window.showContextMenu = showContextMenu;
window.showShotContextMenu = showShotContextMenu;
window.showSeqContextMenu = showSeqContextMenu;
window.showProjectContextMenu = showProjectContextMenu;
window.refreshAssets = refreshAssets;
