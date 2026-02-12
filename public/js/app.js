/**
 * Digital Media Vault (DMV) — Dashboard Application
 * All frontend logic for the web interface
 */

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const state = {
    currentTab: 'projects',
    currentProject: null,
    currentSequence: null,
    currentShot: null,
    projects: [],
    assets: [],
    viewMode: 'grid',

    // Import state
    importBrowsePath: '',
    selectedFiles: [],   // Array of { name, path, size, mediaType, icon }
    browsedFiles: [],    // All file entries in current dir (for shift-select)
    lastClickedIndex: -1, // Last clicked file index (for shift-select)

    // Player state
    playerAssets: [],
    playerIndex: 0,

    // Settings
    settings: {},
    vaultConfigured: false,

    // Asset selection (for bulk operations)
    selectedAssets: [],    // Array of asset IDs
    lastClickedAsset: -1,  // Index in state.assets for shift-select
};

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    await checkSetup();
});

async function checkSetup() {
    try {
        const status = await api('/api/settings/status');
        state.settings = await api('/api/settings');

        document.getElementById('assetCount').textContent = `${status.assets} assets`;
        document.getElementById('statusIndicator').className = 'status-dot' + (status.vaultConfigured ? '' : ' warning');

        if (!status.vaultConfigured) {
            document.getElementById('setupOverlay').style.display = 'flex';
        } else {
            document.getElementById('setupOverlay').style.display = 'none';
            loadProjects();
            loadSettings();
        }
    } catch (err) {
        console.error('Setup check failed:', err);
    }
}

// ═══════════════════════════════════════════
//  API HELPER
// ═══════════════════════════════════════════
async function api(url, opts = {}) {
    const options = {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    };
    if (opts.body && typeof opts.body === 'object') {
        options.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, options);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'API error');
    }
    return res.json();
}

// ═══════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════
function switchTab(tab) {
    state.currentTab = tab;

    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));

    if (tab === 'projects') loadProjects();
    if (tab === 'browser') loadTree();
    if (tab === 'import') loadImportTab();
    if (tab === 'settings') { loadSettings(); loadHotkeys(); }
}

