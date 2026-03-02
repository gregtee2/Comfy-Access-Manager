/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * CAM - Browser Orchestrator
 *
 * Thin module that wires together the focused browser sub-modules:
 *   projectView.js  - Project grid, create/edit/archive modals
 *   treeNav.js      - Left-side hierarchy tree navigation
 *   assetGrid.js    - Asset browsing, selection, drag/drop, polling
 *   contextMenus.js - Right-click menus, bulk ops, CRUD modals, Resolve/ComfyUI
 *
 * This file exists so that main.js can keep its single import line:
 *   import { loadProjects, loadTree, initFileDropZone, loadCrates } from './browser.js';
 */

// Sub-module imports
import { loadProjects }          from './projectView.js';
import { loadTree, expandNode }  from './treeNav.js';
import { initFileDropZone }      from './assetGrid.js';
import { loadCrates, getActiveCrateId } from './crate.js';

// Side-effect import: registers all window.* context-menu functions
import './contextMenus.js';

// Cross-module wiring
// assetGrid.openProject() needs to expand a tree node after switching tabs.
// It calls window._treeExpandNode(key) which we wire here to treeNav.expandNode.
window._treeExpandNode = expandNode;

// Expose active crate ID for context menu to check
window._activeCrateId = getActiveCrateId;

// Re-exports for main.js
export { loadProjects, loadTree, initFileDropZone, loadCrates };
