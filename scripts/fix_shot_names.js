/**
 * fix_shot_names.js — One-time migration script
 * 
 * Renames existing assets that use shot CODE (e.g. SH010) in their filename
 * to use the shot NAME (e.g. Risque) instead.
 * 
 * Updates: vault_name, file_path, relative_path in DB + renames actual file on disk.
 *
 * Usage:
 *   node scripts/fix_shot_names.js          # Dry run (preview only)
 *   node scripts/fix_shot_names.js --apply  # Actually rename files + update DB
 */

const path = require('path');
const fs = require('fs');
const { initDb, getDb } = require('../src/database');

const DRY_RUN = !process.argv.includes('--apply');

// Same sanitizer as naming.js
function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_').trim();
}

function main() {
    initDb();
    const db = getDb();

    if (DRY_RUN) {
        console.log('=== DRY RUN === (pass --apply to actually rename)\n');
    } else {
        console.log('=== APPLYING RENAMES ===\n');
    }

    // Get all shots
    const shots = db.prepare(`
        SELECT sh.id, sh.name, sh.code, sh.sequence_id, 
               seq.name as seq_name, p.name as proj_name
        FROM shots sh 
        JOIN sequences seq ON sh.sequence_id = seq.id 
        JOIN projects p ON sh.project_id = p.id
    `).all();

    let totalRenamed = 0;
    let totalErrors = 0;

    for (const shot of shots) {
        const safeName = sanitizeFilename(shot.name);
        const safeCode = sanitizeFilename(shot.code);

        // Skip if name and code produce the same filename token (case-insensitive)
        if (safeName.toLowerCase() === safeCode.toLowerCase()) {
            continue;
        }

        // Find assets for this shot whose vault_name starts with the shot code
        const assets = db.prepare(`
            SELECT id, vault_name, file_path, relative_path 
            FROM assets 
            WHERE shot_id = ? AND vault_name LIKE ?
        `).all(shot.id, safeCode + '%');

        if (assets.length === 0) continue;

        console.log(`Shot "${shot.name}" (${shot.code}) in ${shot.proj_name}/${shot.seq_name} — ${assets.length} assets`);

        for (const asset of assets) {
            // Replace code prefix with name in vault_name
            // e.g. "SH010_comfyui_v001.mp4" → "Risque_comfyui_v001.mp4"
            const newVaultName = safeName + asset.vault_name.slice(safeCode.length);

            // Build new file path
            const dir = path.dirname(asset.file_path);
            const newFilePath = path.join(dir, newVaultName);

            // Build new relative path
            let newRelativePath = asset.relative_path;
            if (asset.relative_path) {
                const relDir = path.dirname(asset.relative_path);
                newRelativePath = path.join(relDir, newVaultName);
            }

            if (DRY_RUN) {
                console.log(`  ${asset.vault_name}  →  ${newVaultName}`);
            } else {
                try {
                    // Rename actual file on disk (if it exists)
                    if (fs.existsSync(asset.file_path)) {
                        if (fs.existsSync(newFilePath)) {
                            console.log(`  SKIP (target exists): ${newVaultName}`);
                            totalErrors++;
                            continue;
                        }
                        fs.renameSync(asset.file_path, newFilePath);
                    } else {
                        console.log(`  WARN: File not found on disk: ${asset.file_path}`);
                        // Still update DB so names are correct
                    }

                    // Update database
                    db.prepare(`
                        UPDATE assets 
                        SET vault_name = ?, file_path = ?, relative_path = ?
                        WHERE id = ?
                    `).run(newVaultName, newFilePath, newRelativePath, asset.id);

                    totalRenamed++;
                } catch (err) {
                    console.log(`  ERROR: ${asset.vault_name} — ${err.message}`);
                    totalErrors++;
                }
            }
        }
        console.log('');
    }

    if (DRY_RUN) {
        const total = shots.reduce((sum, shot) => {
            const safeName = sanitizeFilename(shot.name);
            const safeCode = sanitizeFilename(shot.code);
            if (safeName.toLowerCase() === safeCode.toLowerCase()) return sum;
            return sum + db.prepare('SELECT COUNT(*) as c FROM assets WHERE shot_id = ? AND vault_name LIKE ?').get(shot.id, safeCode + '%').c;
        }, 0);
        console.log(`Total assets to rename: ${total}`);
        console.log('\nRun with --apply to execute the renames.');
    } else {
        console.log(`Done! Renamed: ${totalRenamed}, Errors: ${totalErrors}`);
    }
}

main();