// ═══════════════════════════════════════════
//  VAULT SETUP
// ═══════════════════════════════════════════
async function setupVault() {
    const pathInput = document.getElementById('setupVaultPath');
    const vaultPath = pathInput.value.trim();
    if (!vaultPath) return alert('Please enter a path');

    try {
        await api('/api/settings/setup-vault', { method: 'POST', body: { path: vaultPath } });
        document.getElementById('setupOverlay').style.display = 'none';
        await checkSetup();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function browseForVault() {
    openFolderPicker('setupVaultPath');
}

// ═══════════════════════════════════════════
//  PROJECTS
// ═══════════════════════════════════════════
async function loadProjects() {
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

async function loadTree() {
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

        html += `<div class="tree-node ${isActive ? 'tree-active' : ''}" onclick="treeSelectProject(${project.id})">
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
                    ondblclick="event.stopPropagation();renameSequence(${seq.id}, '${esc(seq.name).replace(/'/g, "\\'")}')"
                    ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                    ondrop="onSeqDrop(event, ${seq.id}, ${project.id})">
                    <span class="tree-toggle" onclick="event.stopPropagation();treeToggle('${sKey}')">${sHasChildren ? (sOpen ? '▼' : '▶') : '  '}</span>
                    <span class="tree-icon">📋</span>
                    <span class="tree-label">${esc(seq.name)}</span>
                    <span class="tree-count">${seq.asset_count}</span>
                </div>`;

                if (sOpen && sHasChildren) {
                    for (const shot of seq.shots) {
                        const shActive = state.currentShot?.id === shot.id;
                        html += `<div class="tree-node tree-indent-2 ${shActive ? 'tree-active' : ''}" onclick="treeSelectShot(${project.id}, ${seq.id}, ${shot.id})"
                            ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                            ondrop="event.stopPropagation();onShotDrop(event, ${seq.id}, ${shot.id})">
                            <span class="tree-toggle">  </span>
                            <span class="tree-icon">🎯</span>
                            <span class="tree-label">${esc(shot.name)}</span>
                            <span class="tree-count">${shot.asset_count}</span>
                        </div>`;
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
    // Auto-expand in tree
    treeExpanded[`p_${projectId}`] = true;

    try {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
        state.currentSequence = null;
        state.currentShot = null;
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
    // Ensure project is loaded
    if (!state.currentProject || state.currentProject.id !== projectId) {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
    }

    const seq = state.currentProject.sequences?.find(s => s.id === seqId);
    state.currentSequence = seq || { id: seqId };
    state.currentShot = null;
    state.selectedAssets = [];

    // Auto-expand in tree
    treeExpanded[`p_${projectId}`] = true;
    treeExpanded[`seq_${seqId}`] = true;

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
    renderTree();
}

async function treeSelectShot(projectId, seqId, shotId) {
    // Ensure project is loaded
    if (!state.currentProject || state.currentProject.id !== projectId) {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
    }

    const seq = state.currentProject.sequences?.find(s => s.id === seqId);
    state.currentSequence = seq || { id: seqId };

    // Fetch shots for this sequence if not yet loaded
    try {
        const shots = await api(`/api/projects/${projectId}/sequences/${seqId}/shots`);
        state.currentShot = shots.find(sh => sh.id === shotId) || { id: shotId };
    } catch {
        state.currentShot = { id: shotId };
    }

    state.selectedAssets = [];

    treeExpanded[`p_${projectId}`] = true;
    treeExpanded[`seq_${seqId}`] = true;

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
        switchTab('browser');
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

    // Show vault path so user knows where files live on disk
    const vaultRoot = state.settings?.vault_root || '';
    const projectFolder = vaultRoot ? `${vaultRoot}${vaultRoot.endsWith('\\') || vaultRoot.endsWith('/') ? '' : '\\'}${project.code}` : '';
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
                shotHtml = `<div class="shot-chips">${s.shots.map(sh => `
                    <span class="shot-chip ${state.currentShot?.id === sh.id ? 'active' : ''}" 
                          onclick="event.stopPropagation();selectShot(${s.id}, ${sh.id})"
                          ondblclick="event.stopPropagation();renameShot(${s.id}, ${sh.id}, '${esc(sh.name).replace(/'/g, "\\'")}')"
                          ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                          ondrop="event.stopPropagation();onShotDrop(event, ${s.id}, ${sh.id})"
                          >🎯 ${esc(sh.name)} <span class="chip-count">${sh.asset_count || 0}</span></span>
                `).join('')}
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
                 ondblclick="event.stopPropagation();renameSequence(${s.id}, '${esc(s.name).replace(/'/g, "\\'")}')"
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

    renderProjectDetail(state.currentProject);
    loadProjectAssets(state.currentProject.id);
}

function selectShot(seqId, shotId) {
    const seq = state.currentProject?.sequences?.find(s => s.id === seqId);
    if (!seq) return;
    state.currentSequence = seq;
    const shot = seq.shots?.find(sh => sh.id === shotId);
    state.currentShot = state.currentShot?.id === shotId ? null : shot;

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

async function loadProjectAssets(projectId) {
    const params = new URLSearchParams({ project_id: projectId });

    const mediaType = document.getElementById('filterMediaType')?.value;
    const search = document.getElementById('searchInput')?.value;
    const seqId = state.currentSequence?.id || document.getElementById('filterSequence')?.value;

    if (mediaType) params.set('media_type', mediaType);
    if (search) params.set('search', search);
    if (seqId) {
        params.set('sequence_id', seqId);
        if (!state.currentShot) params.set('unassigned_shot', '1');  // Sequence root: hide assets already in shots
    }
    else params.set('unassigned', '1');  // Root view: only show assets not yet in a sequence
    if (state.currentShot) params.set('shot_id', state.currentShot.id);

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
                data-aidx="${i}" onclick="handleAssetClick(event, ${i})"
                draggable="true" ondragstart="onAssetDragStart(event, ${i})">
                <div class="asset-thumb">
                    <img src="/api/assets/${a.id}/thumbnail" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <div class="thumb-placeholder" style="display:none">${typeIcon(a.media_type)}</div>
                    <span class="asset-type-badge ${a.media_type}">${a.media_type}</span>
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
        container.innerHTML = state.assets.map((a, i) => `
            <div class="asset-row ${state.selectedAssets.includes(a.id) ? 'asset-selected' : ''}" 
                data-aidx="${i}" onclick="handleAssetClick(event, ${i})"
                draggable="true" ondragstart="onAssetDragStart(event, ${i})">
                ${state.selectedAssets.includes(a.id) ? '<div class="asset-check-row">✓</div>' : ''}
                <div class="row-thumb">
                    <img src="/api/assets/${a.id}/thumbnail" onerror="this.outerHTML='<span>${typeIcon(a.media_type)}</span>'">
                </div>
                <div class="row-name">${esc(a.vault_name)}</div>
                <div class="row-type">${a.media_type}</div>
                <div class="row-size">${formatSize(a.file_size)}</div>
                <div class="row-date">${formatDate(a.created_at)}</div>
                <button class="asset-star" onclick="event.stopPropagation();toggleStar(${a.id})" style="position:static">${a.starred ? '⭐' : '☆'}</button>
            </div>
        `).join('');
    }

    updateSelectionToolbar();
}

// ═══════════════════════════════════════════
//  ASSET SELECTION (click, shift-click, bulk)
// ═══════════════════════════════════════════
function handleAssetClick(event, assetIdx) {
    const asset = state.assets[assetIdx];
    if (!asset) return;

    // Ctrl/Cmd-click or Shift-click → selection mode
    if (event.ctrlKey || event.metaKey) {
        toggleAssetSelection(asset.id);
        state.lastClickedAsset = assetIdx;
        renderAssets();
        return;
    }

    if (event.shiftKey && state.lastClickedAsset >= 0) {
        // Shift-click: select range
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

    // If assets are already selected, clicking toggles selection
    if (state.selectedAssets.length > 0) {
        toggleAssetSelection(asset.id);
        state.lastClickedAsset = assetIdx;
        renderAssets();
        return;
    }

    // Plain click with nothing selected → open player
    state.lastClickedAsset = assetIdx;
    openPlayer(assetIdx);
}

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

    const count = state.selectedAssets.length;
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

        // Refresh project tree & assets
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

        // Reload assets
        if (state.currentProject) {
            loadProjectAssets(state.currentProject.id);
        }
        checkSetup();
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
        openProject(state.currentProject.id); // Refresh
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

async function deleteCurrentProject() {
    if (!state.currentProject) return;
    if (!confirm(`Delete "${state.currentProject.name}" and ALL its assets? This cannot be undone!`)) return;

    try {
        await api(`/api/projects/${state.currentProject.id}`, { method: 'DELETE' });
        state.currentProject = null;
        switchTab('projects');
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  IMPORT
// ═══════════════════════════════════════════
async function loadImportTab() {
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
    const parent = state.importBrowsePath.replace(/\\[^\\]+$/, '') || '';
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
        // Shift-click: select range from lastClicked to current
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
        // Normal click: toggle single file
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

        // Get sequence/shot codes
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

        // Preview first file
        const firstFile = state.selectedFiles[0];
        const result = await api('/api/assets/preview-name', {
            method: 'POST',
            body: {
                originalName: firstFile.name,
                projectCode: project.code,
                sequenceCode: seqCode || undefined,
                shotCode: shotCode || undefined,
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
        const keepOriginals = document.getElementById('importKeepOriginals')?.checked || false;

        const result = await api('/api/assets/import', {
            method: 'POST',
            body: {
                files: state.selectedFiles.map(f => f.path),
                project_id: parseInt(projectId),
                sequence_id: seqId ? parseInt(seqId) : undefined,
                shot_id: shotId ? parseInt(shotId) : undefined,
                take_number: parseInt(take),
                custom_name: customName,
                keep_originals: keepOriginals,
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
        checkSetup();
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
    switchTab('import');
    // Pre-select current project
    setTimeout(() => {
        if (state.currentProject) {
            document.getElementById('importProject').value = state.currentProject.id;
            onImportProjectChange();
        }
    }, 100);
}

// ═══════════════════════════════════════════
//  MEDIA PLAYER
// ═══════════════════════════════════════════
function openPlayer(index) {
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
    meta.innerHTML = parts.join('');
}

// ═══════════════════════════════════════════
//  OPEN IN MRV2
// ═══════════════════════════════════════════
async function openInExternalPlayer(assetId) {
    try {
        const player = state.settings?.default_player || 'mrviewer2';
        const customPath = state.settings?.custom_player_path || '';
        const res = await api(`/api/assets/${assetId}/open-external`, {
            method: 'POST',
            body: { player, customPath }
        });
        showToast('Launched in external player');
        // Briefly blur browser so the external player gets focus
        window.blur();
    } catch (err) {
        showToast('Failed to launch player: ' + err.message, 5000);
    }
}

async function openInMrViewer2(assetId) {
    try {
        const res = await api(`/api/assets/${assetId}/open-external`, { method: 'POST', body: { player: 'mrviewer2' } });
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
            body: { ids: state.selectedAssets }
        });
        showToast(`Loaded ${res.count} clips in mrViewer2 — use Panel → Compare → Wipe`);
        window.blur();
    } catch (err) {
        showToast('Failed to launch compare: ' + err.message, 5000);
    }
}

// ═══════════════════════════════════════════
//  STAR TOGGLE
// ═══════════════════════════════════════════
async function toggleStar(assetId) {
    try {
        await api(`/api/assets/${assetId}/star`, { method: 'POST' });
        // Refresh assets
        if (state.currentProject) {
            loadProjectAssets(state.currentProject.id);
        }
    } catch (err) {
        console.error('Star toggle failed:', err);
    }
}

// ═══════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════
async function loadSettings() {
    try {
        state.settings = await api('/api/settings');
        const status = await api('/api/settings/status');

        document.getElementById('settingVaultRoot').value = state.settings.vault_root || '';
        document.getElementById('settingNamingTemplate').value = state.settings.naming_template || '';
        document.getElementById('settingThumbSize').value = state.settings.thumbnail_size || '320';
        document.getElementById('settingAutoThumb').checked = state.settings.auto_thumbnail !== 'false';
        document.getElementById('settingComfyPath').value = state.settings.comfyui_output_path || '';
        document.getElementById('settingComfyWatch').checked = state.settings.comfyui_watch_enabled === 'true';

        // Flow Production Tracking
        document.getElementById('settingFlowSite').value = state.settings.flow_site_url || '';
        document.getElementById('settingFlowScriptName').value = state.settings.flow_script_name || '';
        document.getElementById('settingFlowApiKey').value = state.settings.flow_api_key || '';
        checkFlowStatus();

        // External player
        const playerSel = document.getElementById('settingDefaultPlayer');
        const defPlayer = state.settings.default_player || 'browser';
        playerSel.value = defPlayer;
        document.getElementById('customPlayerRow').style.display = defPlayer === 'custom' ? 'flex' : 'none';
        document.getElementById('settingCustomPlayerPath').value = state.settings.custom_player_path || '';
        playerSel.onchange = () => {
            document.getElementById('customPlayerRow').style.display = playerSel.value === 'custom' ? 'flex' : 'none';
            saveSettings();
        };

        // System info
        document.getElementById('systemInfo').innerHTML = `
            <div style="font-size:0.82rem;color:var(--text-dim);line-height:1.8;">
                <div>Version: <strong>${status.version}</strong></div>
                <div>Projects: <strong>${status.projects}</strong></div>
                <div>Assets: <strong>${status.assets}</strong></div>
                <div>Watch Folders: <strong>${status.watchFolders}</strong></div>
                <div>FFmpeg: ${status.ffmpegAvailable ? '<span style="color:var(--success)">✓ Available</span>' : '<span style="color:var(--danger)">✗ Not found</span>'}</div>
                <div>Vault: ${status.vaultConfigured ? '<span style="color:var(--success)">✓ Configured</span>' : '<span style="color:var(--warning)">⚠ Not configured</span>'}</div>
            </div>
        `;

        // Watch folders
        const watches = await api('/api/settings/watches');
        document.getElementById('watchFolderList').innerHTML = watches.map(w => `
            <div class="watch-item">
                <span>📂 ${esc(w.path)} ${w.project_name ? `→ ${esc(w.project_name)}` : ''}</span>
                <button onclick="removeWatch(${w.id})">✕</button>
            </div>
        `).join('') || '<div style="color:var(--text-muted);font-size:0.8rem;">No watch folders configured.</div>';

        // Check if files need migration to new vault root
        const vaultRoot = state.settings.vault_root;
        if (vaultRoot && status.assets > 0) {
            checkMigrationNeeded(vaultRoot);
        }
    } catch (err) {
        console.error('Settings load failed:', err);
    }
}

async function saveSettings() {
    const updates = {
        vault_root: document.getElementById('settingVaultRoot').value.trim(),
        naming_template: document.getElementById('settingNamingTemplate').value.trim(),
        thumbnail_size: document.getElementById('settingThumbSize').value,
        auto_thumbnail: document.getElementById('settingAutoThumb').checked ? 'true' : 'false',
        comfyui_output_path: document.getElementById('settingComfyPath').value.trim(),
        comfyui_watch_enabled: document.getElementById('settingComfyWatch').checked ? 'true' : 'false',
        default_player: document.getElementById('settingDefaultPlayer').value,
        custom_player_path: document.getElementById('settingCustomPlayerPath').value.trim(),
        flow_site_url: document.getElementById('settingFlowSite').value.trim(),
        flow_script_name: document.getElementById('settingFlowScriptName').value.trim(),
        flow_api_key: document.getElementById('settingFlowApiKey').value.trim(),
    };

    try {
        await api('/api/settings', { method: 'POST', body: updates });
        loadSettings();
    } catch (err) {
        alert('Error saving: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  FLOW PRODUCTION TRACKING
// ═══════════════════════════════════════════

async function checkFlowStatus() {
    const statusEl = document.getElementById('flowStatus');
    const syncBtn = document.getElementById('flowSyncBtn');
    if (!statusEl) return;

    const site = document.getElementById('settingFlowSite').value.trim();
    const name = document.getElementById('settingFlowScriptName').value.trim();
    const key = document.getElementById('settingFlowApiKey').value.trim();

    if (!site || !name || !key) {
        statusEl.innerHTML = '<span style="color:var(--text-muted)">⚪ Not configured — enter credentials above</span>';
        syncBtn.disabled = true;
        return;
    }
    statusEl.innerHTML = '<span style="color:var(--text-dim)">⏳ Checking...</span>';
    try {
        const res = await api('/api/flow/status');
        if (res.connected) {
            statusEl.innerHTML = '<span style="color:var(--success)">✅ Connected to Flow</span>';
            syncBtn.disabled = false;
        } else {
            statusEl.innerHTML = `<span style="color:var(--danger)">❌ ${esc(res.error || 'Connection failed')}</span>`;
            syncBtn.disabled = true;
        }
    } catch (err) {
        statusEl.innerHTML = `<span style="color:var(--danger)">❌ ${esc(err.message)}</span>`;
        syncBtn.disabled = true;
    }
}

async function testFlowConnection() {
    const btn = document.getElementById('flowTestBtn');
    const statusEl = document.getElementById('flowStatus');
    btn.disabled = true;
    btn.textContent = '⏳ Testing...';
    // Save credentials first
    await saveSettings();
    try {
        const res = await api('/api/flow/test', { method: 'POST' });
        statusEl.innerHTML = `<span style="color:var(--success)">✅ ${esc(res.message)}</span>`;
        document.getElementById('flowSyncBtn').disabled = false;
    } catch (err) {
        statusEl.innerHTML = `<span style="color:var(--danger)">❌ ${esc(err.message)}</span>`;
    }
    btn.disabled = false;
    btn.textContent = '🔌 Test Connection';
}

function showFlowSyncPanel() {
    const panel = document.getElementById('flowSyncPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function flowLog(msg, type = 'info') {
    const log = document.getElementById('flowSyncLog');
    const color = type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--text-dim)';
    log.innerHTML += `<div style="color:${color}">${msg}</div>`;
    log.scrollTop = log.scrollHeight;
}

async function flowSyncProjects() {
    const log = document.getElementById('flowSyncLog');
    log.innerHTML = '';
    flowLog('🔄 Syncing projects from Flow...');
    try {
        const res = await api('/api/flow/sync/projects', { method: 'POST' });
        flowLog(`✅ Projects: ${res.created} created, ${res.updated} updated (${res.total} total in Flow)`, 'success');
        // Load Flow projects to populate the project selector
        await loadFlowProjectSelector();
    } catch (err) {
        flowLog(`❌ ${err.message}`, 'error');
    }
}

async function flowSyncSteps() {
    flowLog('🔄 Syncing pipeline steps → roles...');
    try {
        const res = await api('/api/flow/sync/steps', { method: 'POST' });
        flowLog(`✅ Roles: ${res.created} created, ${res.updated} updated (${res.total} steps in Flow)`, 'success');
    } catch (err) {
        flowLog(`❌ ${err.message}`, 'error');
    }
}

async function loadFlowProjectSelector() {
    const row = document.getElementById('flowProjectSyncRow');
    const select = document.getElementById('flowProjectSelect');
    try {
        // Get local projects that have flow_id
        const mappings = await api('/api/flow/mappings/projects');
        if (mappings.length === 0) {
            flowLog('ℹ️ No projects linked yet. Sync projects first, then use Full Sync.');
            row.style.display = 'none';
            return;
        }
        select.innerHTML = mappings.map(p =>
            `<option value="${p.id}" data-flow-id="${p.flow_id}">${esc(p.name)} (Flow #${p.flow_id})</option>`
        ).join('');
        row.style.display = 'block';
    } catch (err) {
        flowLog(`⚠️ Could not load project mappings: ${err.message}`, 'error');
    }
}

async function flowFullSync() {
    const select = document.getElementById('flowProjectSelect');
    const option = select.options[select.selectedIndex];
    if (!option) return;

    const localId = parseInt(option.value);
    const flowId = parseInt(option.dataset.flowId);
    const name = option.textContent;

    flowLog(`🔄 Full sync for "${name}"...`);
    flowLog('  → Syncing pipeline steps...');
    try {
        const res = await api('/api/flow/sync/full', {
            method: 'POST',
            body: { flowProjectId: flowId, localProjectId: localId }
        });
        flowLog(`  ✅ Steps: ${res.steps.created} created, ${res.steps.updated} updated`, 'success');
        flowLog(`  ✅ Sequences: ${res.sequences.created} created, ${res.sequences.updated} updated`, 'success');
        flowLog(`  ✅ Shots: ${res.shots.created} created, ${res.shots.updated} updated`, 'success');
        flowLog('✅ Full sync complete!', 'success');
    } catch (err) {
        flowLog(`❌ Sync failed: ${err.message}`, 'error');
    }
}

// ═══════════════════════════════════════════
//  VIEWER KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════
let _hotkeyData = null;   // cached categories from API
let _hotkeyChanges = {};  // map of action name → changed fields

async function loadHotkeys() {
    const editor = document.getElementById('hotkeyEditor');
    if (!editor) return;
    try {
        const data = await api('/api/settings/hotkeys');
        _hotkeyData = data.categories;
        _hotkeyChanges = {};
        renderHotkeyEditor();
    } catch (err) {
        editor.innerHTML = `<div class="hotkey-loading" style="color:var(--warning)">⚠ Could not load shortcuts: ${esc(err.message)}</div>`;
    }
}

function renderHotkeyEditor() {
    const editor = document.getElementById('hotkeyEditor');
    if (!_hotkeyData) return;

    let html = '<div class="hotkey-toolbar">'
        + '<input type="text" id="hotkeySearch" placeholder="Search shortcuts..." oninput="filterHotkeys(this.value)">'
        + '<button class="hotkey-save-btn" onclick="saveHotkeys()" id="hotkeysSaveBtn" disabled>💾 Save Changes</button>'
        + '<button class="hotkey-reset-btn" onclick="resetHotkeyChanges()">↩ Discard</button>'
        + '</div>';

    for (const cat of _hotkeyData) {
        if (cat.actions.length === 0) continue;
        const catId = cat.name.replace(/[^a-zA-Z]/g, '');
        html += `<details class="hotkey-category" id="hkCat_${catId}">`;
        html += `<summary class="hotkey-cat-header">${esc(cat.name)} <span class="hotkey-cat-count">${cat.actions.length}</span></summary>`;
        html += '<div class="hotkey-list">';
        for (const action of cat.actions) {
            const safeId = action.name.replace(/[^a-zA-Z0-9]/g, '_');
            const changed = _hotkeyChanges[action.name];
            const label = changed ? buildShortcutLabelClient(changed) : action.label;
            const isModified = changed ? ' hotkey-modified' : '';
            html += `<div class="hotkey-row${isModified}" data-action="${esc(action.name)}" id="hkRow_${safeId}">`;
            html += `  <span class="hotkey-action-name">${esc(action.name)}</span>`;
            html += `  <button class="hotkey-key-btn${isModified}" onclick="captureHotkey('${esc(action.name)}')" title="Click to remap">${esc(label)}</button>`;
            if (changed) {
                html += `  <button class="hotkey-clear-btn" onclick="clearHotkeyChange('${esc(action.name)}')" title="Undo change">✕</button>`;
            }
            html += '</div>';
        }
        html += '</div></details>';
    }

    editor.innerHTML = html;
    markHotkeysModified();  // sync button state after re-render
}

function buildShortcutLabelClient(binding) {
    const parts = [];
    if (binding.ctrl === '1') parts.push('Ctrl');
    if (binding.alt === '1') parts.push('Alt');
    if (binding.shift === '1') parts.push('Shift');
    if (binding.meta === '1') parts.push('Meta');
    const keyLabel = fltkKeyLabel(binding.key, binding.text);
    if (keyLabel) parts.push(keyLabel);
    return parts.join(' + ') || '(none)';
}

function fltkKeyLabel(keyCode, textVal) {
    const kc = parseInt(keyCode) || 0;
    const names = {
        0:'', 8:'Backspace', 9:'Tab', 13:'Enter', 27:'Escape', 32:'Space',
        44:',', 45:'-', 46:'.', 47:'/',
        59:';', 61:'=', 91:'[', 92:'\\', 93:']', 96:'`', 127:'Delete',
        65288:'Backspace', 65289:'Tab', 65293:'Enter', 65307:'Escape',
        65360:'Home', 65361:'Left', 65362:'Up', 65363:'Right', 65364:'Down',
        65365:'Page Up', 65366:'Page Down', 65367:'End',
        65379:'Insert', 65535:'Delete',
        65470:'F1', 65471:'F2', 65472:'F3', 65473:'F4', 65474:'F5', 65475:'F6',
        65476:'F7', 65477:'F8', 65478:'F9', 65479:'F10', 65480:'F11', 65481:'F12',
    };
    if (kc >= 97 && kc <= 122) return String.fromCharCode(kc).toUpperCase();
    if (kc >= 48 && kc <= 57) return String.fromCharCode(kc);
    if (names[kc]) return names[kc];
    if (kc > 0) return `Key(${kc})`;
    if (textVal) return textVal;
    return '';
}

/** Convert browser KeyboardEvent.key/code → FLTK key/text values */
function browserKeyToFltk(e) {
    // Modifier-only presses — ignore
    if (['Control','Alt','Shift','Meta'].includes(e.key)) return null;

    const result = {
        ctrl: e.ctrlKey ? '1' : '0',
        alt: e.altKey ? '1' : '0',
        shift: e.shiftKey ? '1' : '0',
        meta: e.metaKey ? '1' : '0',
        key: '0',
        text: '',
    };

    // Map browser key → FLTK key code
    const keyMap = {
        'Backspace': 65288, 'Tab': 65289, 'Enter': 65293, 'Escape': 65307,
        'Home': 65360, 'ArrowLeft': 65361, 'ArrowUp': 65362,
        'ArrowRight': 65363, 'ArrowDown': 65364,
        'PageUp': 65365, 'PageDown': 65366, 'End': 65367,
        'Insert': 65379, 'Delete': 65535,
        'F1': 65470, 'F2': 65471, 'F3': 65472, 'F4': 65473,
        'F5': 65474, 'F6': 65475, 'F7': 65476, 'F8': 65477,
        'F9': 65478, 'F10': 65479, 'F11': 65480, 'F12': 65481,
        ' ': 32,
    };

    if (keyMap[e.key]) {
        result.key = String(keyMap[e.key]);
    } else if (e.key.length === 1) {
        // Single character: letters → lowercase ASCII, others → text field
        const ch = e.key.toLowerCase();
        const code = ch.charCodeAt(0);
        if (code >= 97 && code <= 122) {
            result.key = String(code);  // a=97, b=98, ...
        } else if (code >= 48 && code <= 57) {
            result.key = String(code);
        } else {
            // Punctuation like ( ) , . / etc. → use text field
            result.key = '0';
            result.text = e.key;
        }
    }

    return result;
}

let _captureOverlay = null;

function captureHotkey(actionName) {
    // Show overlay to capture next keypress
    if (_captureOverlay) _captureOverlay.remove();

    const overlay = document.createElement('div');
    overlay.className = 'hotkey-capture-overlay';
    overlay.innerHTML = `
        <div class="hotkey-capture-box">
            <div class="hotkey-capture-title">Remap: ${esc(actionName)}</div>
            <div class="hotkey-capture-prompt">Press the new key combination...</div>
            <div class="hotkey-capture-hint">Press <strong>Escape</strong> to cancel, <strong>Backspace</strong> to clear binding</div>
        </div>
    `;
    document.body.appendChild(overlay);
    _captureOverlay = overlay;

    const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') {
            overlay.remove();
            _captureOverlay = null;
            document.removeEventListener('keydown', handler, true);
            return;
        }

        // Backspace alone = clear binding
        if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            _hotkeyChanges[actionName] = { name: actionName, ctrl:'0', alt:'0', meta:'0', shift:'0', key:'0', text:'' };
            overlay.remove();
            _captureOverlay = null;
            document.removeEventListener('keydown', handler, true);
            markHotkeysModified();
            renderHotkeyEditor();
            return;
        }

        const fltk = browserKeyToFltk(e);
        if (!fltk) return; // modifier-only, wait for real key

        fltk.name = actionName;
        _hotkeyChanges[actionName] = fltk;
        overlay.remove();
        _captureOverlay = null;
        document.removeEventListener('keydown', handler, true);
        markHotkeysModified();
        renderHotkeyEditor();
    };

    document.addEventListener('keydown', handler, true);
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.remove();
            _captureOverlay = null;
            document.removeEventListener('keydown', handler, true);
        }
    };
}

