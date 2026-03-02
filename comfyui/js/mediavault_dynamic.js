/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault Dynamic Dropdowns for ComfyUI
 *
 * When you change Project, Sequence, Shot or Role on a MediaVault node,
 * this extension re-queries the MediaVault API and updates the downstream
 * dropdowns so you only see assets that match your selection.
 */
import { app } from "../../../scripts/app.js";

const MV_NODES = [
    "LoadFromMediaVault",
    "LoadVideoFrameFromMediaVault",
    "LoadVideoFromMediaVault",
    "SaveToMediaVault",
];

// Nodes that should show an asset thumbnail preview
const PREVIEW_NODES = ["LoadFromMediaVault", "LoadVideoFrameFromMediaVault", "LoadVideoFromMediaVault"];

// Nodes that should show video info (frame count, fps, resolution)
const VIDEO_INFO_NODES = ["LoadVideoFromMediaVault"];

// ── helpers ──────────────────────────────────────────────
function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

/** Parse "SomeName (CODE)" → the value stored in options (the display string itself) */
function getSelectedId(widget) {
    return widget?.value ?? null;
}

/**
 * Fetch JSON from a ComfyUI-side route that proxies to MediaVault.
 * Routes are registered in mediavault_node.py via PromptServer.
 */
async function mvFetch(path) {
    try {
        const res = await fetch(path);
        if (!res.ok) return [];
        const data = await res.json();
        return data ?? [];
    } catch (e) {
        console.warn("[MediaVault] fetch error:", path, e);
        return [];
    }
}

// ── Update helpers ──────────────────────────────────────
function updateComboWidget(widget, newValues, keepValue = true) {
    if (!widget) return;
    const old = widget.value;
    widget.options.values = newValues;
    if (keepValue && old && typeof old === "string") {
        if (newValues.includes(old)) {
            // Exact match found — keep it
            widget.value = old;
        } else if (!old.startsWith("(Load") && old !== "No assets found") {
            // Saved value not in live list (server data changed?) — inject it
            // so the user sees what was saved and can manually update if needed
            widget.options.values = [...newValues, old];
            widget.value = old;
        } else if (newValues.length > 0) {
            widget.value = newValues[0];
        }
    } else if (newValues.length > 0) {
        widget.value = newValues[0];
    }
}

// ── Cascade logic ───────────────────────────────────────
/**
 * Given the current hierarchy selections on a node, re-fetch the
 * relevant downstream dropdowns.
 *
 * @param {*} node   The LiteGraph node
 * @param {string} changedWidget  Which widget just changed
 */
async function cascadeUpdate(node, changedWidget) {
    const projW = findWidget(node, "project");
    const seqW  = findWidget(node, "sequence");
    const shotW = findWidget(node, "shot");
    const roleW = findWidget(node, "role");
    const assetW = findWidget(node, "asset");

    // Resolve the project display name → id
    const projDisplay = projW?.value ?? "";
    const projId  = await resolveId("/mediavault/projects", projDisplay);

    // Build query params from the current selections
    const seqDisplay  = seqW?.value ?? "";
    const shotDisplay = shotW?.value ?? "";
    const roleDisplay = roleW?.value ?? "";

    // ── When project changes: refresh sequences, shots, assets ──
    if (changedWidget === "project") {
        // Refresh sequences for this project
        const seqs = await mvFetch(`/mediavault/sequences?project_id=${projId}`);
        const seqNames = ["* (All Sequences)", ...seqs.map(s => `${s.name} (${s.code})`)];
        updateComboWidget(seqW, seqNames, false);

        // Refresh shots for this project
        const shots = await mvFetch(`/mediavault/shots?project_id=${projId}`);
        const shotNames = ["* (All Shots)", ...shots.map(s => `${s.name} (${s.code})`)];
        updateComboWidget(shotW, shotNames, false);

        // Re-fetch assets with only project filter
        await refreshAssets(node, projId, "0", "0", "0");
        return;
    }

    // ── Sequence changed: refresh shots + assets ──
    if (changedWidget === "sequence") {
        const seqId = await resolveId("/mediavault/sequences", seqDisplay);

        const shots = await mvFetch(
            `/mediavault/shots?project_id=${projId}&sequence_id=${seqId}`
        );
        const shotNames = ["* (All Shots)", ...shots.map(s => `${s.name} (${s.code})`)];
        updateComboWidget(shotW, shotNames, false);

        const roleId = await resolveId("/mediavault/roles", roleDisplay);
        await refreshAssets(node, projId, seqId, "0", roleId);
        return;
    }

    // ── Shot or Role changed: just refresh assets ──
    if (changedWidget === "shot" || changedWidget === "role") {
        const seqId  = await resolveId("/mediavault/sequences", seqDisplay);
        const shotId = await resolveId("/mediavault/shots", shotDisplay);
        const roleId = await resolveId("/mediavault/roles", roleDisplay);
        await refreshAssets(node, projId, seqId, shotId, roleId);
        return;
    }
}

