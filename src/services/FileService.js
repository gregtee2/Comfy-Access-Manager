/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - File Service
 * Handles file import (move), rename, delete, and vault structure management
 */

const fs = require('fs');
const path = require('path');
const { getSetting } = require('../database');
const { generateVaultName, getVaultDirectory, getNextVersion, resolveCollision } = require('../utils/naming');
const { detectMediaType, getExtension } = require('../utils/mediaTypes');

class FileService {

    /**
     * Get the configured vault root path
     */
    static getVaultRoot() {
        const root = getSetting('vault_root');
        if (!root) throw new Error('Vault root path not configured. Go to Settings to set it.');
        return root;
    }

    /**
     * Ensure a directory exists, creating it recursively if needed
     */
    static ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        return dirPath;
    }

    /**
     * Move a file into the vault with structured naming
     * @param {string} sourcePath - Original file location
     * @param {object} opts
     * @param {string} opts.projectCode - Project code
     * @param {string} [opts.sequenceCode] - Sequence code
     * @param {string} [opts.sequenceName] - Sequence name (user-facing)
     * @param {string} [opts.shotCode] - Shot code
     * @param {string} [opts.shotName] - Shot name (user-facing)
     * @param {number} [opts.takeNumber] - Take number
     * @param {string} [opts.customName] - Custom name override
     * @param {string} [opts.template] - Naming template
     * @returns {{ vaultPath: string, vaultName: string, relativePath: string }}
     */
    static importFile(sourcePath, opts) {
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Source file not found: ${sourcePath}`);
        }

        const vaultRoot = this.getVaultRoot();
        const originalName = path.basename(sourcePath);
        const { type: mediaType } = detectMediaType(originalName);

        // Determine vault directory
        const vaultDir = getVaultDirectory(
            vaultRoot,
            opts.projectCode,
            mediaType,
            opts.sequenceCode,
            opts.shotCode
        );
        this.ensureDir(vaultDir);

        // Build a base pattern for version auto-increment
        // ShotGrid style: scan for {project}_{seq}_{shot}_{step}_v* in target dir
        let version = 1;
        if (opts.roleCode) {
            // basePattern must match the ACTUAL generated filename prefix.
            // SHOTGRID_FULL  = {shot}_{step}_v{version}  → pattern: "EDA1500_ai_v"
            // SHOTGRID_SEQ   = {sequence}_{step}_v{version} → pattern: "EDA_ai_v"
            // SHOTGRID_PROJ  = {project}_{step}_v{version} → pattern: "AP1_ai_v"
            // Use the same shot/sequence identifier that will appear in the filename
            const shotToken = opts.shotName || opts.shotCode;
            const seqToken = opts.sequenceName || opts.sequenceCode;
            let basePattern;
            if (opts.sequenceCode && opts.shotCode) {
                basePattern = `${shotToken}_${opts.roleCode.toLowerCase()}_v`;
            } else if (opts.sequenceCode) {
                basePattern = `${seqToken}_${opts.roleCode.toLowerCase()}_v`;
            } else {
                basePattern = `${opts.projectCode}_${opts.roleCode.toLowerCase()}_v`;
            }
            version = getNextVersion(vaultDir, basePattern);
        }

        // Auto-detect counter for legacy templates (non-role naming)
        const counter = opts.counter || getNextVersion(vaultDir, '');

        // Generate structured name (or keep original)
        let vaultName;
        if (opts.keepOriginalName) {
            vaultName = originalName;
        } else if (opts.overrideVaultName) {
            // Convention-generated name from Shot Builder
            vaultName = opts.overrideVaultName;
        } else {
            const result = generateVaultName({
                originalName,
                projectCode: opts.projectCode,
                sequenceCode: opts.sequenceCode,
                sequenceName: opts.sequenceName,
                shotCode: opts.shotCode,
                shotName: opts.shotName,
                roleCode: opts.roleCode,
                takeNumber: opts.takeNumber,
                version,
                mediaType,
                counter,
                template: opts.template,
                customName: opts.customName,
            });
            vaultName = result.vaultName;
        }

        const destPath = path.join(vaultDir, vaultName);

        // Handle name collision — version-aware (v002→v003) or suffix fallback (_02, _03)
        let finalPath = destPath;
        if (fs.existsSync(destPath)) {
            const resolved = resolveCollision(vaultDir, vaultName);
            finalPath = path.join(vaultDir, resolved);
        }

        // Move or copy file into vault
        if (opts.keepOriginals) {
            // Copy only — leave original in place
            fs.copyFileSync(sourcePath, finalPath);
        } else {
            // Move (rename, or copy+delete for cross-drive)
            try {
                fs.renameSync(sourcePath, finalPath);
            } catch (err) {
                if (err.code === 'EXDEV') {
                    fs.copyFileSync(sourcePath, finalPath);
                    fs.unlinkSync(sourcePath);
                } else {
                    throw err;
                }
            }
        }

        const relativePath = path.relative(vaultRoot, finalPath);

        return {
            vaultPath: finalPath,
            vaultName: path.basename(finalPath),
            relativePath,
            mediaType,
        };
    }

    /**
     * Copy a file into the vault (alternative to move)
     */
    static copyFile(sourcePath, opts) {
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Source file not found: ${sourcePath}`);
        }

        const vaultRoot = this.getVaultRoot();
        const originalName = path.basename(sourcePath);
        const { type: mediaType } = detectMediaType(originalName);

        const vaultDir = getVaultDirectory(
            vaultRoot,
            opts.projectCode,
            mediaType,
            opts.sequenceCode,
            opts.shotCode
        );
        this.ensureDir(vaultDir);

        // Build basePattern matching the actual filename template (same logic as importFile)
        // Use names (not codes) since filenames use names
        const shotToken = opts.shotName || opts.shotCode;
        const seqToken = opts.sequenceName || opts.sequenceCode;
        let basePattern = '';
        if (opts.roleCode) {
            if (opts.sequenceCode && opts.shotCode) {
                basePattern = `${shotToken}_${opts.roleCode.toLowerCase()}_v`;
            } else if (opts.sequenceCode) {
                basePattern = `${seqToken}_${opts.roleCode.toLowerCase()}_v`;
            } else {
                basePattern = `${opts.projectCode}_${opts.roleCode.toLowerCase()}_v`;
            }
        }
        const version = opts.version || getNextVersion(vaultDir, basePattern);

        const { vaultName } = generateVaultName({
            originalName,
            projectCode: opts.projectCode,
            sequenceCode: opts.sequenceCode,
            sequenceName: opts.sequenceName,
            shotCode: opts.shotCode,
            shotName: opts.shotName,
            roleCode: opts.roleCode,
            takeNumber: opts.takeNumber,
            version,
            mediaType,
            counter: opts.counter || 1,
            template: opts.template,
            customName: opts.customName,
        });

        const destPath = path.join(vaultDir, vaultName);

        // Handle name collision — version-aware (v002→v003) or suffix fallback (_02, _03)
        let finalPath = destPath;
        if (fs.existsSync(destPath)) {
            const resolved = resolveCollision(vaultDir, vaultName);
            finalPath = path.join(vaultDir, resolved);
        }

        fs.copyFileSync(sourcePath, finalPath);

        const relativePath = path.relative(vaultRoot, finalPath);

        return {
            vaultPath: finalPath,
            vaultName: path.basename(finalPath),
            relativePath,
            mediaType,
        };
    }

    /**
     * Rename an existing vault file
     * @param {string} currentPath - Current full path
     * @param {string} newName - New filename (without path)
     * @returns {string} New full path
     */
    static renameFile(currentPath, newName) {
        if (!fs.existsSync(currentPath)) {
            throw new Error(`File not found: ${currentPath}`);
        }
        const dir = path.dirname(currentPath);
        const newPath = path.join(dir, newName);
        if (fs.existsSync(newPath)) {
            throw new Error(`File already exists: ${newPath}`);
        }
        fs.renameSync(currentPath, newPath);
        return newPath;
    }

    /**
     * Delete a vault file
     */
    static deleteFile(filePath) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }

    /**
     * Get file stats
     */
    static getFileStats(filePath) {
        if (!fs.existsSync(filePath)) return null;
        const stats = fs.statSync(filePath);
        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
        };
    }

    /**
     * List all files in a directory recursively
     */
    static listFiles(dirPath, filter = null) {
        const results = [];

        function walk(dir) {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else {
                    if (!filter || filter(entry.name)) {
                        results.push(fullPath);
                    }
                }
            }
        }

        walk(dirPath);
        return results;
    }

    /**
     * Browse a directory and return file/folder listing
     * @param {string} dirPath - Directory to browse
     * @returns {Array<{ name, path, isDirectory, size, ext, mediaType }>}
     */
    static browseDirectory(dirPath) {
        if (!fs.existsSync(dirPath)) return [];
        
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries.map(entry => {
            const fullPath = path.join(dirPath, entry.name);
            const isDirectory = entry.isDirectory();
            const ext = isDirectory ? '' : getExtension(entry.name);
            const mediaInfo = isDirectory ? null : detectMediaType(entry.name);
            
            let size = 0;
            if (!isDirectory) {
                try { size = fs.statSync(fullPath).size; } catch {}
            }

            return {
                name: entry.name,
                path: fullPath,
                isDirectory,
                size,
                ext,
                mediaType: mediaInfo?.type || null,
                icon: isDirectory ? '📁' : (mediaInfo?.icon || '📎'),
            };
        }).sort((a, b) => {
            // Directories first, then alphabetical
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });
    }

    /**
     * Get available drive roots for the file browser.
     * Windows: Drive letters (C:\, D:\, Z:\, etc.)
     * macOS: / plus mounted volumes (/Volumes/ShareName, etc.)
     * Linux: / plus common mount points
     *
     * Returns array of objects: { path, name, type, icon }
     *   type: 'local' | 'network' | 'external' | 'root'
     */
    static getDrives() {
        if (process.platform === 'win32') {
            const drives = [];
            for (let i = 65; i <= 90; i++) {
                const drive = `${String.fromCharCode(i)}:\\`;
                try {
                    fs.accessSync(drive);
                    drives.push({ path: drive, name: drive, type: 'local', icon: '💾' });
                } catch {}
            }
            // Windows: check for mapped network drives via net use
            try {
                const { execSync } = require('child_process');
                const netUse = execSync('net use 2>nul', { encoding: 'utf8', timeout: 3000 });
                const mapped = new Set();
                for (const line of netUse.split('\n')) {
                    const match = line.match(/^\s*(?:OK|Disconnected)\s+([A-Z]:)/i);
                    if (match) mapped.add(match[1] + '\\');
                }
                for (const d of drives) {
                    if (mapped.has(d.path)) {
                        d.type = 'network';
                        d.icon = '🌐';
                    }
                }
            } catch {}
            return drives;
        }

        const roots = [{ path: '/', name: 'Macintosh HD', type: 'root', icon: '💻' }];

        // macOS: Add mounted volumes with type detection
        if (process.platform === 'darwin') {
            // Parse mount output to identify network vs local filesystems
            let mountInfo = {};
            try {
                const { execSync } = require('child_process');
                const mountOutput = execSync('mount', { encoding: 'utf8', timeout: 3000 });
                for (const line of mountOutput.split('\n')) {
                    // Format: //user@host/share on /Volumes/share (smbfs, ...)
                    // or: /dev/diskXsY on /Volumes/Name (apfs, ...)
                    const match = line.match(/^(.+?)\s+on\s+(\/Volumes\/.+?)\s+\(([^)]+)\)/);
                    if (match) {
                        const device = match[1];
                        const mountPoint = match[2];
                        const fsType = match[3].split(',')[0].trim();
                        mountInfo[mountPoint] = { device, fsType };
                    }
                }
            } catch {}

            try {
                const volumes = fs.readdirSync('/Volumes');
                for (const vol of volumes) {
                    // Skip hidden volumes (e.g. .timemachine)
                    if (vol.startsWith('.')) continue;

                    const volPath = `/Volumes/${vol}`;
                    try {
                        // Quick accessibility check with timeout protection
                        fs.accessSync(volPath);
                    } catch { continue; }

                    const info = mountInfo[volPath] || {};
                    const fsType = (info.fsType || '').toLowerCase();
                    const device = (info.device || '').toLowerCase();

                    // Classify the volume
                    let type = 'external';  // default: USB/Thunderbolt drive
                    let icon = '💾';

                    if (fsType === 'smbfs' || fsType === 'afpfs' || fsType === 'nfs' ||
                        fsType === 'webdav' || fsType === 'cifs' ||
                        device.startsWith('//') || device.includes('@')) {
                        type = 'network';
                        icon = '🌐';
                    } else if (vol === 'Macintosh HD' || vol === 'Macintosh HD - Data' ||
                               (device.startsWith('/dev/disk') && fsType === 'apfs')) {
                        // Internal system volume — skip (already have /)
                        continue;
                    } else if (fsType === 'hfs' && device.startsWith('/dev/disk')) {
                        // Likely a mounted .dmg installer image — skip
                        continue;
                    }

                    roots.push({
                        path: volPath,
                        name: vol,
                        type,
                        icon,
                        // Extra metadata for network drives
                        ...(type === 'network' ? { server: (info.device || '').replace(/^\/\/[^@]*@/, '//') } : {}),
                    });
                }
            } catch {}

            // Add user home as a quick shortcut
            const homedir = require('os').homedir();
            roots.push({ path: homedir, name: 'Home', type: 'local', icon: '🏠' });

            // Sort: network drives first, then external, then local
            const typeOrder = { network: 0, external: 1, local: 2, root: 3 };
            roots.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));
        }

        // Linux: Check common network mount points
        if (process.platform === 'linux') {
            for (const mountDir of ['/mnt', '/media']) {
                try {
                    const entries = fs.readdirSync(mountDir);
                    for (const entry of entries) {
                        const mountPath = `${mountDir}/${entry}`;
                        try {
                            if (fs.statSync(mountPath).isDirectory()) {
                                roots.push({ path: mountPath, name: entry, type: 'external', icon: '💾' });
                            }
                        } catch {}
                    }
                } catch {}
            }

            // Check /etc/fstab and mount for network shares
            try {
                const { execSync } = require('child_process');
                const mountOutput = execSync('mount -t cifs,nfs,nfs4,smbfs 2>/dev/null || true', { encoding: 'utf8', timeout: 3000 });
                for (const line of mountOutput.split('\n')) {
                    const match = line.match(/\son\s+(\/\S+)\s+type\s+(cifs|nfs|nfs4|smbfs)/);
                    if (match && !roots.some(r => r.path === match[1])) {
                        roots.push({ path: match[1], name: match[1].split('/').pop(), type: 'network', icon: '🌐' });
                    }
                }
            } catch {}

            const homedir = require('os').homedir();
            roots.push({ path: homedir, name: 'Home', type: 'local', icon: '🏠' });
        }

        return roots;
    }
}

module.exports = FileService;
