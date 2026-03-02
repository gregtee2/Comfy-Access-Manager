/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this file is strictly prohibited.
 * See LICENSE file for details.
 */
/**
 * Build script — Obfuscates frontend JS for production distribution.
 * 
 * Usage:
 *   node scripts/build.js          # Build obfuscated frontend
 *   node scripts/build.js --clean  # Remove obfuscated output
 * 
 * Source:  public/js/*.js  (your clean, readable code — never touched)
 * Output:  public/js-dist/*.js  (obfuscated versions served in production)
 * 
 * The server (server.js) checks NODE_ENV:
 *   - production  → serves from /js-dist/ (obfuscated)
 *   - development → serves from /js/ (clean source)
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC_DIR = path.join(__dirname, '..', 'public', 'js');
const DIST_DIR = path.join(__dirname, '..', 'public', 'js-dist');
const LIB_SRC = path.join(SRC_DIR, 'lib');
const LIB_DIST = path.join(DIST_DIR, 'lib');

// Obfuscation settings — balanced between protection and performance
const OBFUSCATION_OPTIONS = {
    // Naming
    renameGlobals: false,               // Don't rename globals (breaks window.* exports)
    identifierNamesGenerator: 'hexadecimal',
    
    // String protection
    stringArray: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,         // 75% of strings get encoded
    stringArrayEncoding: ['base64'],
    
    // Control flow
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5, // 50% of blocks get flattened
    
    // Dead code injection
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,    // 20% dead code (balance size vs protection)
    
    // Other transforms
    splitStrings: true,
    splitStringsChunkLength: 10,
    transformObjectKeys: true,
    numbersToExpressions: true,
    
    // Debug protection
    debugProtection: false,             // Don't block DevTools entirely (annoying for support)
    selfDefending: false,               // Don't crash on formatting (same reason)
    
    // Preserve functionality
    target: 'browser',
    sourceMap: false,                   // No source maps in production!
    compact: true,                      // Minify whitespace
    simplify: true,
    
    // Keep ES module syntax working (critical!)
    sourceType: 'module',
};

// ─── Clean ───
if (process.argv.includes('--clean')) {
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true });
        console.log('✅ Cleaned js-dist/');
    } else {
        console.log('Nothing to clean.');
    }
    process.exit(0);
}

// ─── Build ───
console.log('🔒 Building obfuscated frontend...\n');

// Create output dirs
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
if (!fs.existsSync(LIB_DIST)) fs.mkdirSync(LIB_DIST, { recursive: true });

// Get all JS files in public/js/ (not lib/)
const jsFiles = fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.js') && !fs.statSync(path.join(SRC_DIR, f)).isDirectory());

let successCount = 0;
let errorCount = 0;

for (const file of jsFiles) {
    const srcPath = path.join(SRC_DIR, file);
    const distPath = path.join(DIST_DIR, file);
    
    try {
        const source = fs.readFileSync(srcPath, 'utf8');
        const result = JavaScriptObfuscator.obfuscate(source, {
            ...OBFUSCATION_OPTIONS,
            identifiersPrefix: file.replace('.js', '').replace(/[^a-zA-Z]/g, '').slice(0, 4),
        });
        
        fs.writeFileSync(distPath, result.getObfuscatedCode(), 'utf8');
        
        const srcSize = (fs.statSync(srcPath).size / 1024).toFixed(1);
        const distSize = (fs.statSync(distPath).size / 1024).toFixed(1);
        console.log(`  ✅ ${file.padEnd(25)} ${srcSize}KB → ${distSize}KB`);
        successCount++;
    } catch (err) {
        console.error(`  ❌ ${file}: ${err.message}`);
        errorCount++;
    }
}

// Copy lib/ files as-is (third-party, already minified)
if (fs.existsSync(LIB_SRC)) {
    const libFiles = fs.readdirSync(LIB_SRC);
    for (const file of libFiles) {
        fs.copyFileSync(path.join(LIB_SRC, file), path.join(LIB_DIST, file));
        console.log(`  📋 lib/${file} (copied, third-party)`);
    }
}

console.log(`\n🔒 Done! ${successCount} files obfuscated, ${errorCount} errors.`);
if (errorCount === 0) {
    console.log('💡 Run with NODE_ENV=production to serve obfuscated files.');
    console.log('💡 Run "node scripts/build.js --clean" to remove obfuscated output.');
}