/**
 * Re-fetch assets matching the given hierarchy IDs and update the asset widget.
 */
async function refreshAssets(node, projId, seqId, shotId, roleId) {
    const assetW = findWidget(node, "asset");
    if (!assetW) return;

    let url = `/mediavault/assets?project_id=${projId}`;
    if (seqId && seqId !== "0") url += `&sequence_id=${seqId}`;
    if (shotId && shotId !== "0") url += `&shot_id=${shotId}`;
    if (roleId && roleId !== "0") url += `&role_id=${roleId}`;

    const assets = await mvFetch(url);

    // Store asset ID map for preview lookups (includes dimensions for resolution label)
    node._mvAssetMap = {};
    for (const a of assets) {
        node._mvAssetMap[a.vault_name] = { id: a.id, width: a.width, height: a.height };
    }

    const names = assets.map(a => a.vault_name);
    if (names.length === 0) names.push("No assets found");

    updateComboWidget(assetW, names, true);

    // Update thumbnail preview
    updateNodePreview(node);

    node.setDirtyCanvas?.(true);
}

/**
 * Resolve a display string like "Anim (ANIM)" → numeric id by
 * looking it up in the list returned by the endpoint.
 * Returns "0" for wildcard / not found.
 */
async function resolveId(endpoint, displayName) {
    if (!displayName || displayName.startsWith("*")) return "0";

    const list = await mvFetch(endpoint);
    for (const item of list) {
        const label = `${item.name} (${item.code})`;
        if (label === displayName) return String(item.id);
    }
    return "0";
}

// ── Asset Preview ───────────────────────────────────────

/**
 * Custom widget that draws a thumbnail preview of the selected asset
 * directly on the node canvas. Integrates with LiteGraph's widget
 * layout system so the node auto-resizes to fit.
 */
function addPreviewWidget(node) {
    const widget = {
        name: "mv_preview",
        type: "MEDIAVAULT_PREVIEW",
        value: "",
        serialize: false,
        options: { serialize: false },
        draw(ctx, _node, widgetWidth, y, widgetHeight) {
            if (!_node._mvPreviewReady || !_node._mvPreviewImg) return;
            const img = _node._mvPreviewImg;
            const pad = 6;
            const maxW = widgetWidth - pad * 2;
            const aspect = img.naturalHeight / img.naturalWidth;
            const maxH = 250;
            let dw = maxW, dh = maxW * aspect;
            if (dh > maxH) { dh = maxH; dw = maxH / aspect; }
            const offsetX = pad + (maxW - dw) / 2;

            // Dark background
            ctx.fillStyle = "#1a1a1a";
            ctx.roundRect
                ? (ctx.beginPath(), ctx.roundRect(pad, y + 4, maxW, dh + 2, 4), ctx.fill())
                : ctx.fillRect(pad, y + 4, maxW, dh + 2);

            // Draw image centered
            ctx.drawImage(img, offsetX, y + 5, dw, dh);

            // Subtle border
            ctx.strokeStyle = "#555";
            ctx.lineWidth = 1;
            ctx.strokeRect(pad, y + 4, maxW, dh + 2);

            // Resolution label below thumbnail
            const assetInfo = _node._mvPreviewAssetInfo;
            if (assetInfo && assetInfo.width && assetInfo.height) {
                const resText = `${assetInfo.width} × ${assetInfo.height}`;
                ctx.fillStyle = "#999";
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(resText, widgetWidth / 2, y + dh + 18);
                ctx.textAlign = "left";
            }
        },
        computeSize(width) {
            if (!node._mvPreviewReady || !node._mvPreviewImg) return [width, 4];
            const img = node._mvPreviewImg;
            const pad = 6;
            const maxW = width - pad * 2;
            const aspect = img.naturalHeight / img.naturalWidth;
            const maxH = 250;
            let dh = Math.min(maxW * aspect, maxH);
            return [width, dh + 26];
        },
    };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
    return widget;
}