function clearHotkeyChange(actionName) {
    delete _hotkeyChanges[actionName];
    markHotkeysModified();
    renderHotkeyEditor();
}

function markHotkeysModified() {
    const btn = document.getElementById('hotkeysSaveBtn');
    const count = Object.keys(_hotkeyChanges).length;
    if (btn) {
        btn.disabled = count === 0;
        btn.textContent = count > 0 ? `💾 Save ${count} Change${count > 1 ? 's' : ''}` : '💾 Save Changes';
    }
}

function resetHotkeyChanges() {
    _hotkeyChanges = {};
    markHotkeysModified();
    renderHotkeyEditor();
}

async function saveHotkeys() {
    const changes = Object.values(_hotkeyChanges);
    if (changes.length === 0) return;

    try {
        const result = await api('/api/settings/hotkeys', { method: 'POST', body: { changes } });
        if (result.success) {
            showToast(`Saved ${result.written} shortcut${result.written > 1 ? 's' : ''}`);
            _hotkeyChanges = {};
            loadHotkeys(); // reload from file
        }
    } catch (err) {
        alert('Error saving hotkeys: ' + err.message);
    }
}

function filterHotkeys(query) {
    const q = query.toLowerCase().trim();
    const rows = document.querySelectorAll('.hotkey-row');
    const cats = document.querySelectorAll('.hotkey-category');

    rows.forEach(row => {
        const name = row.dataset.action.toLowerCase();
        row.style.display = (!q || name.includes(q)) ? '' : 'none';
    });

    // Auto-expand categories with matches, collapse empty
    cats.forEach(cat => {
        const visible = cat.querySelectorAll('.hotkey-row:not([style*="display: none"])').length;
        cat.style.display = visible > 0 || !q ? '' : 'none';
        if (q && visible > 0) cat.open = true;
    });
}

