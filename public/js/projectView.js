/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM - Project View Module
 * Project grid, create/edit modals, archive operations.
 * Handles the "Projects" tab content.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, escAttr, showToast, closeModal } from './utils.js';
import { renderShotBuilder, getConvention } from './shotBuilder.js';

// ===========================================
//  MODULE STATE
// ===========================================

let showArchived = false;

/** Expose showArchived for other modules (treeNav uses it) */
export function isShowArchived() { return showArchived; }

// ===========================================
//  LOAD & RENDER PROJECTS
// ===========================================

export async function loadProjects() {
    try {
        const projects = await api(`/api/projects${showArchived ? '?include_archived=1' : ''}`);
        state.projects = projects;
        renderProjectGrid(projects);
    } catch (err) {
        console.error('Failed to load projects:', err);
    }
}

function renderProjectGrid(projects) {
    const container = document.getElementById('projectGrid');
    if (!container) return;

    if (!projects || projects.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-icon"></div>
                <p>No projects yet.</p>
                <button class="btn-primary" onclick="showCreateProjectModal()">+ Create Project</button>
            </div>
        `;
        return;
    }

    container.innerHTML = projects.map(p => renderProjectCard(p)).join('');
}

function renderProjectCard(p) {
    const icon = p.type === 'shot_based' ? '' : '';
    const archived = p.archived ? ' style="opacity:0.5;"' : '';
    return `
    <div class="project-card fade-in"${archived} onclick="openProject(${p.id})" oncontextmenu="event.preventDefault()">
        <div class="project-icon">${icon}</div>
        <div class="project-name">${esc(p.name)}</div>
        <div class="project-meta">
            <span class="badge">${esc(p.code)}</span>
            <span>${p.asset_count || 0} assets</span>
            ${p.archived ? '<span class="badge badge-dim">Archived</span>' : ''}
        </div>
        <div class="project-actions" onclick="event.stopPropagation()">
            <button class="btn-sm" onclick="showEditProjectModal(${p.id})" title="Edit project">Edit</button>
            <button class="btn-sm" onclick="toggleArchiveProject(${JSON.stringify({ id: p.id, name: p.name, archived: p.archived }).replace(/"/g, '&quot;')})" title="${p.archived ? 'Unarchive' : 'Archive'}">${p.archived ? '' : ''}</button>
        </div>
    </div>`;
}

// ===========================================
//  CREATE PROJECT MODAL
// ===========================================

function showCreateProjectModal() {
    const modal = document.getElementById('modal');
    document.getElementById('modalContent').innerHTML = `
        <h3>+ Create New Project</h3>
        <label>Project Name</label>
        <input type="text" id="newProjectName" autofocus>
        <label>Project Code <span style="color:var(--text-muted);font-size:0.75rem">(used in folder structure, cannot be changed later)</span></label>
        <input type="text" id="newProjectCode" oninput="this.value=this.value.toUpperCase()">
        <label>Type</label>
        <select id="newProjectType">
            <option value="shot_based"> Shot-Based (sequences & shots)</option>
            <option value="simple"> Simple (flat file list)</option>
        </select>
        <label>Description <span style="color:var(--text-muted);font-size:0.75rem">(optional)</span></label>
        <textarea id="newProjectDesc" rows="2"></textarea>
        <div id="shotBuilderContainer"></div>
        <div class="form-actions">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" onclick="createProject()">Create</button>
        </div>
    `;
    modal.style.display = 'flex';

    renderShotBuilder(document.getElementById('shotBuilderContainer'), null, { code: '', name: '' });

    // Live-update Shot Builder preview when project code changes
    document.getElementById('newProjectCode').addEventListener('input', () => {
        window._sbSetProjectCode?.(document.getElementById('newProjectCode').value.trim());
    });
}

async function createProject() {
    const name = document.getElementById('newProjectName').value.trim();
    const code = document.getElementById('newProjectCode').value.trim();
    const type = document.getElementById('newProjectType').value;
    const description = document.getElementById('newProjectDesc').value.trim();
    const convention = getConvention();

    if (!name || !code) return alert('Name and code are required');

    try {
        const proj = await api('/api/projects', {
            method: 'POST',
            body: { name, code, type, description, naming_convention: convention }
        });
        closeModal();
        loadProjects();
        window.openProject?.(proj.id);
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ===========================================
//  EDIT NAMING CONVENTION MODAL
// ===========================================

function showEditNamingModal(proj) {
    const modal = document.getElementById('modal');
    document.getElementById('modalContent').innerHTML = `
        <h3> Naming Convention - ${esc(proj.name)}</h3>
        <p style="color:var(--text-dim);font-size:0.8rem;margin-bottom:8px;">
            Define how imported files are named for this project.
            Leave empty to use the default ShotGrid-style naming.
        </p>
        <div id="editShotBuilderContainer"></div>
        <div class="form-actions">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" id="saveNamingBtn"> Save Convention</button>
        </div>
    `;
    modal.style.display = 'flex';

    renderShotBuilder(
        document.getElementById('editShotBuilderContainer'),
        proj.naming_convention || null,
        { code: proj.code, name: proj.name }
    );

    document.getElementById('saveNamingBtn').addEventListener('click', async () => {
        const convention = getConvention();
        try {
            await api(`/api/projects/${proj.id}/naming-convention`, {
                method: 'PUT',
                body: { convention }
            });
            closeModal();
            showToast('Naming convention saved');
        } catch (err) {
            alert('Error saving: ' + err.message);
        }
    });
}

// ===========================================
//  EDIT PROJECT MODAL (from Projects tab)
// ===========================================

async function showEditProjectModal(projectId) {
    let proj;
    try {
        proj = await api(`/api/projects/${projectId}`);
    } catch (err) {
        return alert('Error loading project: ' + err.message);
    }

    // Fetch shots for every sequence in parallel
    const seqShotsMap = {};
    if (proj.sequences?.length) {
        const fetches = proj.sequences.map(async s => {
            try {
                seqShotsMap[s.id] = await api(`/api/projects/${proj.id}/sequences/${s.id}/shots`);
            } catch (_) { seqShotsMap[s.id] = []; }
        });
        await Promise.all(fetches);
    }

    // Build sequence + shot HTML
    const seqItems = proj.sequences?.length > 0
        ? proj.sequences.map(s => {
            const shots = seqShotsMap[s.id] || [];
            const shotChips = shots.map(sh =>
                `<span class="ep-shot-chip" title="${esc(sh.name)}">${esc(sh.code)}</span>`
            ).join('');
            const shotRow = shots.length
                ? `<div class="ep-shot-row">${shotChips}</div>`
                : '';
            const nextShotNum = (shots.length + 1) * 10;
            const defaultShotCode = `SH${String(nextShotNum).padStart(3, '0')}`;
            return `<div class="ep-seq-item ep-seq-expandable">
                <div class="ep-seq-main">
                    <span class="badge badge-dim" style="font-size:0.7rem">${esc(s.code)}</span>
                    <span>${esc(s.name)}</span>
                    <span class="ep-seq-count">${s.asset_count || 0} assets - ${shots.length} shot${shots.length !== 1 ? 's' : ''}</span>
                    <button class="btn-xs ep-add-shot-btn" data-seq-id="${s.id}" data-proj-id="${proj.id}" data-default-code="${defaultShotCode}" title="Add shot to ${esc(s.code)}">+ Shot</button>
                </div>
                ${shotRow}
            </div>`;
        }).join('')
        : '<div style="color:var(--text-muted);font-size:0.8rem;padding:4px 0;">No sequences yet - add one below.</div>';

    const modal = document.getElementById('modal');
    document.getElementById('modalContent').innerHTML = `
        <h3>Edit Project - ${esc(proj.name)}</h3>

        <label>Project Name</label>
        <input type="text" id="editProjectName" value="${esc(proj.name)}" autofocus>

        <label>Project Code</label>
        <input type="text" id="editProjectCode" value="${esc(proj.code)}"
            readonly style="opacity:0.6; cursor:not-allowed"
            title="Code cannot be changed (used in folder structure)">

        <label>Episode <span style="color:var(--text-muted);font-size:0.75rem">(used in naming convention - e.g. 301)</span></label>
        <input type="text" id="editProjectEpisode" value="${esc(proj.episode || '')}" placeholder="e.g. 301">

        <label>Description</label>
        <textarea id="editProjectDesc" rows="2">${esc(proj.description || '')}</textarea>

        <div class="ep-section">
            <div class="ep-section-hdr">
                <span> Sequences & Shots</span>
                <button class="btn-sm" id="epAddSeqBtn">+ Sequence</button>
            </div>
            <div class="ep-seq-list">${seqItems}</div>
        </div>

        <div id="editShotBuilderContainer"></div>

        <div class="ep-section" id="epTeamAccessSection" style="display:none;">
            <div class="ep-section-hdr">
                <span> Hide from Users</span>
                <span style="font-size:0.75rem;color:var(--text-muted);">Checked users will NOT see this project</span>
            </div>
            <div id="epTeamCheckboxes" class="ep-team-checkboxes">
                <!-- Populated by JS -->
            </div>
        </div>

        <div class="form-actions">
            <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            <button class="btn-primary" id="saveEditProjectBtn"> Save</button>
        </div>
    `;
    modal.style.display = 'flex';

    // Render Shot Builder with existing convention + project context
    renderShotBuilder(
        document.getElementById('editShotBuilderContainer'),
        proj.naming_convention || null,
        {
            code: proj.code,
            name: proj.name,
            episode: proj.episode || '',
            sequences: (proj.sequences || []).map(s => ({
                name: s.name,
                code: s.code,
                shots: (seqShotsMap[s.id] || []).map(sh => ({ name: sh.name, code: sh.code }))
            }))
        }
    );

    // Live-update preview when episode field changes
    document.getElementById('editProjectEpisode').addEventListener('input', () => {
        window._sbSetEpisode(document.getElementById('editProjectEpisode').value.trim());
    });

    // Populate "Hide from Users" checkboxes (admin only)
    const currentUser = JSON.parse(localStorage.getItem('cam_current_user') || 'null') || state.currentUser;
    const isCurrentAdmin = currentUser?.is_admin || localStorage.getItem('cam_user_is_admin') === '1';
    if (isCurrentAdmin || state.currentUser?.is_admin) {
        const teamSection = document.getElementById('epTeamAccessSection');
        const teamContainer = document.getElementById('epTeamCheckboxes');
        if (teamSection && teamContainer) {
            teamSection.style.display = 'block';
            try {
                const allUsers = await fetch('/api/users').then(r => r.json());
                const hiddenResp = await fetch(`/api/users/project/${proj.id}/hidden`).then(r => r.json());
                const hiddenIds = new Set(hiddenResp.map(u => u.id));
                const nonAdmins = allUsers.filter(u => !u.is_admin);

                if (nonAdmins.length === 0) {
                    teamContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No non-admin users. Create users in Settings -> Team first.</div>';
                } else {
                    teamContainer.innerHTML = nonAdmins.map(u => `
                        <label class="ep-team-check" style="border-left: 3px solid ${u.color || '#888'}">
                            <input type="checkbox" data-user-id="${u.id}" ${hiddenIds.has(u.id) ? 'checked' : ''}>
                            <span>${u.avatar || ''}</span>
                            <span>${esc(u.name)}</span>
                            <span style="font-size:0.72rem;color:var(--text-muted);margin-left:auto;">${hiddenIds.has(u.id) ? ' hidden' : ' visible'}</span>
                        </label>
                    `).join('');
                    teamContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                        cb.addEventListener('change', () => {
                            const hint = cb.closest('.ep-team-check').querySelector('span:last-child');
                            if (hint) hint.textContent = cb.checked ? ' hidden' : ' visible';
                        });
                    });
                }
            } catch (err) {
                teamContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">Could not load team data.</div>';
            }
        }
    }

    // Wire up all "+ Shot" buttons
    document.querySelectorAll('.ep-add-shot-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const seqId = btn.dataset.seqId;
            const projId = btn.dataset.projId;
            const defaultCode = btn.dataset.defaultCode;

            const shotName = prompt('Shot name:');
            if (!shotName?.trim()) return;
            const shotCode = prompt('Shot code (uppercase):', defaultCode);
            if (!shotCode?.trim()) return;

            try {
                await api(`/api/projects/${projId}/sequences/${seqId}/shots`, {
                    method: 'POST',
                    body: { name: shotName.trim(), code: shotCode.trim().toUpperCase() }
                });
                showToast('Shot added');
                showEditProjectModal(projectId); // Refresh modal
            } catch (err) {
                alert('Error: ' + err.message);
            }
        });
    });

    // Add sequence button
    document.getElementById('epAddSeqBtn').addEventListener('click', async () => {
        const nextNum = (proj.sequences?.length || 0) + 1;
        const defaultCode = `SQ${String(nextNum * 10).padStart(3, '0')}`;

        const seqName = prompt('Sequence name:');
        if (!seqName?.trim()) return;
        const seqCode = prompt('Sequence code (uppercase):', defaultCode);
        if (!seqCode?.trim()) return;

        try {
            await api(`/api/projects/${proj.id}/sequences`, {
                method: 'POST',
                body: { name: seqName.trim(), code: seqCode.trim().toUpperCase() }
            });
            showToast('Sequence added');
            showEditProjectModal(proj.id); // Refresh modal
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });

    // Save button
    document.getElementById('saveEditProjectBtn').addEventListener('click', async () => {
        const name = document.getElementById('editProjectName').value.trim();
        const description = document.getElementById('editProjectDesc').value.trim();
        const episode = document.getElementById('editProjectEpisode').value.trim();
        const convention = getConvention();

        if (!name) return alert('Project name is required');

        try {
            await api(`/api/projects/${proj.id}`, {
                method: 'PUT',
                body: { name, description, episode, naming_convention: convention }
            });

            // Save hidden-from users
            const teamCheckboxes = document.querySelectorAll('#epTeamCheckboxes input[data-user-id]');
            if (teamCheckboxes.length > 0) {
                const hiddenUserIds = [...teamCheckboxes]
                    .filter(cb => cb.checked)
                    .map(cb => parseInt(cb.dataset.userId, 10));
                await fetch(`/api/users/project/${proj.id}/hidden`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: hiddenUserIds })
                });
            }

            closeModal();
            showToast('Project updated');
            loadProjects();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });
}

// ===========================================
//  ARCHIVE OPERATIONS
// ===========================================

async function toggleArchiveProject(project) {
    const action = project.archived ? 'unarchive' : 'archive';
    if (!confirm(`${project.archived ? 'Unarchive' : 'Archive'} project "${project.name}"?${!project.archived ? '\n\nArchived projects are hidden from the main view but can be shown anytime.' : ''}`)) return;
    try {
        await api(`/api/projects/${project.id}/archive`, { method: 'PUT' });
        showToast(`Project ${action}d: ${project.name}`);
        await loadProjects();
        await window.loadTree?.();
        if (state.currentProject?.id === project.id && !project.archived) {
            state.currentProject = null;
            window.switchTab?.('projects');
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function toggleShowArchived(checked) {
    showArchived = checked;
    loadProjects();
    window.loadTree?.();
}

async function archiveCurrentProject() {
    if (!state.currentProject) return;
    toggleArchiveProject(state.currentProject);
}

// ===========================================
//  EXPOSE ON WINDOW
// ===========================================

window.loadProjects = loadProjects;
window.showCreateProjectModal = showCreateProjectModal;
window.createProject = createProject;
window.showEditProjectModal = showEditProjectModal;
window.showEditNamingModal = showEditNamingModal;
window.toggleArchiveProject = toggleArchiveProject;
window.toggleShowArchived = toggleShowArchived;
window.archiveCurrentProject = archiveCurrentProject;