/**
 * Load a thumbnail preview for the currently-selected asset.
 * Uses the node._mvAssetMap to resolve vault_name → asset id,
 * then fetches the thumbnail through the ComfyUI proxy route.
 */
function updateNodePreview(node) {
    if (!PREVIEW_NODES.includes(node.comfyClass)) return;

    const assetW = findWidget(node, "asset");
    if (!assetW) return;

    const assetName = assetW.value;
    const assetEntry = node._mvAssetMap?.[assetName];
    const assetId = assetEntry?.id ?? assetEntry;  // backwards compat if plain id

    // Store dimensions for the resolution label
    node._mvPreviewAssetInfo = assetEntry && typeof assetEntry === 'object' ? assetEntry : null;

    if (!assetId || assetName === "No assets found") {
        node._mvPreviewReady = false;
        node.setDirtyCanvas?.(true);
        return;
    }

    // Create the Image element once, reuse on subsequent calls
    if (!node._mvPreviewImg) {
        node._mvPreviewImg = new Image();
        node._mvPreviewImg.crossOrigin = "anonymous";
        node._mvPreviewImg.onload = () => {
            node._mvPreviewReady = true;
            // Resize the node to fit ALL widgets (preview + refresh button)
            const sz = node.computeSize();
            node.setSize([Math.max(node.size[0], sz[0]), Math.max(node.size[1], sz[1])]);
            node.setDirtyCanvas?.(true, true);
        };
        node._mvPreviewImg.onerror = () => {
            node._mvPreviewReady = false;
            node.setDirtyCanvas?.(true);
        };
    }

    node._mvPreviewReady = false;
    node._mvPreviewImg.src = `/mediavault/thumbnail/${assetId}?t=${Date.now()}`;
}

/**
 * For saved workflows: resolve the current asset name to an ID
 * (we don't have the map yet because refreshAssets hasn't run).
 */
async function resolveAssetIdAndPreview(node) {
    const assetW = findWidget(node, "asset");
    if (!assetW || !assetW.value || assetW.value === "No assets found") return;

    const assets = await mvFetch("/mediavault/assets");
    node._mvAssetMap = {};
    for (const a of assets) {
        node._mvAssetMap[a.vault_name] = { id: a.id, width: a.width, height: a.height };
    }
    updateNodePreview(node);
}

// ── Video Info Widget (frame count, fps, resolution, duration) ──

/**
 * Probe a video asset via the ComfyUI proxy and return metadata.
 * Returns { frame_count, fps, width, height, duration } or null on error.
 */
