/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * TARGETED fix for timestamp-named assets
 * Server must be STOPPED before running this!
 */
const fs = require('fs');
const path = require('path');
const { initDb, getDb } = require('../src/database');

async function main() {
    await initDb();
    const db = getDb();

    const videoDir = 'Z:\\MediaVault\\AP1\\EDA\\EDA1500\\video';
    const imageDir = 'Z:\\MediaVault\\AP1\\EDA\\EDA1500\\image';

    // ── Step 1: Undo damage to repo records (1570-1578) ──
    // The previous script incorrectly reassigned these to EDA1500 files
    console.log('=== Step 1: Restore broken repo records ===');
    const repoRecords = db.prepare('SELECT id, vault_name FROM assets WHERE id >= 1570 AND id <= 1578').all();
    for (const r of repoRecords) {
        // IDs 1570-1578 should mirror 1561-1569 (they're duplicate imports)
        const mirrorId = r.id - 9; // 1570 -> 1561, 1571 -> 1562, etc.
        const mirror = db.prepare('SELECT vault_name, file_path, relative_path FROM assets WHERE id = ?').get(mirrorId);
        if (mirror) {
            db.prepare('UPDATE assets SET vault_name = ?, file_path = ?, relative_path = ? WHERE id = ?')
                .run(mirror.vault_name, mirror.file_path, mirror.relative_path, r.id);
            console.log('  RESTORE:', r.id, r.vault_name, '->', mirror.vault_name);
        }
    }

    // ── Step 2: Directly assign the 9 timestamp records to orphan files ──
    console.log('\n=== Step 2: Fix timestamp records ===');

    const assignments = [
        { id: 1586, name: 'EDA1500_ai_v002_02.mp4', dir: videoDir },
        { id: 1587, name: 'EDA1500_ai_v002_03.mp4', dir: videoDir },
        { id: 1588, name: 'EDA1500_ai_v002_04.mp4', dir: videoDir },
        { id: 1589, name: 'EDA1500_ai_v002_05.mp4', dir: videoDir },
        { id: 1590, name: 'EDA1500_ai_v002_06.mp4', dir: videoDir },
        { id: 1592, name: 'EDA1500_layout_v001_02.png', dir: imageDir },
        { id: 1593, name: 'EDA1500_ai_v002_07.mp4', dir: videoDir },
        { id: 1594, name: 'EDA1500_ai_v002_08.mp4', dir: videoDir },
        { id: 1595, name: 'EDA1500_ai_v002_10.mp4', dir: videoDir },
    ];

    for (const a of assignments) {
        const filePath = path.join(a.dir, a.name);
        const relBase = a.dir.includes('video') ? 'AP1\\EDA\\EDA1500\\video' : 'AP1\\EDA\\EDA1500\\image';
        const relativePath = path.join(relBase, a.name);
        const exists = fs.existsSync(filePath);

        db.prepare('UPDATE assets SET vault_name = ?, file_path = ?, relative_path = ? WHERE id = ?')
            .run(a.name, filePath, relativePath, a.id);
        console.log('  ', exists ? '✓' : '✗', a.id, '->', a.name);
    }

    // ── Step 3: Verify ──
    console.log('\n=== Step 3: Verification ===');
    const all = db.prepare('SELECT id, vault_name, file_path FROM assets WHERE id >= 1586 AND id <= 1596').all();
    for (const a of all) {
        const exists = fs.existsSync(a.file_path) ? '✓' : '✗';
        console.log('  ', exists, a.id, a.vault_name);
    }

    // Check remaining timestamp names globally
    const remaining = db.prepare('SELECT id, vault_name FROM assets').all()
        .filter(r => /_\d{10,}\./.test(r.vault_name));
    console.log('\n  Remaining timestamp names:', remaining.length);

    // Check duplicate paths for these IDs
    const paths = all.map(a => a.file_path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    console.log('  Duplicate paths in range:', dupes.length);

    console.log('\n=== Done! ===');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
