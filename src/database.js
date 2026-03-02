/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * MediaVault - SQLite Database Layer (better-sqlite3)
 * Disk-backed, high-performance SQLite driver
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.CAM_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LOCAL_DB_PATH = path.join(DATA_DIR, 'mediavault.db');

let dbPath = LOCAL_DB_PATH;   // Active DB path (may point to shared location)
let db = null;                // better-sqlite3 instance

// ─── Local Config (machine-specific, NOT in DB) ───

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('[DB] Failed to read config.json:', e.message);
    }
    return {};
}

function saveConfig(config) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('[DB] Failed to write config.json:', e.message);
    }
}

function resolveDbPath() {
    const config = loadConfig();
    if (config.shared_db_path) {
        const shared = path.join(config.shared_db_path, 'mediavault.db');
        try {
            if (!fs.existsSync(config.shared_db_path)) {
                console.warn(`[DB] Shared path not accessible: ${config.shared_db_path} — falling back to local`);
                return LOCAL_DB_PATH;
            }
            return shared;
        } catch (e) {
            console.warn(`[DB] Shared path error: ${e.message} — falling back to local`);
            return LOCAL_DB_PATH;
        }
    }
    return LOCAL_DB_PATH;
}

// ─── Async Init (call once in server.js before starting) ───

async function initDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Resolve DB path (local or shared)
    dbPath = resolveDbPath();
    const isShared = dbPath !== LOCAL_DB_PATH;
    console.log(`[DB] Using ${isShared ? 'SHARED' : 'local'} database: ${dbPath}`);

    // If shared path has no DB yet, copy local DB there (first-time share setup)
    if (isShared && !fs.existsSync(dbPath) && fs.existsSync(LOCAL_DB_PATH)) {
        console.log('[DB] Copying local database to shared location...');
        fs.copyFileSync(LOCAL_DB_PATH, dbPath);
    }

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL'); // Better concurrency for disk-backed DB
    
    runMigrations(db);

    return db;
}

// ─── External Change Detection (Shared DB Sync) ───
// With better-sqlite3 and WAL mode, we don't need to manually poll and reload
// the entire database into memory. The driver handles concurrent reads/writes.

function reloadFromDisk() {
    // No-op for better-sqlite3, it reads from disk automatically
    console.log('[DB] reloadFromDisk called (no-op for better-sqlite3)');
}

function getDb() {
    if (!db) throw new Error('Database not initialized — call initDb() first');
    return db;
}

// ─── Schema ───

