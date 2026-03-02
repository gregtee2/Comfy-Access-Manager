/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Fix collision-suffixed filenames: v002_02 → v003, v002_03 → v004, etc.
 *
 * Groups files by their base pattern (e.g. EDA1500_ai_v) and renumbers
 * them as proper incremental versions. Also renames on disk.
 */

const fs = require('fs');
const path = require('path');
const { initDb, getDb } = require('../src/database');

async function main() {
    await initDb();
    const db = getDb();

    // Find all collision-suffixed assets
    const all = db.prepare('SELECT id, vault_name, file_path, relative_path FROM assets').all();
    const bad = all.filter(r => /_v\d{3}_\d{2,}\./.test(r.vault_name));

    if (bad.length === 0) {
        console.log('✅ No collision-suffixed files found. All clean!');
        return;
    }

    console.log(`Found ${bad.length} collision-suffixed assets to fix:\n`);

    // Group by base pattern (e.g. "EDA1500_ai_v" in directory "Z:\MediaVault\AP1\EDA\EDA1500\video")
    const groups = {};
    for (const row of bad) {
        const ext = path.extname(row.vault_name);
        const base = path.basename(row.vault_name, ext);
        const match = base.match(/^(.+_v)\d{3}_\d{2,}$/);
        if (!match) continue;

        const prefix = match[1]; // e.g. "EDA1500_ai_v"
        const dir = path.dirname(row.file_path);
        const key = `${dir}||${prefix}||${ext}`;

        if (!groups[key]) groups[key] = { dir, prefix, ext, assets: [] };
        groups[key].assets.push(row);
    }

    let renamed = 0, errors = 0;

    for (const [key, group] of Object.entries(groups)) {
        const { dir, prefix, ext, assets } = group;

        // Find the current max clean version in this directory
        let maxVer = 0;
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                const fBase = path.basename(f, path.extname(f));
                if (fBase.startsWith(prefix)) {
                    const vm = fBase.match(/v(\d+)$/);
                    if (vm) {
                        const v = parseInt(vm[1]);
                        if (v > maxVer) maxVer = v;
                    }
                }
            }
        }

        console.log(`\nGroup: ${prefix}*${ext} in ${dir}`);
        console.log(`  Current max version: v${String(maxVer).padStart(3, '0')}`);

        // Sort assets by ID (chronological order)
        assets.sort((a, b) => a.id - b.id);

        for (const asset of assets) {
            maxVer++;
            const newVaultName = `${prefix}${String(maxVer).padStart(3, '0')}${ext}`;
            const newFilePath = path.join(dir, newVaultName);
            const vaultRoot = dir.split(path.sep).slice(0, 2).join(path.sep); // Approximate
            // Compute new relative path: replace filename in existing relative_path
            const newRelativePath = asset.relative_path
                ? path.join(path.dirname(asset.relative_path), newVaultName)
                : newVaultName;

            console.log(`  [${asset.id}] ${asset.vault_name} → ${newVaultName}`);

            try {
                // Rename on disk
                if (fs.existsSync(asset.file_path)) {
                    if (fs.existsSync(newFilePath)) {
                        console.log(`    ⚠️  SKIP: target already exists on disk!`);
                        errors++;
                        continue;
                    }
                    fs.renameSync(asset.file_path, newFilePath);
                } else {
                    console.log(`    ⚠️  Source file not found on disk, updating DB only`);
                }

                // Update DB
                db.prepare('UPDATE assets SET vault_name = ?, file_path = ?, relative_path = ? WHERE id = ?')
                    .run(newVaultName, newFilePath, newRelativePath, asset.id);

                // Rename thumbnail if exists
                const thumbPath = path.join(__dirname, '..', 'thumbnails', `thumb_${asset.id}.jpg`);
                // Thumbnail doesn't need renaming (keyed by ID, not filename)

                renamed++;
            } catch (err) {
                console.log(`    ❌ Error: ${err.message}`);
                errors++;
            }
        }
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`✅ Renamed: ${renamed}`);
    if (errors > 0) console.log(`⚠️  Errors: ${errors}`);
    console.log('Done!');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
