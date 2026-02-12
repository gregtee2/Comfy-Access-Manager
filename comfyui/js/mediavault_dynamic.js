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
    if (keepValue && newValues.includes(old)) {
        widget.value = old;
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

    // Store asset ID map for preview lookups
    node._mvAssetMap = {};
    for (const a of assets) {
        node._mvAssetMap[a.vault_name] = a.id;
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
        },
        computeSize(width) {
            if (!node._mvPreviewReady || !node._mvPreviewImg) return [width, 4];
            const img = node._mvPreviewImg;
            const pad = 6;
            const maxW = width - pad * 2;
            const aspect = img.naturalHeight / img.naturalWidth;
            const maxH = 250;
            let dh = Math.min(maxW * aspect, maxH);
            return [width, dh + 12];
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
    const assetId = node._mvAssetMap?.[assetName];

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
            // Resize the node to fit the preview
            const sz = node.computeSize();
            if (node.size[1] < sz[1]) node.setSize(sz);
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
        node._mvAssetMap[a.vault_name] = a.id;
    }
    updateNodePreview(node);
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

// ── Extension registration ──────────────────────────────
app.registerExtension({
    name: "MediaVault.DynamicDropdowns",

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

        // Also add a manual Refresh button so the user can force re-query
        // This also refreshes the project list itself (new projects added after ComfyUI started)
        node.addWidget("button", "🔄 Refresh Assets", null, async () => {
            // Refresh projects
            const projW = findWidget(node, "project");
            if (projW) {
                const projects = await mvFetch("/mediavault/projects");
                const projNames = projects.map(p => `${p.name} (${p.code})`);
                if (projNames.length > 0) {
                    updateComboWidget(projW, projNames, true);
                }
            }
            // Refresh roles (picks up newly added roles without restart)
            const roleW = findWidget(node, "role");
            if (roleW) {
                const roles = await mvFetch("/mediavault/roles");
                const roleNames = roles.map(r => `${r.name} (${r.code})`);
                if (roleNames.length > 0) {
                    updateComboWidget(roleW, roleNames, true);
                }
            }
            await cascadeUpdate(node, "project");
        });

        // ── Auto-populate Save node from any Load node in the graph ──
        // On creation, scan for an existing Load node and copy its
        // Project / Sequence / Shot so user only needs to pick Role.
        if (node.comfyClass === "SaveToMediaVault") {
            // Small delay so the graph is fully loaded before scanning
            setTimeout(() => prefillFromLoadNode(node), 500);

            // Manual button to re-sync any time
            node.addWidget("button", "📂 Copy from Load Node", null, () => {
                prefillFromLoadNode(node);
            });
        }
    },
});
