/**
 * MediaVault - Naming Convention Engine
 * Follows ShotGrid / Flow Production Tracking naming conventions.
 * The folder structure encodes the full hierarchy (Project/Sequence/Shot/)
 * so filenames only need the most-specific identifier + step + version.
 *
 * Template tokens:
 *   {project}   → Show/project code (e.g. "AP1")
 *   {sequence}  → Sequence code (e.g. "EDA")
 *   {shot}      → Shot code (e.g. "EDA1500") — already embeds sequence prefix
 *   {step}      → Pipeline step / role (e.g. "comp", "plate", "edit")
 *   {version}   → Version number, 3-digit zero-padded (e.g. "001")
 *   {take}      → Take number zero-padded (e.g. "T01")
 *   {type}      → Media type (e.g. "video", "image")
 *   {date}      → Date YYYYMMDD
 *   {original}  → Original filename (without extension)
 *   {counter}   → Auto-incrementing counter
 *
 * ShotGrid standard examples:
 *   EDA1500_comp_v001.exr           (shot + step + version)
 *   EDA_plate_v003.dpx              (sequence-level, no shot)
 *   AP1_edit_v001.mov               (project-level, no seq/shot)
 */

const path = require('path');

// ── ShotGrid-style templates (primary) ──
// Folder path already contains project/sequence, so filenames start at the most specific level
const SHOTGRID_FULL = '{shot}_{step}_v{version}';                        // EDA1500_comp_v001
const SHOTGRID_SEQ  = '{sequence}_{step}_v{version}';                    // EDA_plate_v003
const SHOTGRID_PROJ = '{project}_{step}_v{version}';                     // AP1_edit_v001

// ── Legacy fallback templates (no role/step selected) ──
const DEFAULT_TEMPLATE = '{shot}_{take}_{counter}';
const SIMPLE_TEMPLATE = '{project}_{type}_{counter}';

// Keep old aliases for backward compat
const ROLE_SHOT_TEMPLATE = SHOTGRID_FULL;
const ROLE_SEQ_TEMPLATE = SHOTGRID_SEQ;
const ROLE_PROJECT_TEMPLATE = SHOTGRID_PROJ;

/**
 * Generate a vault-friendly structured filename
 * @param {object} params 
 * @param {string} params.originalName - Original filename
 * @param {string} params.projectCode - Project code (e.g. "HERO")
 * @param {string} [params.sequenceCode] - Sequence code (e.g. "SQ010")
 * @param {string} [params.shotCode] - Shot code (e.g. "SH020")
 * @param {number} [params.takeNumber] - Take number
 * @param {number} [params.version] - Version number (default 1)
 * @param {string} [params.mediaType] - Media type
 * @param {number} [params.counter] - Auto-incrementing counter
 * @param {string} [params.template] - Naming template
 * @param {string} [params.customName] - Custom name override (skip template)
 * @returns {{ vaultName: string, ext: string }}
 */
function generateVaultName(params) {
    const {
        originalName,
        projectCode,
        sequenceCode,
        shotCode,
        roleCode,
        takeNumber = 1,
        version = 1,
        mediaType = 'media',
        counter = 1,
        template,
        customName,
    } = params;

    const ext = path.extname(originalName).toLowerCase();
    const originalBase = path.basename(originalName, ext);

    // Custom name override — just sanitize and use it
    if (customName) {
        const sanitized = sanitizeFilename(customName);
        return { vaultName: `${sanitized}${ext}`, ext };
    }

    // Pick template: ShotGrid convention when step/role is known, legacy otherwise
    // Priority: explicit template > ShotGrid (step-based) > legacy fallback
    let tmpl = template;
    if (!tmpl) {
        if (roleCode && sequenceCode && shotCode) {
            tmpl = SHOTGRID_FULL;             // EDA1500_comp_v001
        } else if (roleCode && sequenceCode) {
            tmpl = SHOTGRID_SEQ;              // EDA_comp_v001
        } else if (roleCode) {
            tmpl = SHOTGRID_PROJ;             // AP1_comp_v001
        } else if (sequenceCode && shotCode) {
            tmpl = DEFAULT_TEMPLATE;          // EDA1500_T01_0001
        } else if (sequenceCode) {
            tmpl = '{sequence}_{type}_{counter}';
        } else {
            tmpl = SIMPLE_TEMPLATE;
        }
    }

    const tokens = {
        project: projectCode || 'UNSET',
        sequence: sequenceCode || '',
        shot: shotCode || '',
        step: roleCode ? roleCode.toLowerCase() : '',
        role: roleCode ? roleCode.toLowerCase() : '',   // alias for {step}
        take: `T${String(takeNumber).padStart(2, '0')}`,
        version: String(version).padStart(3, '0'),       // ShotGrid uses 3 digits
        type: mediaType,
        date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        original: sanitizeFilename(originalBase),
        counter: String(counter).padStart(4, '0'),
    };

    let name = tmpl;
    for (const [key, value] of Object.entries(tokens)) {
        name = name.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }

    // Clean up double underscores from empty tokens
    name = name.replace(/_+/g, '_').replace(/^_|_$/g, '');

    return { vaultName: `${name}${ext}`, ext };
}

