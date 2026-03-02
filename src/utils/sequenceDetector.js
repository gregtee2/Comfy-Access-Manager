/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault — Frame Sequence Detector
 * Detects numbered frame sequences from a list of file paths.
 * Groups files like render.0001.exr … render.0100.exr into a single sequence.
 *
 * Supported patterns:
 *   name.####.ext   (dot-separated, VFX standard: render.0001.exr)
 *   name_####.ext   (underscore: render_0001.exr, skips version numbers like _v001)
 */

const path = require('path');

// Frame number detection patterns (ordered by priority)
const FRAME_PATTERNS = [
    // Dot-separated: render.0001.exr  →  base="render", frame="0001", ext="exr"
    { regex: /^(.+?)\.(\d{3,})\.(\w+)$/, separator: '.' },
    // Underscore-separated: render_0001.exr  (but NOT comp_v001.exr — that's a version)
    { regex: /^(.+?)_(\d{4,})\.(\w+)$/, separator: '_' },
];

// Video container formats are NEVER frame sequences — each file is already a
// complete video with frames inside.  Only image/EXR/DPX-like formats can
// legitimately form numbered frame sequences.
const VIDEO_CONTAINER_EXTS = new Set([
    'mov', 'mp4', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v',
    'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts', 'prores',
]);

/**
 * Detect frame sequences from an array of file paths.
 * @param {string[]} filePaths - Array of absolute file paths
 * @returns {{ sequences: SequenceGroup[], singles: string[] }}
 *
 * SequenceGroup: {
 *   baseName: string,      // e.g. "render"
 *   ext: string,           // e.g. ".exr"
 *   dir: string,           // source directory
 *   separator: string,     // '.' or '_'
 *   frameStart: number,    // first frame number
 *   frameEnd: number,      // last frame number
 *   frameCount: number,    // total frames found
 *   digits: number,        // zero-padding width (e.g. 4 for 0001)
 *   files: string[],       // ordered file paths
 *   ffmpegPattern: string, // printf pattern for FFmpeg (e.g. "render.%04d.exr")
 * }
 */
function detectSequences(filePaths) {
    const groups = new Map(); // key → { baseName, ext, separator, dir, frames[] }
    const singles = [];

    for (const fp of filePaths) {
        const fileName = path.basename(fp);
        let matched = false;

        for (const { regex, separator } of FRAME_PATTERNS) {
            const m = fileName.match(regex);
            if (!m) continue;

            const [, base, frameStr, ext] = m;

            // Skip version numbers: if base ends with 'v' or '_v', it's a version not a frame
            if (separator === '_' && /v$/i.test(base)) continue;

            // Skip video container formats — each file is a complete video,
            // not a numbered frame in a sequence (e.g. comfy_00001.mp4 is NOT
            // the same as render.0001.exr)
            if (VIDEO_CONTAINER_EXTS.has(ext.toLowerCase())) continue;

            const key = `${path.dirname(fp)}|${base}|${separator}|${ext}`;

            if (!groups.has(key)) {
                groups.set(key, {
                    baseName: base,
                    ext: `.${ext}`,
                    separator,
                    dir: path.dirname(fp),
                    frames: [],
                });
            }

            groups.get(key).frames.push({
                path: fp,
                frame: parseInt(frameStr, 10),
                digits: frameStr.length,
            });

            matched = true;
            break; // first matching pattern wins
        }

        if (!matched) {
            singles.push(fp);
        }
    }

    // Filter: only groups with 2+ frames qualify as sequences
    const sequences = [];

    for (const [, group] of groups) {
        if (group.frames.length < 2) {
            // Single frame — treat as individual file
            singles.push(...group.frames.map(f => f.path));
            continue;
        }

        // Sort by frame number
        group.frames.sort((a, b) => a.frame - b.frame);

        const digits = group.frames[0].digits;
        const ffmpegPattern = `${group.baseName}${group.separator}%0${digits}d${group.ext}`;

        sequences.push({
            baseName: group.baseName,
            ext: group.ext,
            separator: group.separator,
            dir: group.dir,
            frameStart: group.frames[0].frame,
            frameEnd: group.frames[group.frames.length - 1].frame,
            frameCount: group.frames.length,
            digits,
            files: group.frames.map(f => f.path),
            ffmpegPattern,
        });
    }

    return { sequences, singles };
}

/**
 * Build the vault filename for a single frame in a sequence.
 * @param {string} vaultBaseName - e.g. "EDA1500_comp_v001"
 * @param {number} frameNumber - e.g. 1
 * @param {number} digits - zero-padding (e.g. 4)
 * @param {string} ext - e.g. ".exr"
 * @returns {string} e.g. "EDA1500_comp_v001.0001.exr"
 */
function buildFrameFilename(vaultBaseName, frameNumber, digits, ext) {
    const padded = String(frameNumber).padStart(digits, '0');
    return `${vaultBaseName}.${padded}${ext}`;
}

/**
 * Build the FFmpeg printf pattern for a sequence in the vault.
 * @param {string} vaultBaseName - e.g. "EDA1500_comp_v001"
 * @param {number} digits - zero-padding (e.g. 4)
 * @param {string} ext - e.g. ".exr"
 * @returns {string} e.g. "EDA1500_comp_v001.%04d.exr"
 */
function buildVaultPattern(vaultBaseName, digits, ext) {
    return `${vaultBaseName}.%0${digits}d${ext}`;
}

module.exports = {
    detectSequences,
    buildFrameFilename,
    buildVaultPattern,
};
