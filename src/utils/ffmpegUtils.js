/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * FFmpeg/FFprobe utilities — Shared binary locators and font finder.
 * Used by ThumbnailService, MediaInfoService, assetRoutes, overlayRoutes, exportRoutes.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Caches
let _cachedFFmpegPath;
let _cachedFFprobePath;
let _cachedFontPath;

/**
 * Generic binary finder. Tries PATH command first, then filesystem candidates.
 * @param {string} name - Binary name ('ffmpeg' or 'ffprobe')
 * @param {string[]} candidates - Ordered list of paths to try
 * @returns {string|null}
 */
function _findBinary(name, candidates) {
    for (const candidate of candidates) {
        try {
            if (candidate === name) {
                execFileSync(name, ['-version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
                return name;
            } else if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch { /* not found at this candidate */ }
    }
    return null;
}

/**
 * Build platform-specific candidate paths for an FFmpeg-family binary.
 * @param {string} binaryName - 'ffmpeg' or 'ffprobe'
 * @returns {string[]}
 */
function _buildCandidates(binaryName) {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? `${binaryName}.exe` : binaryName;
    const localTools = path.join(__dirname, '..', '..', 'tools', 'ffmpeg', 'bin', exeName);

    return [
        binaryName,     // Works if on PATH
        localTools,     // Local tools/ directory (installed by install.bat)
        ...(isWin ? [
            `C:\\ffmpeg\\bin\\${exeName}`,
            `C:\\Program Files\\ffmpeg\\bin\\${exeName}`,
            path.join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin', exeName),
        ] : [
            `/opt/homebrew/bin/${binaryName}`,     // macOS (Apple Silicon Homebrew)
            `/usr/local/bin/${binaryName}`,        // macOS (Intel Homebrew) / Linux
            `/usr/bin/${binaryName}`,              // Linux system package
        ]),
    ];
}

/**
 * Find FFmpeg executable. Result is cached after first call.
 * @returns {string|null}
 */
function findFFmpeg() {
    if (_cachedFFmpegPath !== undefined) return _cachedFFmpegPath;
    _cachedFFmpegPath = _findBinary('ffmpeg', _buildCandidates('ffmpeg'));
    return _cachedFFmpegPath;
}

/**
 * Find FFprobe executable. Result is cached after first call.
 * @returns {string|null}
 */
function findFFprobe() {
    if (_cachedFFprobePath !== undefined) return _cachedFFprobePath;
    _cachedFFprobePath = _findBinary('ffprobe', _buildCandidates('ffprobe'));
    return _cachedFFprobePath;
}

/**
 * Find a usable font file for FFmpeg drawtext.
 * Returns an FFmpeg-escaped path (forward slashes, escaped colons), or null.
 * Result is cached after first call.
 * @returns {string|null}
 */
function findFontFile() {
    if (_cachedFontPath !== undefined) return _cachedFontPath;

    const isWin = process.platform === 'win32';
    const candidates = isWin ? [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/calibri.ttf',
    ] : [
        '/System/Library/Fonts/Helvetica.ttc',                      // macOS
        '/System/Library/Fonts/SFNSText.ttf',                       // macOS
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',          // Linux
        '/usr/share/fonts/TTF/DejaVuSans.ttf',                      // Linux alt
    ];

    for (const f of candidates) {
        if (fs.existsSync(f)) {
            // FFmpeg needs forward slashes and escaped colons
            _cachedFontPath = f.replace(/\\/g, '/').replace(/:/g, '\\:');
            return _cachedFontPath;
        }
    }
    _cachedFontPath = null;
    return null;
}

/**
 * Clear all caches (e.g., if user changes settings).
 */
function clearCache() {
    _cachedFFmpegPath = undefined;
    _cachedFFprobePath = undefined;
    _cachedFontPath = undefined;
}

module.exports = { findFFmpeg, findFFprobe, findFontFile, clearCache };