let _lastKnownOldRoot = null;

function checkMigrationNeeded(currentVaultRoot) {
    // After loading settings, check if files still live at an old location
    // We detect this by checking the first asset's file_path vs the vault root
    fetch('/api/assets?limit=1').then(r => r.json()).then(data => {
        const migrateSection = document.getElementById('migrateSection');
        if (!data.assets || data.assets.length === 0) {
            migrateSection.style.display = 'none';
            return;
        }
        const firstPath = data.assets[0].file_path;
        const normalizedRoot = currentVaultRoot.replace(/[\\/]+$/, '');
        // Check if the file_path starts with the current vault root
        if (!firstPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
            // Files are somewhere else — extract old root from file_path
            // e.g. file_path: C:\MediaVault\COMFYUIT\... → old root: C:\MediaVault
            const relPath = data.assets[0].relative_path;
            const oldRoot = firstPath.slice(0, firstPath.length - relPath.length - 1);
            _lastKnownOldRoot = oldRoot;
            document.getElementById('migrateMessage').textContent =
                `Files are still at ${oldRoot}. Move them to ${currentVaultRoot}?`;
            migrateSection.style.display = 'block';
        } else {
            migrateSection.style.display = 'none';
        }
    }).catch(() => {});
}

async function migrateVault() {
    if (!_lastKnownOldRoot) { alert('Could not determine old vault location.'); return; }
    const newRoot = document.getElementById('settingVaultRoot').value.trim();
    if (!newRoot) { alert('Set a vault root path first.'); return; }

    const btn = document.getElementById('migrateBtn');
    const prog = document.getElementById('migrateProgress');
    const fill = document.getElementById('migrateFill');
    const statusEl = document.getElementById('migrateStatus');

    if (!confirm(`Move all vault files from:\n${_lastKnownOldRoot}\n\nTo:\n${newRoot}\n\nThis may take a while for large vaults.`)) return;

    btn.disabled = true;
    btn.textContent = '⏳ Migrating...';
    prog.style.display = 'block';
    fill.style.width = '30%';
    statusEl.textContent = 'Copying files...';

    try {
        const result = await api('/api/settings/migrate-vault', {
            method: 'POST',
            body: { oldRoot: _lastKnownOldRoot, newRoot },
        });

        fill.style.width = '100%';
        fill.style.background = '#7ab87a';
        statusEl.textContent = `✅ Done! ${result.filesCopied} files moved, ${result.pathsUpdated} paths updated.`;
        btn.textContent = '✅ Migration Complete';

        // Refresh everything after short delay
        setTimeout(() => {
            document.getElementById('migrateSection').style.display = 'none';
            loadSettings();
        }, 3000);
    } catch (err) {
        fill.style.width = '100%';
        fill.style.background = '#b85c5c';
        statusEl.textContent = `❌ Error: ${err.message}`;
        btn.disabled = false;
        btn.textContent = '📦 Retry Migration';
    }
}

