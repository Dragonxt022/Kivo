import { getSqlite } from './src/core/database/connection';
const db = getSqlite();
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='product_complement_groups'").get();
console.log('Schema:', schema);
const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='product_complement_groups'").all();
console.log('Indexes:', JSON.stringify(indexes, null, 2));