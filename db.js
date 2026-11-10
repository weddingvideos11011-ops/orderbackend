import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const dbFile = process.env.DB_FILE || path.resolve(__dirname, '../database.sqlite')

// Open the SQLite database connection pool/instance
const dbPromise = open({
  filename: dbFile,
  driver: sqlite3.Database,
})

export async function initializeDatabase() {
  const db = await dbPromise

  // Enable foreign key constraints in SQLite
  await db.exec('PRAGMA foreign_keys = ON;')

  // Create tables using SQLite-compatible types
  await db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category_id TEXT NOT NULL,
      size TEXT NOT NULL,
      price REAL NOT NULL,
      accent TEXT NOT NULL,
      image TEXT NOT NULL,
      description TEXT NOT NULL,
      tags TEXT NOT NULL, -- Stored as JSON string
      is_featured INTEGER NOT NULL DEFAULT 0, -- SQLite uses 0/1 for booleans
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quote_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- Replaced ENUM with TEXT check constraint or default
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS contact_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

// Export a wrapper mimicking pool queries for easy compatibility
const pool = {
  async query(sql, params = []) {
    const db = await dbPromise
    // sqlite package uses .all() for SELECT and .run() for INSERT/UPDATE/DELETE
    const trimmedSql = sql.trim().toLowerCase()
    if (trimmedSql.startsWith('select') || trimmedSql.startsWith('show') || trimmedSql.startsWith('pragma')) {
      const rows = await db.all(sql, params)
      return [rows]
    } else {
      const result = await db.run(sql, params)
      return [{ affectedRows: result.changes, insertId: result.lastID }]
    }
  },
  async execute(sql, params = []) {
    return this.query(sql, params)
  },
  async getConnection() {
    const db = await dbPromise
    return {
      async query(sql, params = []) {
        const trimmedSql = sql.trim().toLowerCase()
        if (trimmedSql.startsWith('select') || trimmedSql.startsWith('show') || trimmedSql.startsWith('pragma')) {
          const rows = await db.all(sql, params)
          return [rows]
        } else {
          const result = await db.run(sql, params)
          return [{ affectedRows: result.changes, insertId: result.lastID }]
        }
      },
      release() {
        // No-op for SQLite single connection pool wrapper
      }
    }
  }
}

export default pool
