/**
 * Flow Production Tracking — Context Menu Module
 * Adds "Publish to Flow" to the asset right-click menu.
 *
 * Exports: getMenuItems(context) — returns array of menu items
 */

import { api } from '/js/api.js';

/** Cache Flow configured state (checked once per session) */
let _flowConfigured = null;

async function checkFlowConfigured() {
    if (_flowConfigured !== null) return _flowConfigured;
    try {
        const result = await api('/api/flow/status');
        _flowConfigured = !!result.configured;
    } catch {
        _flowConfigured = false;
    }
    return _flowConfigured;
}

/**
 * Return context menu items for the Flow plugin.
 * @param {object} context - { isSingle, count, asset, assets, formats }
 * @returns {object[]} Array of menu items
 */
export function getMenuItems(context) {
    // Only show Flow menu items — they'll handle their own async checks
    return [
        {
            id: 'flow-publish',
            label: '🔀 Publish to Flow',
            action: 'flow-publish',
            separator: true, // show separator before this group
        },
    ];
}

/**
 * Handle the "Publish to Flow" action.
 * Shows a modal to pick project, shot, and optional description.
 * @param {number[]} assetIds - Selected asset IDs
 */
export async function handlePublishToFlow(assetIds) {
    const configured = await checkFlowConfigured();
    if (!configured) {
        window.showToast?.('Flow not configured. Add credentials in Settings → Flow Production Tracking.', 'warn');
        return;
    }

    // Fetch project mappings (projects linked to Flow)
    let mappings = [];
    try {
        mappings = await api('/api/flow/mappings/projects');
    } catch {
        window.showToast?.('Failed to load Flow project mappings', 'error');
        return;
    }

    if (!mappings || mappings.length === 0) {
        window.showToast?.('No projects linked to Flow. Sync projects first in Settings.', 'warn');
        return;
    }

    // Build publish modal
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.id = 'flowPublishOverlay';

    const count = assetIds.length;
    const plural = count > 1 ? `${count} assets` : '1 asset';

    overlay.innerHTML = `
        <div class="modal" style="max-width:420px;">
            <div class="modal-header">
                <span>🔀 Publish to Flow</span>
                <button class="modal-close" onclick="document.getElementById('flowPublishOverlay')?.remove()">✕</button>
            </div>
            <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;">
                <p style="margin:0;font-size:0.85rem;color:var(--text-dim);">Publishing ${plural} to Flow Production Tracking</p>
                <label style="font-size:0.82rem;">Flow Project</label>
                <select id="flowPublishProject" class="setting-select">
                    ${mappings.map(p => `<option value="${p.flow_id}|${p.id}">${p.name} (${p.code})</option>`).join('')}
                </select>
                <label style="font-size:0.82rem;">Description <span style="color:var(--text-dim)">(optional)</span></label>
                <input type="text" id="flowPublishDesc" placeholder="Published from CAM" style="width:100%;box-sizing:border-box;">

                <label style="font-size:0.82rem;">
                    <input type="checkbox" id="flowPublishUploadThumb" checked> Upload thumbnail
                </label>

                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
                    <button onclick="document.getElementById('flowPublishOverlay')?.remove()" style="opacity:0.7;">Cancel</button>
                    <button id="flowPublishSubmit" style="background:var(--accent);color:#fff;font-weight:600;">Publish</button>
                </div>
                <div id="flowPublishStatus" style="font-size:0.82rem;color:var(--text-dim);"></div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Wire submit
    document.getElementById('flowPublishSubmit').addEventListener('click', async () => {
        const select = document.getElementById('flowPublishProject');
        const [flowProjectId, localProjectId] = select.value.split('|').map(Number);
        const description = document.getElementById('flowPublishDesc')?.value || '';
        const uploadThumbnail = document.getElementById('flowPublishUploadThumb')?.checked ?? true;
        const statusEl = document.getElementById('flowPublishStatus');
        const submitBtn = document.getElementById('flowPublishSubmit');

        submitBtn.disabled = true;
        statusEl.textContent = `Publishing ${plural}…`;

        let success = 0;
        let failed = 0;

        for (const assetId of assetIds) {
            try {
                await api('/api/flow/publish/version', {
                    method: 'POST',
                    body: {
                        assetId,
                        flowProjectId,
                        description: description || 'Published from Comfy Asset Manager',
                        uploadThumbnail,
                    },
                });
                success++;
                statusEl.textContent = `Published ${success}/${count}…`;
            } catch (err) {
                failed++;
                console.warn(`[Flow] Publish failed for asset ${assetId}:`, err.message);
            }
        }

        if (failed === 0) {
            statusEl.innerHTML = `<span style="color:var(--success)">✅ Published ${success} asset${success > 1 ? 's' : ''} to Flow</span>`;
        } else {
            statusEl.innerHTML = `<span style="color:var(--warning)">⚠️ ${success} published, ${failed} failed</span>`;
        }

        submitBtn.textContent = 'Done';
        submitBtn.disabled = false;
        submitBtn.onclick = () => overlay.remove();

        // Show toast
        window.showToast?.(`Published ${success} asset${success > 1 ? 's' : ''} to Flow`, success > 0 ? 'success' : 'error');
    });
}
