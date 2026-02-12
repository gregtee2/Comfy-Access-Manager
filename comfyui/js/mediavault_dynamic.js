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
    "SaveToMediaVault",
];

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
    const names = assets.map(a => a.vault_name);
    if (names.length === 0) names.push("No assets found");

    updateComboWidget(assetW, names, true);
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
