/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Media Type Detection
 * Maps file extensions to media categories
 */

const MEDIA_TYPES = {
    video: {
        extensions: ['.mov', '.mp4', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ts', '.mts', '.m2ts', '.prores'],
        icon: '🎬',
        color: '#4fc3f7',
    },
    image: {
        extensions: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.svg', '.ico', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw', '.dng', '.psd', '.psb', '.ai', '.eps'],
        icon: '🖼️',
        color: '#81c784',
    },
    exr: {
        extensions: ['.exr', '.hdr', '.dpx'],
        icon: '✨',
        color: '#ffb74d',
    },
    audio: {
        extensions: ['.wav', '.mp3', '.aac', '.flac', '.ogg', '.wma', '.m4a', '.aiff', '.aif'],
        icon: '🔊',
        color: '#ce93d8',
    },
    threed: {
        extensions: ['.obj', '.fbx', '.gltf', '.glb', '.stl', '.blend', '.3ds', '.dae', '.usd', '.usda', '.usdc', '.usdz', '.ply', '.abc'],
        icon: '🧊',
        color: '#a1887f',
    },
    document: {
        extensions: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.md', '.csv', '.xls', '.xlsx'],
        icon: '📄',
        color: '#90a4ae',
    },
};

/**
 * Detect media type from file extension
 * @param {string} filename - File name or path
 * @returns {{ type: string, icon: string, color: string }}
 */
function detectMediaType(filename) {
    const ext = getExtension(filename);
    for (const [type, info] of Object.entries(MEDIA_TYPES)) {
        if (info.extensions.includes(ext)) {
            return { type, icon: info.icon, color: info.color };
        }
    }
    return { type: 'other', icon: '📎', color: '#757575' };
}

/**
 * Get file extension (lowercase, with dot)
 */
function getExtension(filename) {
    const ext = require('path').extname(filename).toLowerCase();
    return ext;
}

/**
 * Check if a file is a supported media file
 */
function isMediaFile(filename) {
    const ext = getExtension(filename);
    for (const info of Object.values(MEDIA_TYPES)) {
        if (info.extensions.includes(ext)) return true;
    }
    return false;
}

/**
 * Check if file is playable in browser
 */
function isBrowserPlayable(filename) {
    const ext = getExtension(filename);
    const playableVideo = ['.mp4', '.webm', '.mov'];
    const playableImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'];
    const playableAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];
    return playableVideo.includes(ext) || playableImage.includes(ext) || playableAudio.includes(ext);
}

/**
 * Check if a file is a video type
 */
function isVideo(filename) {
    const { type } = detectMediaType(filename);
    return type === 'video';
}

/**
 * Check if a file is an image type (including EXR)
 */
function isImage(filename) {
    const { type } = detectMediaType(filename);
    return type === 'image' || type === 'exr';
}

module.exports = {
    MEDIA_TYPES,
    detectMediaType,
    getExtension,
    isMediaFile,
    isBrowserPlayable,
    isVideo,
    isImage,
};
