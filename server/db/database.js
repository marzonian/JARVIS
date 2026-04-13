/**
 * McNair Mindset by 3130
 * Database Connection & Initialization
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'mcnair.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db = null;

/**
 * Get database connection (singleton).
 * Creates database and tables if they don't exist.
 */
function getDB() {
  if (_db) return _db;

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  
  // Performance settings
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  // Initialize schema
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  _db.exec(schema);

  console.log(`[3130] Database initialized: ${DB_PATH}`);
  return _db;
}

/**
 * Close database connection.
 */
function closeDB() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Run this file directly to initialize the database.
 */
if (require.main === module) {
  const db = getDB();
  
  // Print table info
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log('\n[3130] McNair Mindset Database');
  console.log('─'.repeat(40));
  console.log(`Tables: ${tables.map(t => t.name).join(', ')}`);
  console.log(`Path: ${DB_PATH}`);
  console.log('─'.repeat(40));
  
  closeDB();
  console.log('\n✅ Database ready.\n');
}

module.exports = { getDB, closeDB, DB_PATH };