async function probeVideo(assetId) {
    try {
        const res = await fetch(`/mediavault/probe-video/${assetId}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.warn("[MediaVault] probe-video error:", e);
        return null;
    }
}

/**
 * Custom widget that displays video metadata (frame count, fps, resolution, duration)
 * directly on the node canvas. Shows info from the probe API so the user knows
 * the video dimensions before execution.
 */
function addVideoInfoWidget(node) {
    if (node.widgets?.find(w => w.name === "mv_video_info")) return;

    const widget = {
        name: "mv_video_info",
        type: "MEDIAVAULT_VIDEO_INFO",
        value: "",
        serialize: false,
        options: { serialize: false },

        draw(ctx, _node, widgetWidth, y) {
            const info = _node._mvVideoInfo;
            if (!info) return;

            const pad = 8;
            const boxW = widgetWidth - pad * 2;
            const boxH = 38;
            const top = y + 2;

            // Dark background
            ctx.fillStyle = "#1a1a2e";
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(pad, top, boxW, boxH, 4);
                ctx.fill();
            } else {
                ctx.fillRect(pad, top, boxW, boxH);
            }

            // Subtle border
            ctx.strokeStyle = "#444";
            ctx.lineWidth = 1;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(pad, top, boxW, boxH, 4);
                ctx.stroke();
            } else {
                ctx.strokeRect(pad, top, boxW, boxH);
            }

            // Line 1: frame count + fps
            const frames = info.frame_count || 0;
            const fps = info.fps || 0;
            const dur = info.duration || 0;
            const line1 = `\u{1F3AC} ${frames} frames \u00B7 ${fps} fps \u00B7 ${dur.toFixed(2)}s`;

            ctx.fillStyle = "#ddd";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(line1, widgetWidth / 2, top + 15);

            // Line 2: resolution
            const w = info.width || 0;
            const h = info.height || 0;
            const line2 = `${w} \u00D7 ${h}`;
            ctx.fillStyle = "#999";
            ctx.fillText(line2, widgetWidth / 2, top + 30);
            ctx.textAlign = "left";
        },

        computeSize(width) {
            if (!node._mvVideoInfo) return [width, 4];
            return [width, 44];
        },
    };

    node.widgets = node.widgets || [];

    // Insert BEFORE the refresh button and preview widget
    // so it appears right after the input fields
    const refreshIdx = node.widgets.findIndex(w => w.name === REFRESH_BTN_NAME);
    const previewIdx = node.widgets.findIndex(w => w.name === "mv_preview");
    const insertAt = Math.min(
        refreshIdx >= 0 ? refreshIdx : node.widgets.length,
        previewIdx >= 0 ? previewIdx : node.widgets.length
    );
    node.widgets.splice(insertAt, 0, widget);

    return widget;
}

/**
 * Probe the selected asset and update the video info widget.
 * Called when an asset is selected on a LoadVideoFromMediaVault node.
 */
async function updateVideoInfo(node) {
    if (!VIDEO_INFO_NODES.includes(node.comfyClass)) return;

    const assetW = findWidget(node, "asset");
    if (!assetW) return;

    const assetName = assetW.value;
    const assetEntry = node._mvAssetMap?.[assetName];
    const assetId = assetEntry?.id ?? assetEntry;

    if (!assetId || assetName === "No assets found" || assetName === "(Select project first)") {
        node._mvVideoInfo = null;
        node.setDirtyCanvas?.(true);
        return;
    }

    const info = await probeVideo(assetId);
    node._mvVideoInfo = info;

    // Resize node to fit the new widget
    const sz = node.computeSize();
    node.setSize([Math.max(node.size[0], sz[0]), Math.max(node.size[1], sz[1])]);
    node.setDirtyCanvas?.(true, true);
}

// ── Auto-sync Save node from Load node ──────────────────
const LOAD_NODE_TYPES = ["LoadFromMediaVault", "LoadVideoFrameFromMediaVault", "LoadVideoFromMediaVault"];

/**
 * Scan the graph for the first MediaVault Load node that has a real
 * Project/Sequence/Shot set, and copy those values onto the Save node.
 * This gives the user a head-start — they only need to pick the Role.
 */
async function prefillFromLoadNode(saveNode) {
    const allNodes = app.graph._nodes || [];
    const loadNode = allNodes.find(n =>
        LOAD_NODE_TYPES.includes(n.comfyClass) &&
        findWidget(n, "project")?.value &&
        !findWidget(n, "project").value.startsWith("*")
    );
    if (!loadNode) return;

    const widgetsToSync = ["project", "sequence", "shot"];
    let synced = false;

    for (const wName of widgetsToSync) {
        const srcWidget = findWidget(loadNode, wName);
        const dstWidget = findWidget(saveNode, wName);
        if (!srcWidget || !dstWidget) continue;

        const srcVal = srcWidget.value;
        if (!srcVal || srcVal.startsWith("*")) continue;

        if (!dstWidget.options.values.includes(srcVal)) {
            dstWidget.options.values.push(srcVal);
        }
        dstWidget.value = srcVal;
        synced = true;
    }

    if (synced) {
        await cascadeUpdate(saveNode, "project");
        // Re-apply sequence and shot after cascade (it resets them)
        for (const wName of ["sequence", "shot"]) {
            const srcWidget = findWidget(loadNode, wName);
            const dstWidget = findWidget(saveNode, wName);
            if (srcWidget && dstWidget && srcWidget.value && !srcWidget.value.startsWith("*")) {
                if (!dstWidget.options.values.includes(srcWidget.value)) {
                    dstWidget.options.values.push(srcWidget.value);
                }
                dstWidget.value = srcWidget.value;
            }
        }
        saveNode.setDirtyCanvas?.(true);
        console.log("[MediaVault] ✓ Save node pre-filled from:", loadNode.title || loadNode.comfyClass);
    }
}

// ── Refresh button (custom-rendered, placed above preview) ──
const REFRESH_BTN_NAME = "🔄 Refresh Assets";

/**
 * Execute the refresh action: re-query projects, roles, and cascade.
 */
async function doRefreshAction(node) {
    const projW = findWidget(node, "project");
    if (projW) {
        const projects = await mvFetch("/mediavault/projects");
        const projNames = projects.map(p => `${p.name} (${p.code})`);
        if (projNames.length > 0) updateComboWidget(projW, projNames, true);
    }
    const roleW = findWidget(node, "role");
    if (roleW) {
        const roles = await mvFetch("/mediavault/roles");
        const roleNames = roles.map(r => `${r.name} (${r.code})`);
        if (roleNames.length > 0) updateComboWidget(roleW, roleNames, true);
    }
    await cascadeUpdate(node, "project");
    // Ensure node is large enough for all widgets after thumbnail loads
    requestAnimationFrame(() => {
        const sz = node.computeSize();
        if (sz[1] > node.size[1]) node.setSize([node.size[0], sz[1]]);
        node.setDirtyCanvas?.(true);
    });
}

/**
 * Add the Refresh Assets button as a custom-rendered widget.
 * Uses type "MEDIAVAULT_REFRESH" (not "button") so ComfyUI won't strip
 * it during widget lifecycle events. Handles its own drawing and click
 * detection. Placed BEFORE the preview widget so it stays visible above
 * the thumbnail.
 */
function addRefreshButton(node) {
    if (node.widgets?.find(w => w.name === REFRESH_BTN_NAME)) return;

    const btn = {
        name: REFRESH_BTN_NAME,
        type: "MEDIAVAULT_REFRESH",
        value: null,
        serialize: false,
        options: { serialize: false },
        _clicking: false,

        draw(ctx, _node, widgetWidth, y) {
            const pad = 8;
            const btnW = widgetWidth - pad * 2;
            const btnH = 24;
            const top = y + 2;

            // Store position for click hit-testing
            _node._mvRefreshBtnY = top;
            _node._mvRefreshBtnH = btnH;

            // Background
            ctx.fillStyle = this._clicking ? "#555" : "#383838";
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(pad, top, btnW, btnH, 4);
                ctx.fill();
            } else {
                ctx.fillRect(pad, top, btnW, btnH);
            }

            // Border
            ctx.strokeStyle = this._clicking ? "#888" : "#555";
            ctx.lineWidth = 1;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(pad, top, btnW, btnH, 4);
                ctx.stroke();
            } else {
                ctx.strokeRect(pad, top, btnW, btnH);
            }

            // Label
            ctx.fillStyle = "#ccc";
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("\u{1F504} Refresh Assets", widgetWidth / 2, top + 16);
            ctx.textAlign = "left";
        },

        computeSize(width) {
            return [width, 28];
        },

        mouse(event, pos, _node) {
            if (event.type === "pointerdown" || event.type === "mousedown") {
                this._clicking = true;
                _node.setDirtyCanvas(true);
                doRefreshAction(_node).finally(() => {
                    this._clicking = false;
                    _node.setDirtyCanvas(true);
                });
                return true;
            }
            return false;
        },
    };

    node.widgets = node.widgets || [];
    // Insert BEFORE the preview widget so button stays visible above thumbnail
    const previewIdx = node.widgets.findIndex(w => w.name === "mv_preview");
    if (previewIdx >= 0) {
        node.widgets.splice(previewIdx, 0, btn);
    } else {
        node.widgets.push(btn);
    }
}

/**
 * Ensure the refresh button exists on the node.
 * Micro-delay lets LiteGraph finish any widget rebuild first.
 */
function ensureRefreshButton(node) {
    setTimeout(() => addRefreshButton(node), 100);
}

// ── Workflow restore (serialization fix) ─────────────────

/**
 * After restoring saved dropdown values, fetch live data from MediaVault
 * while KEEPING the restored selections. Unlike cascadeUpdate() which
 * resets downstream widgets, this preserves all saved values.
 */
async function restoreLiveDropdowns(node) {
    const projW  = findWidget(node, "project");
    const seqW   = findWidget(node, "sequence");
    const shotW  = findWidget(node, "shot");
    const roleW  = findWidget(node, "role");

    if (!projW) return;

    // Save the restored values before any updates overwrite them
    const savedProj = projW?.value;
    const savedSeq  = seqW?.value;
    const savedShot = shotW?.value;
    const savedRole = roleW?.value;

    // 1. Fetch projects and update dropdown (keepValue=true preserves saved)
    const projects = await mvFetch("/mediavault/projects");
    if (projects.length > 0) {
        const projNames = projects.map(p => `${p.name} (${p.code})`);
        updateComboWidget(projW, projNames, true);
    } else {
        // Server unreachable or no projects — keep saved value as-is
        console.warn("[MediaVault] restoreLiveDropdowns: no projects returned, keeping saved values");
        return;
    }

    // Ensure saved project value is still set (updateComboWidget may have kept it)
    if (projW.value !== savedProj && savedProj && !savedProj.startsWith("(Load")) {
        // Force it back — the saved value is more important than a fresh fetch
        if (!projW.options.values.includes(savedProj)) {
            projW.options.values.push(savedProj);
        }
        projW.value = savedProj;
    }

    const projId = await resolveId("/mediavault/projects", savedProj);
    if (projId === "0") return;

    // 2. Fetch sequences for this project
    if (seqW) {
        const seqs = await mvFetch(`/mediavault/sequences?project_id=${projId}`);
        const seqNames = ["* (All Sequences)", ...seqs.map(s => `${s.name} (${s.code})`)];
        updateComboWidget(seqW, seqNames, true);
    }

    // 3. Fetch shots
    const seqId = await resolveId("/mediavault/sequences", savedSeq);
    if (shotW) {
        const shots = await mvFetch(
            `/mediavault/shots?project_id=${projId}&sequence_id=${seqId}`
        );
        const shotNames = ["* (All Shots)", ...shots.map(s => `${s.name} (${s.code})`)];
        updateComboWidget(shotW, shotNames, true);
    }

    // 4. Fetch roles
    if (roleW) {
        const roles = await mvFetch("/mediavault/roles");
        const roleNames = ["* (All Roles)", ...roles.map(r => `${r.name} (${r.code})`)];
        updateComboWidget(roleW, roleNames, true);
    }

    // 5. For Load nodes: refresh asset list (preserving saved asset selection)
    const assetW = findWidget(node, "asset");
    if (assetW) {
        const shotId = await resolveId("/mediavault/shots", savedShot);
        const roleId = await resolveId("/mediavault/roles", savedRole);
        await refreshAssets(node, projId, seqId, shotId, roleId);
    }

    node.setDirtyCanvas?.(true);
    console.log(`[MediaVault] ✓ Restored dropdowns for ${node.comfyClass}: ${savedProj}`);
}

// ── Extension registration ──────────────────────────────
app.registerExtension({
    name: "MediaVault.DynamicDropdowns",

    /**
     * setup() runs after the ComfyUI graph is initialized.
     * - Starts a lightweight poll for "Send to ComfyUI" assets (every 3s)
     * - If URL contains ?cam_load=1, fetches pending workflow
     */
    async setup() {
        // ── Tab identity: each ComfyUI tab gets a unique ID ──
        // The most-recently-focused tab claims "active" status so that
        // "Send to ComfyUI" only delivers to one tab (not a random race).
        const MV_TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        console.log(`[MediaVault] Extension setup() running — tabId=${MV_TAB_ID}`);

        const claimActiveTab = () => {
            fetch("/mediavault/set-active-tab", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tabId: MV_TAB_ID }),
            }).catch(() => {});
        };

        // Claim on initial load + whenever this tab gets focus
        claimActiveTab();
        window.addEventListener("focus", claimActiveTab);
        // Also claim on any click (covers clicking within an already-focused tab)
        document.addEventListener("pointerdown", claimActiveTab, { once: false, passive: true });

        // ── Poll for "Send to ComfyUI" assets ──
        // CAM stores assets on the Python side; we poll and create loader nodes.
        // This avoids reloading ComfyUI (window.open wipes the existing graph).
        console.log(`[MediaVault] Poll started — tabId=${MV_TAB_ID}, polling /mediavault/send-assets every 3s`);
        setInterval(async () => {
            try {
                const res = await fetch(`/mediavault/send-assets?tabId=${MV_TAB_ID}`);
                if (!res.ok) { console.warn(`[MediaVault] Poll: HTTP ${res.status}`); return; }
                const data = await res.json();
                if (!data.hasAssets || !data.assets?.length) return;
                console.log(`[MediaVault] Poll: ✓ Received ${data.assets.length} asset(s)!`, data.assets);

                const COLS = 3;
                const NODE_W = 340;
                const NODE_H = 500;
                const PAD_X = 60;
                const PAD_Y = 60;

                // Position new nodes near the current viewport center
                const canvas = app.canvas;
                const cx = (-canvas.ds.offset[0] + canvas.canvas.width / 2 / canvas.ds.scale);
                const cy = (-canvas.ds.offset[1] + canvas.canvas.height / 2 / canvas.ds.scale);
                const gridW = Math.min(data.assets.length, COLS) * (NODE_W + PAD_X);
                const startX = cx - gridW / 2;
                const startY = cy - 200;

                for (let i = 0; i < data.assets.length; i++) {
                    const asset = data.assets[i];
                    const col = i % COLS;
                    const row = Math.floor(i / COLS);
                    const x = startX + col * (NODE_W + PAD_X);
                    const y = startY + row * (NODE_H + PAD_Y);

                    const node = LiteGraph.createNode("LoadFromMediaVault");
                    if (!node) {
                        console.error("[MediaVault] Could not create LoadFromMediaVault node");
                        continue;
                    }
                    node.pos = [x, y];
                    app.graph.add(node);

                    // Populate widgets with the asset's hierarchy values
                    const widgetMap = {
                        project: asset.project,
                        sequence: asset.sequence,
                        shot: asset.shot,
                        role: asset.role,
                        asset: asset.vault_name,
                    };
                    for (const [wName, wValue] of Object.entries(widgetMap)) {
                        const widget = findWidget(node, wName);
                        if (widget && wValue) {
                            if (widget.options?.values && !widget.options.values.includes(wValue)) {
                                widget.options.values.push(wValue);
                            }
                            widget.value = wValue;
                        }
                    }

                    // Fetch live dropdown options while preserving pre-set values
                    setTimeout(() => restoreLiveDropdowns(node), 800 + i * 200);
                }

                console.log(`[MediaVault] ✓ Created ${data.assets.length} LoadFromMediaVault node(s)`);
                app.canvas.setDirty(true, true);
            } catch (pollErr) {
                // Only log if it's not a simple network error (MediaVault server may not be running)
                if (pollErr?.name !== 'TypeError') console.warn('[MediaVault] Poll error:', pollErr);
            }
        }, 3000);

        // ── Handle "Load in ComfyUI" (loads entire workflow) ──
        const params = new URLSearchParams(window.location.search);
        if (!params.has("cam_load")) return;

        // Clean the URL immediately so a refresh doesn't re-trigger
        const cleanUrl = new URL(window.location);
        cleanUrl.searchParams.delete("cam_load");
        window.history.replaceState({}, "", cleanUrl);

        try {
            const res = await fetch("/mediavault/load-workflow");
            if (!res.ok) return;
            const data = await res.json();
            if (!data.hasWorkflow) {
                console.warn("[MediaVault] cam_load param present but no pending workflow");
                return;
            }

            // Small delay to let ComfyUI finish initializing the canvas
            setTimeout(() => {
                app.loadGraphData(data.workflow);
                console.log(`[MediaVault] ✓ Loaded workflow (${data.workflow.nodes?.length || 0} nodes)`);
            }, 500);
        } catch (e) {
            console.error("[MediaVault] Failed to load pending workflow:", e);
        }
    },

    async nodeCreated(node) {
        if (!MV_NODES.includes(node.comfyClass)) return;

        // Hook each hierarchy widget so changing it triggers a cascade
        const hierarchyWidgets = ["project", "sequence", "shot", "role"];

        for (const wName of hierarchyWidgets) {
            const widget = findWidget(node, wName);
            if (!widget) continue;

            const originalCb = widget.callback;
            widget.callback = function (v) {
                if (originalCb) originalCb.call(this, v);
                cascadeUpdate(node, wName);
            };
        }

        // ── Asset preview for Load nodes ──
        if (PREVIEW_NODES.includes(node.comfyClass)) {
            addPreviewWidget(node);

            // Hook asset widget so changing the selection updates the preview
            const assetWidget = findWidget(node, "asset");
            if (assetWidget) {
                const origAssetCb = assetWidget.callback;
                assetWidget.callback = function (v) {
                    if (origAssetCb) origAssetCb.call(this, v);
                    updateNodePreview(node);
                    // Also probe video info if this is a video node
                    if (VIDEO_INFO_NODES.includes(node.comfyClass)) {
                        updateVideoInfo(node);
                    }
                };
            }

            // Saved-workflow recovery: resolve asset name → ID for preview
            setTimeout(() => {
                if (!node._mvAssetMap || Object.keys(node._mvAssetMap).length === 0) {
                    resolveAssetIdAndPreview(node);
                } else {
                    updateNodePreview(node);
                }
            }, 1500);
        }

        // ── Video info widget for Load Video nodes ──
        if (VIDEO_INFO_NODES.includes(node.comfyClass)) {
            addVideoInfoWidget(node);

            // Probe video info after workflow restore (delayed so asset map is ready)
            setTimeout(() => {
                updateVideoInfo(node);
            }, 2000);
        }

        // Also add a manual Refresh button so the user can force re-query
        // This also refreshes the project list itself (new projects added after ComfyUI started)
        addRefreshButton(node);

        // Re-add button after workflow load / node configure (ComfyUI strips dynamic widgets)
        // AND restore saved dropdown values that ComfyUI rejected (not in static options list)
        const origConfigure = node.onConfigure;
        node.onConfigure = function (info) {
            if (origConfigure) origConfigure.call(this, info);

            // ── Sanitize INT widgets before ComfyUI reads them ──
            // Old workflows may have None/"" in renamed fields (frame_start→skip_first_frames etc.)
            for (const w of (this.widgets || [])) {
                if (w.type === "number" && w.options && typeof w.options.min === "number") {
                    if (w.value === null || w.value === undefined || w.value === "" || w.value === "None") {
                        w.value = w.options.default ?? w.options.min ?? 0;
                    }
                }
            }

            // ── Restore saved dropdown values ──
            // ComfyUI combo widgets reject values not in INPUT_TYPES options.
            // Our dropdowns are dynamically populated, so saved values like
            // "MyProject (PROJ)" get reset to "(Load MediaVault...)".
            // Fix: read raw saved values from info.widgets_values and force-inject them.
            //
            // IMPORTANT: widgets_values only contains serializable widgets (serialize !== false).
            // Dynamic widgets (refresh button, preview, video info) have serialize:false and
            // are NOT in widgets_values. So we must build a filtered index that skips them.
            const savedValues = info?.widgets_values;
            if (savedValues && Array.isArray(savedValues)) {
                const restoreWidgets = ["project", "sequence", "shot", "role", "asset"];
                // Build serialization-order index: only widgets that LiteGraph actually serializes.
                // LiteGraph skips widgets with serialize === false (top-level property).
                // This must exactly match LiteGraph's own filter for the indices to align.
                const serializableWidgets = (this.widgets || []).filter(w => w.serialize !== false);
                for (const wName of restoreWidgets) {
                    const widget = findWidget(this, wName);
                    if (!widget) continue;
                    // Find this widget's position in the serializable-only list
                    const idx = serializableWidgets.indexOf(widget);
                    if (idx < 0 || idx >= savedValues.length) continue;
                    const saved = savedValues[idx];
                    if (
                        saved &&
                        typeof saved === "string" &&
                        !saved.startsWith("(Load") &&
                        saved !== "No assets found"
                    ) {
                        // Inject into options so ComfyUI/LiteGraph accepts it
                        if (!widget.options.values.includes(saved)) {
                            widget.options.values.push(saved);
                        }
                        widget.value = saved;
                    }
                }
            }

            ensureRefreshButton(this);

            // Ensure video info widget exists for video nodes
            if (VIDEO_INFO_NODES.includes(this.comfyClass)) {
                const hasInfoWidget = this.widgets?.some(w => w.type === "MEDIAVAULT_VIDEO_INFO");
                if (!hasInfoWidget) {
                    addVideoInfoWidget(this);
                }
            }

            // Fetch live data from MediaVault while preserving restored values
            setTimeout(() => restoreLiveDropdowns(this), 800);

            // Probe video info after dropdowns are restored
            if (VIDEO_INFO_NODES.includes(this.comfyClass)) {
                setTimeout(() => updateVideoInfo(this), 2500);
            }
        };

        // ── Auto-populate Save node from any Load node in the graph ──
        // On creation, scan for an existing Load node and copy its
        // Project / Sequence / Shot so user only needs to pick Role.
        if (node.comfyClass === "SaveToMediaVault") {
            // Small delay so the graph is fully loaded before scanning
            setTimeout(() => prefillFromLoadNode(node), 500);

            // Manual button to re-sync any time
            const copyBtn = node.addWidget("button", "📂 Copy from Load Node", null, () => {
                prefillFromLoadNode(node);
            });
            copyBtn.serialize = false;
        }
    },
});
