/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * PathMatchService — Auto-match scanned file paths to Flow project/sequence/shot structure
 *
 * Parses file paths using configurable patterns to extract project, sequence,
 * and shot identifiers. Then links the asset to the matching CAM database records
 * (which were populated by a Flow sync).
 *
 * Default pattern:  {project}/{sequence}/{shot}
 * This means a file at:  /shows/HERO/SQ010/SH020/comp/v003/render.exr
 * ↳ matches project=HERO, sequence=SQ010, shot=SH020
 *
 * The pattern is matched relative to a configured "show root" path.
 */

const path = require('path');
const fs = require('fs');

let _db = null;

class PathMatchService {

    /**
     * Set the database module (dependency injection).
     */
    static setDatabase(database) {
        _db = database;
    }

    static _getDb() {
        if (!_db) throw new Error('PathMatchService: database not initialized');
        return _db.getDb();
    }

    static _getSetting(key) {
        if (!_db) throw new Error('PathMatchService: database not initialized');
        return _db.getSetting(key);
    }

    /**
     * Get the configured path pattern.
     * Default: "{project}/{sequence}/{shot}"
     * Tokens: {project}, {sequence}, {shot}, {role}
     */
    static getPattern() {
        return this._getSetting('flow_path_pattern') || '{project}/{sequence}/{shot}';
    }

    /**
     * Get the configured show root (base path that the pattern is relative to).
     * E.g., "/shows" or "Z:\Projects"
     */
    static getShowRoot() {
        return this._getSetting('flow_show_root') || '';
    }

    /**
     * Parse a file path using the configured pattern.
     * Returns extracted tokens or null if no match.
     *
     * @param {string} filePath — Absolute path to the media file
     * @returns {object|null} — { project, sequence, shot, role } (any may be null)
     */
    static parsePath(filePath) {
        const showRoot = this.getShowRoot();
        const pattern = this.getPattern();

        if (!showRoot || !pattern) return null;

        // Normalize paths to forward slashes for cross-platform matching
        const normFile = filePath.replace(/\\/g, '/');
        const normRoot = showRoot.replace(/\\/g, '/').replace(/\/+$/, '');

        // Must be under the show root
        if (!normFile.startsWith(normRoot + '/')) return null;

        // Get the relative portion after the show root
        const relative = normFile.slice(normRoot.length + 1);
        const relParts = relative.split('/');

        // Parse the pattern into an ordered list of token positions
        const patternParts = pattern.replace(/\\/g, '/').split('/');
        const tokens = {};

        for (let i = 0; i < patternParts.length; i++) {
            const part = patternParts[i];
            const match = part.match(/^\{(\w+)\}$/);
            if (match && i < relParts.length) {
                tokens[match[1]] = relParts[i];
            }
        }

        if (Object.keys(tokens).length === 0) return null;

        return {
            project:  tokens.project  || null,
            sequence: tokens.sequence || null,
            shot:     tokens.shot     || null,
            role:     tokens.role     || null,
        };
    }

    /**
     * Look up CAM database records for parsed path tokens.
     * Matches by code or name (case-insensitive).
     *
     * @param {object} tokens — { project, sequence, shot, role }
     * @returns {object} — { projectId, sequenceId, shotId, roleId } (any may be null)
     */
    static resolveTokens(tokens) {
        const db = this._getDb();
        const result = { projectId: null, sequenceId: null, shotId: null, roleId: null };

        if (!tokens) return result;

        // Match project by code or name (case-insensitive)
        if (tokens.project) {
            const proj = db.prepare(
                'SELECT id FROM projects WHERE code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE'
            ).get(tokens.project, tokens.project);
            if (proj) result.projectId = proj.id;
        }

        // Match sequence (scoped to project)
        if (tokens.sequence && result.projectId) {
            const seq = db.prepare(
                'SELECT id FROM sequences WHERE (code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE) AND project_id = ?'
            ).get(tokens.sequence, tokens.sequence, result.projectId);
            if (seq) result.sequenceId = seq.id;
        }

        // Match shot (scoped to project, optionally to sequence)
        if (tokens.shot && result.projectId) {
            let shot;
            if (result.sequenceId) {
                shot = db.prepare(
                    'SELECT id FROM shots WHERE (code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE) AND sequence_id = ?'
                ).get(tokens.shot, tokens.shot, result.sequenceId);
            }
            if (!shot) {
                shot = db.prepare(
                    'SELECT id FROM shots WHERE (code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE) AND project_id = ?'
                ).get(tokens.shot, tokens.shot, result.projectId);
            }
            if (shot) result.shotId = shot.id;
        }

        // Match role by code
        if (tokens.role) {
            const role = db.prepare(
                'SELECT id FROM roles WHERE code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE'
            ).get(tokens.role, tokens.role);
            if (role) result.roleId = role.id;
        }

        return result;
    }

