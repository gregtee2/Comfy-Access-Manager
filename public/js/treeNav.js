/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM - Tree Navigation Module
 * Left-side hierarchical tree: projects -> sequences -> shots -> roles.
 */

import { state } from './state.js';
import { api } from './api.js';
import { esc, ensureReadableColor, icon } from './utils.js';
import { isShowArchived } from './projectView.js';
import { clearCrateState } from './crate.js';

// ===========================================
//  MODULE STATE
// ===========================================

let treeData = [];
let treeExpanded = {};  // { 'p_1': true, 'seq_3': true }

/** Expand a tree node programmatically (used by assetGrid.openProject) */
export function expandNode(key) { treeExpanded[key] = true; }

// ===========================================
//  LOAD & RENDER TREE
// ===========================================

export async function loadTree() {
    try {
        treeData = await api(`/api/projects/tree${isShowArchived() ? '?include_archived=1' : ''}`);
        renderTree();
    } catch (err) {
        console.error('Failed to load tree:', err);
        document.getElementById('treeContainer').innerHTML =
            '<div style="color:var(--text-muted);padding:8px;font-size:0.8rem;">Failed to load tree</div>';
    }
}

function refreshTree() { loadTree(); }

const CHEVRON = `<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

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
        const treeIcon = project.type === 'shot_based' ? icon('project') : icon('folder');

        html += `<div class="tree-node ${isActive ? 'tree-active' : ''}" onclick="treeSelectProject(${project.id})"
            oncontextmenu="treeSelectProject(${project.id});showProjectContextMenu(event)">
            <span class="tree-toggle ${isOpen ? 'open' : ''}" onclick="event.stopPropagation();treeToggle('${pKey}')">${hasChildren ? CHEVRON : ''}</span>
            <span class="tree-icon">${treeIcon}</span>
            <span class="tree-label">${esc(project.name)}</span>
            <span class="tree-count">${project.asset_count}</span>
        </div>`;

        if (isOpen && hasChildren) {
            for (const seq of project.sequences) {
                const sKey = `seq_${seq.id}`;
                const sOpen = treeExpanded[sKey];
                const sActive = state.currentSequence?.id === seq.id && !state.currentShot;
                const sHasChildren = seq.shots.length > 0;

                const sHasRoles = !sHasChildren && seq.roles && seq.roles.length > 0;
                const sExpandable = sHasChildren || sHasRoles;

                html += `<div class="tree-node tree-indent-1 ${sActive ? 'tree-active' : ''}" onclick="treeSelectSequence(${project.id}, ${seq.id})"
                    oncontextmenu="showSeqContextMenu(event, ${seq.id}, '${esc(seq.name).replace(/'/g, "\\'")}')"
                    ondragover="onSeqDragOver(event)" ondragleave="onSeqDragLeave(event)"
                    ondrop="onSeqDrop(event, ${seq.id}, ${project.id})">
                    <span class="tree-toggle ${sOpen ? 'open' : ''}" onclick="event.stopPropagation();treeToggle('${sKey}')">${sExpandable ? CHEVRON : ''}</span>
                    <span class="tree-icon">${icon('sequence')}</span>
                    <span class="tree-label">${esc(seq.name)}</span>
                    <span class="tree-count">${seq.asset_count}</span>
                </div>`;

                // Sequence-level roles (when no shots exist)
                if (sOpen && sHasRoles) {
                    for (const role of seq.roles) {
                        const rActive = state.currentRole?.id === role.role_id && state.currentSequence?.id === seq.id && !state.currentShot;
                        const roleColor = ensureReadableColor(role.role_color);
                        html += `<div class="tree-node tree-indent-2 ${rActive ? 'tree-active' : ''}" onclick="treeSelectSeqRole(${project.id}, ${seq.id}, ${role.role_id})">
                            <span class="tree-toggle"></span>
                            <span class="tree-icon">${role.role_icon || icon('role')}</span>
                            <span class="tree-label" style="color:${roleColor}">${esc(role.role_name)}</span>
                            <span class="tree-count">${role.asset_count}</span>
                        </div>`;
                    }
                }

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
                            <span class="tree-toggle ${shOpen ? 'open' : ''}" onclick="event.stopPropagation();treeToggle('${shKey}')">${shHasRoles ? CHEVRON : ''}</span>
                            <span class="tree-icon">${icon('shot')}</span>
                            <span class="tree-label">${esc(shot.name)}</span>
                            <span class="tree-count">${shot.asset_count}</span>
                        </div>`;

                        if (shOpen && shHasRoles) {
                            for (const role of shot.roles) {
                                const rActive = state.currentRole?.id === role.role_id && state.currentShot?.id === shot.id;
                                const roleColor = ensureReadableColor(role.role_color);
                                html += `<div class="tree-node tree-indent-3 ${rActive ? 'tree-active' : ''}" onclick="treeSelectRole(${project.id}, ${seq.id}, ${shot.id}, ${role.role_id})">
                                    <span class="tree-toggle"></span>
                                    <span class="tree-icon">${role.role_icon || icon('role')}</span>
                                    <span class="tree-label" style="color:${roleColor}">${esc(role.role_name)}</span>
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

// ===========================================
//  TREE INTERACTION
// ===========================================

function treeToggle(key) {
    treeExpanded[key] = !treeExpanded[key];
    renderTree();
}

async function treeSelectProject(projectId) {
    clearCrateState();  // Exit crate view if active
    treeExpanded[`p_${projectId}`] = true;

    try {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
        state.currentSequence = null;
        state.currentShot = null;
        state.currentRole = null;
        state.selectedAssets = [];
        state.lastClickedAsset = -1;

        window.renderProjectDetail?.(project);
        window.loadProjectAssets?.(project.id);
        renderTree();
    } catch (err) {
        console.error('Failed to select project:', err);
    }
}

async function treeSelectSequence(projectId, seqId) {
    clearCrateState();  // Exit crate view if active
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

    window.renderProjectDetail?.(state.currentProject);
    window.loadProjectAssets?.(state.currentProject.id);
    renderTree();
}

async function treeSelectShot(projectId, seqId, shotId) {
    clearCrateState();  // Exit crate view if active
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

    window.renderProjectDetail?.(state.currentProject);
    window.loadProjectAssets?.(state.currentProject.id);
    renderTree();
}

async function treeSelectRole(projectId, seqId, shotId, roleId) {
    clearCrateState();  // Exit crate view if active
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

    window.renderProjectDetail?.(state.currentProject);
    window.loadProjectAssets?.(state.currentProject.id);
    renderTree();
}

async function treeSelectSeqRole(projectId, seqId, roleId) {
    clearCrateState();  // Exit crate view if active
    if (!state.currentProject || state.currentProject.id !== projectId) {
        const project = await api(`/api/projects/${projectId}`);
        state.currentProject = project;
    }

    const seq = state.currentProject.sequences?.find(s => s.id === seqId);
    state.currentSequence = seq || { id: seqId };
    state.currentShot = null;

    try {
        const roles = await api('/api/roles');
        state.currentRole = roles.find(r => r.id === roleId) || { id: roleId };
    } catch {
        state.currentRole = { id: roleId };
    }

    state.selectedAssets = [];

    treeExpanded[`p_${projectId}`] = true;
    treeExpanded[`seq_${seqId}`] = true;

    window.renderProjectDetail?.(state.currentProject);
    window.loadProjectAssets?.(state.currentProject.id);
    renderTree();
}

// ===========================================
//  EXPOSE ON WINDOW
// ===========================================

window.loadTree = loadTree;
window.refreshTree = refreshTree;
window.treeSelectProject = treeSelectProject;
window.treeSelectSequence = treeSelectSequence;
window.treeSelectShot = treeSelectShot;
window.treeSelectRole = treeSelectRole;
window.treeSelectSeqRole = treeSelectSeqRole;
window.treeToggle = treeToggle;

