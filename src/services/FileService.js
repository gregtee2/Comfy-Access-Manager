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
     * @param {string} [opts.shotCode] - Shot code
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
            let basePattern;
            if (opts.sequenceCode && opts.shotCode) {
                basePattern = `${opts.shotCode}_${opts.roleCode.toLowerCase()}_v`;
            } else if (opts.sequenceCode) {
                basePattern = `${opts.sequenceCode}_${opts.roleCode.toLowerCase()}_v`;
            } else {
                basePattern = `${opts.projectCode}_${opts.roleCode.toLowerCase()}_v`;
            }
            version = getNextVersion(vaultDir, basePattern);
        }

        // Auto-detect counter for legacy templates (non-role naming)
        const counter = opts.counter || getNextVersion(vaultDir, '');

        // Generate structured name
        const { vaultName } = generateVaultName({
            originalName,
            projectCode: opts.projectCode,
            sequenceCode: opts.sequenceCode,
            shotCode: opts.shotCode,
            roleCode: opts.roleCode,
            takeNumber: opts.takeNumber,
            version,
            mediaType,
            counter,
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
        let basePattern = '';
        if (opts.roleCode) {
            if (opts.sequenceCode && opts.shotCode) {
                basePattern = `${opts.shotCode}_${opts.roleCode.toLowerCase()}_v`;
            } else if (opts.sequenceCode) {
                basePattern = `${opts.sequenceCode}_${opts.roleCode.toLowerCase()}_v`;
            } else {
                basePattern = `${opts.projectCode}_${opts.roleCode.toLowerCase()}_v`;
            }
        }
        const version = opts.version || getNextVersion(vaultDir, basePattern);

        const { vaultName } = generateVaultName({
            originalName,
            projectCode: opts.projectCode,
            sequenceCode: opts.sequenceCode,
            shotCode: opts.shotCode,
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
     * Get available drive letters on Windows
     */
    static getDrives() {
        if (process.platform !== 'win32') return ['/'];
        const drives = [];
        for (let i = 65; i <= 90; i++) {
            const drive = `${String.fromCharCode(i)}:\\`;
            try {
                fs.accessSync(drive);
                drives.push(drive);
            } catch {}
        }
        return drives;
    }
}

module.exports = FileService;