function runMigrations(wrapper) {
    wrapper.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            code TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL DEFAULT 'flexible',
            description TEXT DEFAULT '',
            thumbnail_path TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sequences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            description TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(project_id, code)
        );

        CREATE TABLE IF NOT EXISTS shots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            description TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(sequence_id, code)
        );

        CREATE TABLE IF NOT EXISTS assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            sequence_id INTEGER REFERENCES sequences(id) ON DELETE SET NULL,
            shot_id INTEGER REFERENCES shots(id) ON DELETE SET NULL,
            original_name TEXT NOT NULL,
            vault_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            file_ext TEXT NOT NULL,
            file_size INTEGER DEFAULT 0,
            width INTEGER,
            height INTEGER,
            duration REAL,
            fps REAL,
            codec TEXT,
            take_number INTEGER,
            version INTEGER DEFAULT 1,
            thumbnail_path TEXT,
            proxy_path TEXT,
            tags TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            metadata TEXT DEFAULT '{}',
            comfyui_node_id TEXT,
            comfyui_workflow TEXT,
            starred INTEGER DEFAULT 0,
            status TEXT DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS watch_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            auto_import INTEGER DEFAULT 0,
            file_pattern TEXT DEFAULT '*',
            last_scanned TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comfyui_mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id TEXT,
            node_id TEXT NOT NULL,
            asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            file_path TEXT NOT NULL,
            last_used TEXT DEFAULT (datetime('now')),
            UNIQUE(workflow_id, node_id)
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_id INTEGER,
            details TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            code TEXT NOT NULL UNIQUE,
            color TEXT DEFAULT '#888888',
            icon TEXT DEFAULT '🎭',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
        CREATE INDEX IF NOT EXISTS idx_assets_sequence ON assets(sequence_id);
        CREATE INDEX IF NOT EXISTS idx_assets_shot ON assets(shot_id);
        CREATE INDEX IF NOT EXISTS idx_assets_media_type ON assets(media_type);
        CREATE INDEX IF NOT EXISTS idx_assets_vault_name ON assets(vault_name);
        CREATE INDEX IF NOT EXISTS idx_sequences_project ON sequences(project_id);
        CREATE INDEX IF NOT EXISTS idx_shots_sequence ON shots(sequence_id);
        CREATE INDEX IF NOT EXISTS idx_comfyui_mappings_node ON comfyui_mappings(node_id);
    `);

    // ─── Add role_id column to assets if missing (migration) ───
    try {
        const cols = [];
        let st = wrapper.prepare('PRAGMA table_info(assets)');
        for (const row of st.iterate()) cols.push(row.name);
        if (!cols.includes('role_id')) {
            wrapper.exec('ALTER TABLE assets ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL');
        }
        // Create index after column exists
        wrapper.exec('CREATE INDEX IF NOT EXISTS idx_assets_role ON assets(role_id)');
    } catch (_) { /* column already exists */ }

    // ─── Add is_linked column to assets if missing (linked/reference import) ───
    try {
        const assetCols2 = [];
        let stLink = wrapper.prepare('PRAGMA table_info(assets)');
        for (const row of stLink.iterate()) assetCols2.push(row.name);
        if (!assetCols2.includes('is_linked')) {
            wrapper.exec('ALTER TABLE assets ADD COLUMN is_linked INTEGER DEFAULT 0');
        }
    } catch (_) { /* column already exists */ }

    // ─── Add status column to assets if missing ───
    try {
        const assetCols3 = [];
        let stStatus = wrapper.prepare('PRAGMA table_info(assets)');
        for (const row of stStatus.iterate()) assetCols3.push(row.name);
        if (!assetCols3.includes('status')) {
            wrapper.exec("ALTER TABLE assets ADD COLUMN status TEXT DEFAULT NULL");
        }
    } catch (_) { /* column already exists */ }

    // ─── Fix: ensure status column defaults to NULL, not 'WIP' ───
    // SQLite can't ALTER COLUMN defaults, so we clear any lingering WIP
    // and rely on explicit NULL in INSERT statements for new assets.
    try {
        const statusCol = wrapper.prepare('PRAGMA table_info(assets)').all().find(c => c.name === 'status');
        if (statusCol && statusCol.dflt_value === "'WIP'") {
            // Clear any auto-assigned WIP (user hasn't explicitly set these)
            wrapper.exec("UPDATE assets SET status = NULL WHERE status = 'WIP'");
            console.log('[DB] Cleared auto-assigned WIP statuses (default changed to NULL)');
        }
    } catch (_) {}

    // ─── Add sequence + derivative columns to assets ───
    const seqDerivCols = {
        is_sequence:     'INTEGER DEFAULT 0',
        frame_start:     'INTEGER',
        frame_end:       'INTEGER',
        frame_count:     'INTEGER',
        frame_pattern:   'TEXT',
        parent_asset_id: 'INTEGER',
        is_derivative:   'INTEGER DEFAULT 0',
    };
    try {
        const assetColsSD = [];
        let stSD = wrapper.prepare('PRAGMA table_info(assets)');
        for (const row of stSD.iterate()) assetColsSD.push(row.name);
        for (const [col, typedef] of Object.entries(seqDerivCols)) {
            if (!assetColsSD.includes(col)) {
                wrapper.exec(`ALTER TABLE assets ADD COLUMN ${col} ${typedef}`);
            }
        }
        wrapper.exec('CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_asset_id)');
        wrapper.exec('CREATE INDEX IF NOT EXISTS idx_assets_sequence_flag ON assets(is_sequence)');
    } catch (_) { /* columns already exist */ }

    // ─── Add flow_id columns for Flow Production Tracking integration ───
    const flowTables = ['projects', 'sequences', 'shots', 'roles'];
    for (const table of flowTables) {
        try {
            const cols = [];
            let st2 = wrapper.prepare(`PRAGMA table_info(${table})`);
            for (const row of st2.iterate()) cols.push(row.name);
            if (!cols.includes('flow_id')) {
                wrapper.exec(`ALTER TABLE ${table} ADD COLUMN flow_id INTEGER`);
                wrapper.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_flow_id ON ${table}(flow_id)`);
            }
        } catch (_) { /* column already exists */ }
    }

    // ─── Create flow_tasks table for Flow Production Tracking task sync ───
    wrapper.exec(`CREATE TABLE IF NOT EXISTS flow_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_id INTEGER UNIQUE NOT NULL,
        project_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT DEFAULT '',
        description TEXT DEFAULT '',
        step_flow_id INTEGER,
        step_name TEXT,
        entity_type TEXT,
        entity_flow_id INTEGER,
        entity_name TEXT,
        assignees TEXT DEFAULT '[]',
        start_date TEXT,
        due_date TEXT,
        est_minutes INTEGER,
        logged_minutes INTEGER,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
    )`);
    wrapper.exec('CREATE INDEX IF NOT EXISTS idx_flow_tasks_project ON flow_tasks(project_id)');
    wrapper.exec('CREATE INDEX IF NOT EXISTS idx_flow_tasks_flow_id ON flow_tasks(flow_id)');
    wrapper.exec('CREATE INDEX IF NOT EXISTS idx_flow_tasks_entity ON flow_tasks(entity_type, entity_flow_id)');

    // ─── Add naming_convention column to projects (Shot Builder) ───
    try {
        const projCols = [];
        let stProj = wrapper.prepare('PRAGMA table_info(projects)');
        for (const row of stProj.iterate()) projCols.push(row.name);
        if (!projCols.includes('naming_convention')) {
            wrapper.exec("ALTER TABLE projects ADD COLUMN naming_convention TEXT DEFAULT NULL");
        }
        if (!projCols.includes('episode')) {
            wrapper.exec("ALTER TABLE projects ADD COLUMN episode TEXT DEFAULT ''");
        }
        if (!projCols.includes('archived')) {
            wrapper.exec("ALTER TABLE projects ADD COLUMN archived INTEGER DEFAULT 0");
        }
    } catch (_) { /* column already exists */ }

    // ─── Seed default roles if roles table is empty ───
    const roleCount = wrapper.prepare('SELECT COUNT(*) as count FROM roles').get();
    if (roleCount.count === 0) {
        const insertRole = wrapper.prepare('INSERT OR IGNORE INTO roles (name, code, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
        const defaultRoles = [
            ['Comp',       'COMP',       '#4fc3f7', '🎨', 1],
            ['Light',      'LIGHT',      '#fff176', '💡', 2],
            ['Anim',       'ANIM',       '#81c784', '🏃', 3],
            ['FX',         'FX',         '#ff8a65', '✨', 4],
            ['Enviro',     'ENVIRO',     '#a5d6a7', '🌲', 5],
            ['Layout',     'LAYOUT',     '#ce93d8', '📐', 6],
            ['Matchmove',  'MATCHMOVE',  '#90a4ae', '📍', 7],
            ['Roto',       'ROTO',       '#f48fb1', '✂️', 8],
        ];
        const seedRoles = wrapper.transaction((roles) => {
            for (const r of roles) insertRole.run(...r);
        });
        seedRoles(defaultRoles);
    }

    // ─── Users + Project Hidden tables (access control — blacklist model) ───
    wrapper.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            is_admin INTEGER DEFAULT 0,
            pin_hash TEXT DEFAULT NULL,
            color TEXT DEFAULT '#888888',
            avatar TEXT DEFAULT '👤',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS project_hidden (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            UNIQUE(user_id, project_id)
        );

        CREATE INDEX IF NOT EXISTS idx_project_hidden_user ON project_hidden(user_id);
        CREATE INDEX IF NOT EXISTS idx_project_hidden_project ON project_hidden(project_id);
    `);

    // Migration: add pin_hash column if missing (for existing DBs)
    try {
        wrapper.prepare('SELECT pin_hash FROM users LIMIT 1').get();
    } catch (_) {
        try { wrapper.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT DEFAULT NULL'); } catch (_2) {}
    }

    // Migration: drop old whitelist table if it exists (pre-v1.3.0)
    try { wrapper.exec('DROP TABLE IF EXISTS project_access'); } catch (_) {}

    // ─── Crates (asset staging for export) ───
    wrapper.exec(`
        CREATE TABLE IF NOT EXISTS crates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS crate_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            crate_id INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
            asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            added_at TEXT DEFAULT (datetime('now')),
            UNIQUE(crate_id, asset_id)
        );

        CREATE INDEX IF NOT EXISTS idx_crate_items_crate ON crate_items(crate_id);
        CREATE INDEX IF NOT EXISTS idx_crate_items_asset ON crate_items(asset_id);
    `);

    // ─── Overlay Presets (burn-in text overlays for export) ───
    wrapper.exec(`
        CREATE TABLE IF NOT EXISTS overlay_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            config TEXT NOT NULL DEFAULT '{}',
            is_default INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
    `);

    // ─── Review Sessions (RV sync review across hub/spoke) ───
    wrapper.exec(`
        CREATE TABLE IF NOT EXISTS review_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL UNIQUE,
            host_name TEXT NOT NULL,
            host_ip TEXT NOT NULL,
            host_port INTEGER NOT NULL DEFAULT 45128,
            status TEXT NOT NULL DEFAULT 'active',
            asset_ids TEXT DEFAULT '[]',
            project_id INTEGER,
            title TEXT,
            started_by TEXT,
            started_at TEXT DEFAULT (datetime('now')),
            ended_at TEXT,
            FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        CREATE INDEX IF NOT EXISTS idx_review_sessions_status ON review_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_review_sessions_key ON review_sessions(session_key);
    `);

    // ─── Review Notes (frame-accurate annotations on review sessions) ───
    wrapper.exec(`
        CREATE TABLE IF NOT EXISTS review_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            asset_id INTEGER,
            frame_number INTEGER,
            timecode TEXT,
            note_text TEXT NOT NULL,
            author TEXT NOT NULL,
            status TEXT DEFAULT 'open',
            annotation_image TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(session_id) REFERENCES review_sessions(id),
            FOREIGN KEY(asset_id) REFERENCES assets(id)
        );
        CREATE INDEX IF NOT EXISTS idx_review_notes_session ON review_notes(session_id);
        CREATE INDEX IF NOT EXISTS idx_review_notes_asset ON review_notes(asset_id);
    `);

    // ─── Migrations: add columns to existing tables ───
    // annotation_image column for review_notes (stores annotated frame snapshot path)
    try {
        const cols = wrapper.pragma('table_info(review_notes)');
        if (!cols.find(c => c.name === 'annotation_image')) {
            wrapper.exec(`ALTER TABLE review_notes ADD COLUMN annotation_image TEXT`);
            console.log('[DB] Added annotation_image column to review_notes');
        }
    } catch (e) { /* table might not exist yet — schema above will create it */ }

    // flow_note_id column for review_notes (tracks exported ShotGrid Note ID)
    try {
        const cols = wrapper.pragma('table_info(review_notes)');
        if (!cols.find(c => c.name === 'flow_note_id')) {
            wrapper.exec(`ALTER TABLE review_notes ADD COLUMN flow_note_id INTEGER`);
            console.log('[DB] Added flow_note_id column to review_notes');
        }
    } catch (e) { /* table might not exist yet */ }

    // Seed default Admin user if users table is empty
    const userCount = wrapper.prepare('SELECT COUNT(*) as count FROM users').get();
    if (userCount.count === 0) {
        wrapper.prepare('INSERT INTO users (name, is_admin, color, avatar) VALUES (?, ?, ?, ?)')
            .run('Admin', 1, '#4fc3f7', '👑');
    }

    // Seed defaults if settings table is empty
    const row = wrapper.prepare('SELECT COUNT(*) as count FROM settings').get();
    if (row.count === 0) {
        const insert = wrapper.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        const defaults = {
            vault_root: '',
            naming_template: '{project}_{sequence}_{shot}_{take}_{counter}',
            thumbnail_size: '320',
            proxy_enabled: 'false',
            proxy_resolution: '1280',
            comfyui_url: 'http://127.0.0.1:8188',
            comfyui_output_path: '',
            comfyui_watch_enabled: 'false',
            auto_thumbnail: 'true',
            default_project_type: 'flexible',
        };
        const insertMany = wrapper.transaction((entries) => {
            for (const [key, value] of entries) {
                insert.run(key, value);
            }
        });
        insertMany(Object.entries(defaults));
    }
}

// ─── Settings Helpers ───

function getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
    const rows = getDb().prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

// ─── Activity Log ───

function logActivity(action, entityType, entityId, details = {}) {
    getDb().prepare(
        'INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)'
    ).run(action, entityType, entityId, JSON.stringify(details));
}

function getRecentActivity(limit = 50) {
    return getDb().prepare(
        'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
}

// ─── Close gracefully ───

function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = {
    initDb,
    getDb,
    getSetting,
    setSetting,
    getAllSettings,
    logActivity,
    getRecentActivity,
    closeDb,
    loadConfig,
    saveConfig,
    resolveDbPath,
    reloadFromDisk,
    get dbPath() { return dbPath; },
    get DB_PATH() { return dbPath; },  // Backward compat
    CONFIG_PATH,
    DATA_DIR,
};
