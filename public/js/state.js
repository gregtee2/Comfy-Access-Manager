/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * DMV - Global State
 * Single source of truth for all application state.
 */

export const state = {
    currentTab: 'projects',
    currentProject: null,
    currentSequence: null,
    currentShot: null,
    currentRole: null,       // Selected role filter { id, name, code, color, icon }
    projects: [],
    assets: [],
    roles: [],               // Global roles list from /api/roles
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