async function addWatchFolder() {
    const pathInput = document.getElementById('newWatchPath');
    const folderPath = pathInput.value.trim();
    if (!folderPath) return;

    try {
        await api('/api/settings/watches', {
            method: 'POST',
            body: { path: folderPath, auto_import: true },
        });
        pathInput.value = '';
        loadSettings();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function removeWatch(id) {
    try {
        await api(`/api/settings/watches/${id}`, { method: 'DELETE' });
        loadSettings();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ═══════════════════════════════════════════
//  MODAL
// ═══════════════════════════════════════════
function closeModal() {
    document.getElementById('modal').style.display = 'none';
}

// ═══════════════════════════════════════════
//  FOLDER PICKER
// ═══════════════════════════════════════════
let fpTargetInput = null;   // ID of the input field to fill
let fpCurrentDir = '';      // Current browse directory

function openFolderPicker(inputId) {
    fpTargetInput = inputId;
    // Start browsing from current value if it exists, otherwise show drives
    const currentVal = document.getElementById(inputId)?.value?.trim() || '';
    fpCurrentDir = '';
    document.getElementById('fpSelectedPath').value = currentVal;
    document.getElementById('folderPickerModal').style.display = 'flex';
    fpNavigate(currentVal || '');
}

function closeFolderPicker() {
    document.getElementById('folderPickerModal').style.display = 'none';
    fpTargetInput = null;
}

function confirmFolderPicker() {
    const selected = document.getElementById('fpSelectedPath').value;
    if (fpTargetInput && selected) {
        document.getElementById(fpTargetInput).value = selected;
    }
    closeFolderPicker();
}

async function fpNavigate(dir) {
    fpCurrentDir = dir;
    document.getElementById('fpSelectedPath').value = dir;

    const pathBar = document.getElementById('fpCurrentPath');
    pathBar.textContent = dir || 'Drives';

    const container = document.getElementById('fpEntries');
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">Loading...</div>';

    try {
        const url = dir ? `/api/assets/browse?dir=${encodeURIComponent(dir)}&folders_only=1` : '/api/assets/browse?folders_only=1';
        const data = await api(url);

        let html = '';

        // Back / up button
        if (data.parent || dir) {
            const parentPath = data.parent || '';
            html += `<div class="fp-entry fp-entry-up" ondblclick="fpNavigate('${escAttr(parentPath)}')">
                <span class="fp-icon">⬆️</span>
                <span class="fp-name">..</span>
            </div>`;
        }

        // Folder entries
        for (const entry of data.entries) {
            if (!entry.isDirectory) continue;
            html += `<div class="fp-entry" onclick="fpSelectEntry('${escAttr(entry.path)}')" ondblclick="fpNavigate('${escAttr(entry.path)}')">
                <span class="fp-icon">${entry.icon || '📁'}</span>
                <span class="fp-name">${esc(entry.name)}</span>
            </div>`;
        }

        if (!html) {
            html = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No subfolders</div>';
        }

        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<div style="padding:20px;text-align:center;color:#b85c5c;">Error: ${esc(err.message)}</div>`;
    }
}

function fpSelectEntry(path) {
    document.getElementById('fpSelectedPath').value = path;
    // Highlight selected
    document.querySelectorAll('.fp-entry').forEach(el => el.classList.remove('fp-entry-selected'));
    event.currentTarget.classList.add('fp-entry-selected');
}

// ═══════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════
function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escAttr(str) {
    return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(seconds) {
    if (!seconds) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function typeIcon(type) {
    const icons = { video: '🎬', image: '🖼️', audio: '🔊', exr: '✨', threed: '🧊', document: '📄' };
    return icons[type] || '📎';
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

        // Refresh everything
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

    // If dragged asset isn't selected, select only it
    if (!state.selectedAssets.includes(asset.id)) {
        state.selectedAssets = [asset.id];
        renderAssets();
    }

    const ids = [...state.selectedAssets];
    event.dataTransfer.setData('application/mediavault-ids', JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';

    // Custom drag ghost showing count
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
        const result = await api('/api/assets/bulk-assign', {
            method: 'POST',
            body: { ids, sequence_id: seqId },
        });

        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        // Refresh tree & assets
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

let fileDragCounter = 0; // Tracks enter/leave nesting

function initFileDropZone() {
    const wrap = document.getElementById('assetContainerWrap');
    if (!wrap) return;

    wrap.addEventListener('dragenter', onFileDragEnter);
    wrap.addEventListener('dragover', onFileDragOver);
    wrap.addEventListener('dragleave', onFileDragLeave);
    wrap.addEventListener('drop', onFileDrop);
}

function onFileDragEnter(e) {
    // Ignore internal asset drags (they set our custom type)
    if (e.dataTransfer.types.includes('application/mediavault-ids')) return;
    // Only react to external file drags
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
    // Ignore internal asset drags
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

    // Build FormData
    const formData = new FormData();
    formData.append('project_id', projectId);
    if (state.currentSequence?.id) formData.append('sequence_id', state.currentSequence.id);
    if (state.currentShot?.id) formData.append('shot_id', state.currentShot.id);

    let fileCount = 0;
    for (const file of files) {
        formData.append('files', file);
        fileCount++;
    }

    // Show progress
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

        // Refresh project data & assets
        const proj = await api(`/api/projects/${projectId}`);
        state.currentProject = proj;
        renderProjectDetail(proj);
        await loadProjectAssets(projectId);
        await loadTree();

        // Brief success toast
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

    // Build label showing where files will go
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

function showToast(message, duration = 3000) {
    let toast = document.getElementById('mvToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mvToast';
        toast.className = 'mv-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

// Init drop zone after DOM loads
document.addEventListener('DOMContentLoaded', initFileDropZone);

// Listen for custom name changes to update preview
document.getElementById('importCustomName')?.addEventListener('input', updateRenamePreview);
document.getElementById('importTake')?.addEventListener('input', updateRenamePreview);
