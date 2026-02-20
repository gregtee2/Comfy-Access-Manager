/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - Thumbnail Service
 * Generates thumbnails for video and image assets using sharp and FFmpeg
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getSetting } = require('../database');

// Try to use sharp for images, gracefully degrade if unavailable
let sharp = null;
try {
    sharp = require('sharp');
} catch (e) {
    console.log('[Thumbnails] sharp not available, using FFmpeg fallback for images');
}

const THUMB_DIR = path.join(__dirname, '..', '..', 'thumbnails');

class ThumbnailService {

    static init() {
        if (!fs.existsSync(THUMB_DIR)) {
            fs.mkdirSync(THUMB_DIR, { recursive: true });
        }
    }

    /**
     * Generate a thumbnail for any media file
     * @param {string} filePath - Source file path
     * @param {string} assetId - Asset ID (used for thumb filename)
     * @returns {Promise<string|null>} Thumbnail path or null
     */
    static async generate(filePath, assetId) {
        this.init();

        const ext = path.extname(filePath).toLowerCase();
        const thumbName = `thumb_${assetId}.jpg`;
        const thumbPath = path.join(THUMB_DIR, thumbName);

        // If thumbnail already exists and is newer than the file, skip
        if (fs.existsSync(thumbPath)) {
            const thumbStat = fs.statSync(thumbPath);
            const fileStat = fs.statSync(filePath);
            if (thumbStat.mtime > fileStat.mtime) {
                return thumbPath;
            }
        }

        const thumbSize = parseInt(getSetting('thumbnail_size') || '320');

        try {
            const videoExts = ['.mov', '.mp4', '.avi', '.mkv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.mts'];
            const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic'];

            if (videoExts.includes(ext)) {
                await this.generateVideoThumb(filePath, thumbPath, thumbSize);
            } else if (imageExts.includes(ext)) {
                await this.generateImageThumb(filePath, thumbPath, thumbSize);
            } else {
                // Unsupported type, no thumbnail
                return null;
            }

            return fs.existsSync(thumbPath) ? thumbPath : null;
        } catch (err) {
            // Keep error log short — ffmpeg dumps its entire build config into errors
            const shortMsg = (err.message || '').split('\n').find(l => /error|invalid|not found|moov/i.test(l)) || err.message?.substring(0, 120);
            console.error(`[Thumbnails] Failed: ${path.basename(filePath)} — ${shortMsg}`);
            return null;
        }
    }

    /**
     * Generate thumbnail from video using FFmpeg
     */
    static generateVideoThumb(videoPath, thumbPath, size) {
        return new Promise((resolve, reject) => {
            const ffmpegPath = this.findFFmpeg();
            if (!ffmpegPath) {
                reject(new Error('FFmpeg not found'));
                return;
            }

            const args = [
                '-y',
                '-ss', '00:00:01',   // Grab frame at 1 second
                '-i', videoPath,
                '-vframes', '1',
                '-vf', `scale=${size}:-1`,
                '-q:v', '5',
                '-update', '1',
                '-strict', 'unofficial',
                thumbPath
            ];

            execFile(ffmpegPath, args, { timeout: 15000, windowsHide: true }, (err) => {
                if (err || !fs.existsSync(thumbPath)) {
                    // If it failed or file wasn't created (e.g. video shorter than 1s), try at 00:00:00
                    const fallbackArgs = [
                        '-y',
                        '-i', videoPath,
                        '-vframes', '1',
                        '-vf', `scale=${size}:-1`,
                        '-q:v', '5',
                        '-update', '1',
                        '-strict', 'unofficial',
                        thumbPath
                    ];
                    execFile(ffmpegPath, fallbackArgs, { timeout: 15000, windowsHide: true }, (err2) => {
                        if (err2) reject(err2);
                        else resolve(thumbPath);
                    });
                } else {
                    resolve(thumbPath);
                }
            });
        });
    }

    /**
     * Generate thumbnail from image using sharp (or FFmpeg fallback)
     */
    static async generateImageThumb(imagePath, thumbPath, size) {
        if (sharp) {
            await sharp(imagePath)
                .resize(size, size, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(thumbPath);
        } else {
            // FFmpeg fallback
            return new Promise((resolve, reject) => {
                const ffmpegPath = this.findFFmpeg();
                if (!ffmpegPath) {
                    reject(new Error('Neither sharp nor FFmpeg available'));
                    return;
                }
                const args = [
                    '-y', '-i', imagePath,
                    '-vf', `scale=${size}:-1`,
                    '-q:v', '5',
                    '-update', '1',
                    thumbPath
                ];
                execFile(ffmpegPath, args, { timeout: 10000, windowsHide: true }, (err) => {
                    if (err) reject(err);
                    else resolve(thumbPath);
                });
            });
        }
    }

    /**
     * Find FFmpeg in common locations
     */
    static findFFmpeg() {
        const isWin = process.platform === 'win32';
        const localTools = path.join(__dirname, '..', '..', 'tools', 'ffmpeg', 'bin', isWin ? 'ffmpeg.exe' : 'ffmpeg');
        const candidates = [
            'ffmpeg',  // Works if on PATH (brew install ffmpeg, apt install ffmpeg, or Windows PATH)
            localTools, // Local tools/ directory (installed by install.bat)
            ...(isWin ? [
                'C:\\ffmpeg\\bin\\ffmpeg.exe',
                'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
                path.join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            ] : [
                '/opt/homebrew/bin/ffmpeg',    // macOS (Apple Silicon Homebrew)
                '/usr/local/bin/ffmpeg',       // macOS (Intel Homebrew) / Linux
                '/usr/bin/ffmpeg',             // Linux system package
            ]),
        ];
        
        // Check PATH first
        const { execFileSync } = require('child_process');
        for (const candidate of candidates) {
            try {
                if (candidate === 'ffmpeg') {
                    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
                    return 'ffmpeg';
                } else if (fs.existsSync(candidate)) {
                    return candidate;
                }
            } catch {}
        }
        return null;
    }

    /**
     * Get thumbnail path for an asset ID (doesn't generate, just checks)
     */
    static getThumbPath(assetId) {
        const thumbPath = path.join(THUMB_DIR, `thumb_${assetId}.jpg`);
        return fs.existsSync(thumbPath) ? thumbPath : null;
    }

    /**
     * Delete thumbnail for an asset
     */
    static deleteThumb(assetId) {
        const thumbPath = path.join(THUMB_DIR, `thumb_${assetId}.jpg`);
        if (fs.existsSync(thumbPath)) {
            fs.unlinkSync(thumbPath);
        }
    }
}

module.exports = ThumbnailService;
