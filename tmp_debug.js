const {initDb, getDb} = require('./src/database');
initDb();
const db = getDb();
const r = db.prepare("SELECT vault_name, file_path, role_id FROM assets WHERE vault_name LIKE '%comfyui%' ORDER BY vault_name DESC LIMIT 10").all();
console.table(r.map(a => ({ name: a.vault_name, path: a.file_path ? a.file_path.substring(0,80) : 'NULL', role: a.role_id })));
const count = db.prepare("SELECT COUNT(*) as cnt FROM assets WHERE vault_name LIKE '%comfyui%'").get();
console.log('Total comfyui assets:', count.cnt);