    /**
     * Auto-match a single asset's file path to project/sequence/shot/role.
     * Updates the asset record if matches are found.
     *
     * @param {number} assetId — Asset ID to match
     * @returns {object} — { matched: boolean, tokens, resolved }
     */
    static matchAsset(assetId) {
        const db = this._getDb();
        const asset = db.prepare('SELECT id, file_path, project_id, sequence_id, shot_id, role_id FROM assets WHERE id = ?').get(assetId);
        if (!asset) return { matched: false, error: 'Asset not found' };

        const tokens = this.parsePath(asset.file_path);
        if (!tokens) return { matched: false, tokens: null, reason: 'Path did not match pattern' };

        const resolved = this.resolveTokens(tokens);
        if (!resolved.projectId) return { matched: false, tokens, reason: 'No matching project found' };

        // Only update fields that are currently unset (don't overwrite manual assignments)
        const updates = [];
        const params = [];

        if (!asset.project_id && resolved.projectId) {
            updates.push('project_id = ?');
            params.push(resolved.projectId);
        }
        if (!asset.sequence_id && resolved.sequenceId) {
            updates.push('sequence_id = ?');
            params.push(resolved.sequenceId);
        }
        if (!asset.shot_id && resolved.shotId) {
            updates.push('shot_id = ?');
            params.push(resolved.shotId);
        }
        if (!asset.role_id && resolved.roleId) {
            updates.push('role_id = ?');
            params.push(resolved.roleId);
        }

        if (updates.length > 0) {
            updates.push('updated_at = datetime("now")');
            params.push(assetId);
            db.prepare(`UPDATE assets SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        }

        return { matched: true, tokens, resolved, updatedFields: updates.length };
    }

    /**
     * Auto-match ALL assets that don't have a project assignment yet.
     * Useful after a bulk scan-and-register or a Flow sync.
     *
     * @param {object} [opts] — { projectId: limit to specific project }
     * @returns {object} — { matched, skipped, errors, total }
     */
    static matchAllUnassigned(opts = {}) {
        const db = this._getDb();
        let sql = 'SELECT id, file_path FROM assets WHERE project_id IS NULL';
        const params = [];

        if (opts.projectId) {
            // Also match assets that already have this project but are missing sequence/shot
            sql = 'SELECT id, file_path FROM assets WHERE (project_id IS NULL OR (project_id = ? AND (sequence_id IS NULL OR shot_id IS NULL)))';
            params.push(opts.projectId);
        }

        const assets = db.prepare(sql).all(...params);
        let matched = 0, skipped = 0, errors = 0;

        for (const asset of assets) {
            try {
                const result = this.matchAsset(asset.id);
                if (result.matched && result.updatedFields > 0) {
                    matched++;
                } else {
                    skipped++;
                }
            } catch (err) {
                errors++;
            }
        }

        return { matched, skipped, errors, total: assets.length };
    }

    /**
     * Recursively scan a directory tree, register all media files in-place,
     * and auto-match them to project/sequence/shot.
     *
     * @param {string} rootDir — Root directory to scan
     * @param {object} [opts] — { dryRun: boolean, maxFiles: number }
     * @returns {object} — { registered, matched, skipped, errors, files[] }
     */
    static scanAndRegisterTree(rootDir, opts = {}) {
        const { isMediaFile, detectMediaType } = require('../../../src/utils/mediaTypes');
        const ThumbnailService = require('../../../src/services/ThumbnailService');
        const db = this._getDb();
        const maxFiles = opts.maxFiles || 50000;
        const dryRun = opts.dryRun || false;

        // Recursively collect all media files
        const mediaFiles = [];
        const scanDir = (dir) => {
            if (mediaFiles.length >= maxFiles) return;
            try {
                const entries = fs.readdirSync(dir);
                for (const entry of entries) {
                    if (entry.startsWith('.') || entry.startsWith('_')) continue;
                    const fullPath = path.join(dir, entry);
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.isDirectory()) {
                            scanDir(fullPath);
                        } else if (stat.isFile() && isMediaFile(entry)) {
                            mediaFiles.push({ path: fullPath, size: stat.size, name: entry });
                        }
                    } catch {}
                }
            } catch {}
        };
        scanDir(rootDir);

        if (dryRun) {
            // Preview mode: just show what would be registered
            const previews = mediaFiles.map(f => {
                const tokens = this.parsePath(f.path);
                const resolved = tokens ? this.resolveTokens(tokens) : null;
                return {
                    file: f.path,
                    tokens,
                    resolved,
                    wouldMatch: resolved && resolved.projectId ? true : false,
                };
            });
            return { dryRun: true, total: mediaFiles.length, files: previews };
        }

        // Register each file as an asset (skip if file_path already exists)
        let registered = 0, matched = 0, skipped = 0, errors = 0;
        const existingPaths = new Set(
            db.prepare('SELECT file_path FROM assets').all().map(a => a.file_path)
        );

        const insertAsset = db.prepare(`
            INSERT INTO assets (
                project_id, sequence_id, shot_id, role_id,
                original_name, vault_name, file_path, relative_path,
                media_type, file_ext, file_size,
                is_linked, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
        `);

        const registerBatch = db.transaction((files) => {
            for (const f of files) {
                try {
                    // Skip already-registered files
                    if (existingPaths.has(f.path)) {
                        skipped++;
                        continue;
                    }

                    const ext = path.extname(f.name).toLowerCase();
                    const { type: mediaType } = detectMediaType(f.name);

                    // Parse path and resolve to project/sequence/shot
                    const tokens = this.parsePath(f.path);
                    const resolved = tokens ? this.resolveTokens(tokens) : {};

                    const projectId = resolved.projectId || null;
                    const sequenceId = resolved.sequenceId || null;
                    const shotId = resolved.shotId || null;
                    const roleId = resolved.roleId || null;

                    // Use show root for relative path if available
                    const showRoot = this.getShowRoot();
                    const relativePath = showRoot ? path.relative(showRoot, f.path) : f.path;

                    insertAsset.run(
                        projectId, sequenceId, shotId, roleId,
                        f.name,       // original_name
                        f.name,       // vault_name (same — not renamed)
                        f.path,       // file_path (absolute)
                        relativePath,
                        mediaType,
                        ext,
                        f.size
                    );

                    registered++;
                    if (projectId) matched++;
                } catch (err) {
                    errors++;
                }
            }
        });

        registerBatch(mediaFiles);

        // Queue thumbnail generation for newly registered assets (async, don't block)
        if (registered > 0) {
            try {
                const newAssets = db.prepare(
                    'SELECT id, file_path, media_type FROM assets WHERE thumbnail_path IS NULL AND is_linked = 1 ORDER BY id DESC LIMIT ?'
                ).all(registered);

                // Spawn thumbnail generation asynchronously
                setTimeout(() => {
                    for (const a of newAssets) {
                        try {
                            ThumbnailService.generateThumbnail(a.file_path, a.id);
                        } catch {}
                    }
                }, 100);
            } catch {}
        }

        return {
            success: true,
            registered,
            matched,
            skipped,
            errors,
            total: mediaFiles.length,
        };
    }
}

module.exports = PathMatchService;
