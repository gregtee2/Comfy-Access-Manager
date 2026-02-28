/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Cross-Platform Path Resolver
 * Translates file paths using path mappings so assets imported on one OS
 * (e.g., Windows Z:\Media\...) resolve on another (e.g., Mac /Volumes/media/...).
 */

const { getSetting } = require('../database');

/**
 * Apply path mappings to translate a file path for the current platform.
 * Mappings are pairs like { from: "Z:\\Media", to: "/Volumes/media" }.
 * On Mac, Z:\Media\Project\file.mov → /Volumes/media/Project/file.mov
 * On PC, /Volumes/media/Project/file.mov → Z:\Media\Project\file.mov
 *
 * @param {string} filePath - The stored file path (may be from another OS)
 * @returns {string} - The resolved path for the current platform
 */
function resolveFilePath(filePath) {
    if (!filePath) return filePath;

    try {
        const raw = getSetting('path_mappings');
        if (!raw) return filePath;

        const mappings = JSON.parse(raw);
        if (!Array.isArray(mappings) || mappings.length === 0) return filePath;

        // Normalize separators for comparison
        const normalized = filePath.replace(/\\/g, '/');
        const isMac = process.platform === 'darwin';
        const isWin = process.platform === 'win32';

        for (const mapping of mappings) {
            // Support both formats:
            //   { from, to }  — generic pair
            //   { windows, mac, linux } — platform-specific keys (saved by the UI)
            let sides = [];
            if (mapping.from && mapping.to) {
                sides = [mapping.from, mapping.to];
            } else {
                // Collect all platform paths from the mapping
                const w = mapping.windows || mapping.win || '';
                const m = mapping.mac || mapping.macos || '';
                const l = mapping.linux || '';
                sides = [w, m, l].filter(Boolean);
            }
            if (sides.length < 2) continue;

            for (let i = 0; i < sides.length; i++) {
                const src = sides[i].replace(/\\/g, '/').replace(/\/+$/, '');
                if (!src) continue;

                if (normalized.toLowerCase().startsWith(src.toLowerCase() + '/') ||
                    normalized.toLowerCase() === src.toLowerCase()) {
                    // Find the best target for the current platform
                    let target = null;
                    if (mapping.from && mapping.to) {
                        // Generic: swap to the other side
                        target = (i === 0) ? mapping.to : mapping.from;
                    } else {
                        // Platform-specific: pick the current platform's path
                        if (isMac) target = mapping.mac || mapping.macos;
                        else if (isWin) target = mapping.windows || mapping.win;
                        else target = mapping.linux || mapping.mac || mapping.macos;
                    }
                    if (!target || target.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === src.toLowerCase()) {
                        continue; // Don't map to the same path
                    }
                    const targetClean = target.replace(/\\/g, '/').replace(/\/+$/, '');
                    const remainder = normalized.substring(src.length);
                    const resolved = targetClean + remainder;
                    return process.platform === 'win32'
                        ? resolved.replace(/\//g, '\\')
                        : resolved;
                }
            }
        }
    } catch (e) {
        // If mappings can't be parsed, just return original path
    }

    return filePath;
}

/**
 * Return all possible path representations for a file path.
 * Given a Mac path, also returns the Windows/Linux equivalents (and vice versa)
 * by applying every configured mapping in both directions.
 * Used for DB lookups where the stored platform may differ from the current one.
 *
 * @param {string} filePath - Any platform's file path
 * @returns {string[]} - Array of normalized (forward-slash) path variants
 */
function getAllPathVariants(filePath) {
    if (!filePath) return [];
    const variants = new Set();
    const normalized = filePath.replace(/\\/g, '/');
    variants.add(normalized);

    try {
        const raw = getSetting('path_mappings');
        if (raw) {
            const mappings = JSON.parse(raw);
            if (Array.isArray(mappings) && mappings.length > 0) {
                for (const mapping of mappings) {
                    let sides = [];
                    if (mapping.from && mapping.to) {
                        sides = [mapping.from, mapping.to];
                    } else {
                        const w = mapping.windows || mapping.win || '';
                        const m = mapping.mac || mapping.macos || '';
                        const l = mapping.linux || '';
                        sides = [w, m, l].filter(Boolean);
                    }
                    if (sides.length < 2) continue;

                    for (let i = 0; i < sides.length; i++) {
                        const src = sides[i].replace(/\\/g, '/').replace(/\/+$/, '');
                        if (!src) continue;

                        if (normalized.toLowerCase().startsWith(src.toLowerCase() + '/') ||
                            normalized.toLowerCase() === src.toLowerCase()) {
                            const remainder = normalized.substring(src.length);
                            // Add variants for ALL other sides (cross-platform paths)
                            for (let j = 0; j < sides.length; j++) {
                                if (j === i) continue;
                                const target = sides[j].replace(/\\/g, '/').replace(/\/+$/, '');
                                if (target) {
                                    variants.add(target + remainder);
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch {
        // If mappings can't be parsed, continue with what we have
    }

    // Also include backslash versions of every variant so that DB
    // lookups match paths stored with Windows separators (Z:\... vs Z:/...)
    const withBackslashes = [];
    for (const v of variants) {
        const bs = v.replace(/\//g, '\\');
        if (!variants.has(bs)) withBackslashes.push(bs);
    }
    for (const bs of withBackslashes) variants.add(bs);

    return [...variants];
}

module.exports = { resolveFilePath, getAllPathVariants };