/**
 * Parse a structured filename back into components
 * @param {string} filename 
 * @returns {object} Parsed components
 */
function parseStructuredName(filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const parts = base.split('_');

    const result = {
        projectCode: null,
        sequenceCode: null,
        shotCode: null,
        takeNumber: null,
    };

    for (const part of parts) {
        if (/^SQ\d+$/i.test(part)) result.sequenceCode = part.toUpperCase();
        else if (/^SH\d+$/i.test(part)) result.shotCode = part.toUpperCase();
        else if (/^T\d+$/i.test(part)) result.takeNumber = parseInt(part.slice(1));
        else if (!result.projectCode) result.projectCode = part;
    }

    return result;
}

/**
 * Get the next available version number for a given naming pattern
 * @param {string} directory - Directory to check
 * @param {string} basePattern - Base pattern without version
 * @returns {number} Next version number
 */
function getNextVersion(directory, basePattern) {
    const fs = require('fs');
    if (!fs.existsSync(directory)) return 1;
    if (!basePattern) return 1;  // No pattern to match

    const files = fs.readdirSync(directory);
    let maxVersion = 0;

    for (const file of files) {
        const base = path.basename(file, path.extname(file));
        if (base.startsWith(basePattern)) {
            // Match clean version (v002) or collision-suffixed version (v002_14)
            const match = base.match(/v(\d+)(?:_\d+)?$/);
            if (match) {
                const v = parseInt(match[1]);
                if (v > maxVersion) maxVersion = v;
            }
        }
    }

    return maxVersion + 1;
}

/**
 * Generate the vault folder path for an asset
 * @param {string} vaultRoot - Root vault directory
 * @param {string} projectCode - Project code
 * @param {string} mediaType - Media type (video, image, etc.)
 * @param {string} [sequenceCode] - Sequence code
 * @param {string} [shotCode] - Shot code
 * @returns {string} Full directory path
 */
function getVaultDirectory(vaultRoot, projectCode, mediaType, sequenceCode, shotCode) {
    const parts = [vaultRoot, projectCode];

    if (sequenceCode && shotCode) {
        // Full hierarchy: DD/SQ010/SH020/image/
        parts.push(sequenceCode, shotCode, mediaType);
    } else if (sequenceCode) {
        // Sequence only (e.g. REF material): DD/REF/image/
        parts.push(sequenceCode, mediaType);
    } else {
        // No sequence: DD/image/
        parts.push(mediaType);
    }

    return path.join(...parts);
}

/**
 * Sanitize a string for use as a filename
 */
function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .trim();
}

/**
 * Generate a sequence code from a number
 * @param {number} num - Sequence number (1, 2, 3...)
 * @param {number} [pad=3] - Zero-padding
 * @returns {string} e.g. "SQ010", "SQ020"
 */
function makeSequenceCode(num, pad = 3) {
    return `SQ${String(num * 10).padStart(pad, '0')}`;
}

/**
 * Generate a shot code from a number
 * @param {number} num - Shot number
 * @param {number} [pad=3] - Zero-padding
 * @returns {string} e.g. "SH010", "SH020"
 */
function makeShotCode(num, pad = 3) {
    return `SH${String(num * 10).padStart(pad, '0')}`;
}

/**
 * Resolve a filename collision in a version-aware way.
 * If the filename contains _v### (ShotGrid versioning), increment the version
 * number (v002 → v003 → v004) instead of appending a dumb suffix.
 * Falls back to _02/_03 suffixes for non-versioned files.
 *
 * @param {string} directory - Directory the file lives in
 * @param {string} filename - The colliding filename (e.g. "EDA1500_ai_v002.mp4")
 * @returns {string} Resolved filename that doesn't collide
 */
function resolveCollision(directory, filename) {
    const fs = require('fs');
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);

    // Check for ShotGrid version pattern: _v### at end of base name
    const versionMatch = base.match(/^(.+_v)(\d{2,})$/);

    if (versionMatch) {
        // Version-aware: increment version number
        const prefix = versionMatch[1];          // "EDA1500_ai_v"
        let ver = parseInt(versionMatch[2], 10); // 2
        const padding = versionMatch[2].length;  // 3 (for "002")

        do {
            ver++;
        } while (fs.existsSync(path.join(directory, `${prefix}${String(ver).padStart(padding, '0')}${ext}`)));

        return `${prefix}${String(ver).padStart(padding, '0')}${ext}`;
    }

    // Non-versioned fallback: append _02, _03, etc.
    let suffix = 2;
    while (fs.existsSync(path.join(directory, `${base}_${String(suffix).padStart(2, '0')}${ext}`))) {
        suffix++;
    }
    return `${base}_${String(suffix).padStart(2, '0')}${ext}`;
}

module.exports = {
    generateVaultName,
    parseStructuredName,
    getNextVersion,
    getVaultDirectory,
    resolveCollision,
    sanitizeFilename,
    makeSequenceCode,
    makeShotCode,
    DEFAULT_TEMPLATE,
    SIMPLE_TEMPLATE,
};
