import { getDB } from './src/db';

const db = getDB();
// @ts-ignore - Accessing private db instance for debugging
const reflection = db['db'].query('SELECT * FROM reflections ORDER BY created_at DESC LIMIT 1').get();

console.log(JSON.stringify(reflection, null, 2));
