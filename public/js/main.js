/**
 * Digital Media Vault - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Digital Media Vault (DMV) — Main Entry Point
 * Tab switching, initialization, vault setup.
 * All other logic is in feature modules.
 */

import { state } from './state.js';
import { api } from './api.js';
import { loadProjects, loadTree, initFileDropZone } from './browser.js';
import { loadImportTab } from './import.js';
import { loadSettings, loadRoles, openFolderPicker, autoCheckForUpdates } from './settings.js';
import './export.js';

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    initFileDropZone();
    await checkSetup();
});

async function checkSetup() {
    try {
        const status = await api('/api/settings/status');
        state.settings = await api('/api/settings');

        document.getElementById('assetCount').textContent = `${status.assets} assets`;
        document.getElementById('appVersion').textContent = status.version ? `v${status.version}` : '';
        document.getElementById('statusIndicator').className = 'status-dot' + (status.vaultConfigured ? '' : ' warning');

        if (!status.vaultConfigured) {
            document.getElementById('setupOverlay').style.display = 'flex';
        } else {
            document.getElementById('setupOverlay').style.display = 'none';
            loadProjects();
            loadSettings();
            loadRoles();
            autoCheckForUpdates();  // Silent check — shows notification only if update available
        }
    } catch (err) {
        console.error('Setup check failed:', err);
    }
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
    if (tab === 'settings') { loadSettings(); loadRoles(); }
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

function browseForVault() {
    openFolderPicker('setupVaultPath');
}

// ═══════════════════════════════════════════
//  EXPOSE ON WINDOW
// ═══════════════════════════════════════════
window.switchTab = switchTab;
window.checkSetup = checkSetup;
window.setupVault = setupVault;
window.browseForVault = browseForVault;
