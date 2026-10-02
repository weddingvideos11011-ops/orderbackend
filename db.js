import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const parseDatabaseUrl = () => {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL
  if (!databaseUrl) return null

  try {
    const parsed = new URL(databaseUrl)
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\/+/, '')),
    }
  } catch {
    return null
  }
}

const parsedDatabaseUrl = parseDatabaseUrl()

const rawDbHost = process.env.DB_HOST || ''
const normalizedDbHost = rawDbHost.includes(':') && !rawDbHost.startsWith('[') ? rawDbHost.split(':')[0] : rawDbHost
const normalizedDbPort = Number(process.env.DB_PORT || (rawDbHost.includes(':') && !rawDbHost.startsWith('[') ? rawDbHost.split(':').at(-1) : undefined) || parsedDatabaseUrl?.port || 3306)

const pool = mysql.createPool({
  host: parsedDatabaseUrl?.host || normalizedDbHost || 'localhost',
  port: Number(parsedDatabaseUrl?.port || normalizedDbPort || 3306),
  user: parsedDatabaseUrl?.user || process.env.DB_USER || 'root',
  password: parsedDatabaseUrl?.password || process.env.DB_PASSWORD || '',
  database: parsedDatabaseUrl?.database || process.env.DB_NAME || 'homekind',
  ssl: process.env.DB_HOST?.includes('rlwy.net') || process.env.DATABASE_URL?.includes('rlwy.net') ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

export async function initializeDatabase() {
  const connection = await pool.getConnection()
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS categories (
      id VARCHAR(80) PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`)
    await connection.query(`CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      category_id VARCHAR(80) NOT NULL,
      size VARCHAR(40) NOT NULL,
      price DECIMAL(10, 2) NOT NULL,
      accent VARCHAR(20) NOT NULL,
      image TEXT NOT NULL,
      description TEXT NOT NULL,
      tags JSON NOT NULL,
      is_featured BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_product_category FOREIGN KEY (category_id) REFERENCES categories(id)
    )`)

    const [columns] = await connection.query('SHOW COLUMNS FROM products')
    const columnNames = new Set(columns.map((column) => column.Field))
    if (!columnNames.has('category_id')) {
      await connection.query('ALTER TABLE products ADD COLUMN category_id VARCHAR(80) NULL AFTER name')
    }
    if (!columnNames.has('is_featured')) {
      await connection.query('ALTER TABLE products ADD COLUMN is_featured BOOLEAN NOT NULL DEFAULT FALSE')
    }
    if (!columnNames.has('sort_order')) {
      await connection.query('ALTER TABLE products ADD COLUMN sort_order INT NOT NULL DEFAULT 0')
    }

    if (columnNames.has('category')) {
      await connection.query(`INSERT INTO categories (id, name)
        SELECT DISTINCT LOWER(REPLACE(category, ' ', '-')), category FROM products
        ON DUPLICATE KEY UPDATE name = VALUES(name)`)
      await connection.query(`UPDATE products
        SET category_id = LOWER(REPLACE(category, ' ', '-')) WHERE category_id IS NULL`)
      await connection.query('ALTER TABLE products MODIFY category_id VARCHAR(80) NOT NULL')
      const [constraints] = await connection.query(`SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'category_id' AND REFERENCED_TABLE_NAME = 'categories'`)
      if (!constraints.length) {
        await connection.query(`ALTER TABLE products ADD CONSTRAINT fk_product_category
          FOREIGN KEY (category_id) REFERENCES categories(id)`)
      }
    }

    await connection.query(`CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`)
    await connection.query(`CREATE TABLE IF NOT EXISTS quote_requests (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      product_id VARCHAR(64) NOT NULL,
      name VARCHAR(160) NOT NULL,
      email VARCHAR(255) NOT NULL,
      notes TEXT,
      status ENUM('pending', 'fulfilled') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_quote_product FOREIGN KEY (product_id) REFERENCES products(id)
    )`)
    await connection.query(`CREATE TABLE IF NOT EXISTS contact_requests (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(40),
      message TEXT NOT NULL,
      status ENUM('pending', 'fulfilled') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`)

    const [quoteColumns] = await connection.query('SHOW COLUMNS FROM quote_requests')
    const quoteStatus = quoteColumns.find((column) => column.Field === 'status')
    if (quoteStatus && !quoteStatus.Type.includes("'fulfilled'")) {
      await connection.query("ALTER TABLE quote_requests MODIFY status ENUM('new', 'contacted', 'closed', 'pending', 'fulfilled') NOT NULL DEFAULT 'pending'")
      await connection.query("UPDATE quote_requests SET status = 'pending' WHERE status IN ('new', 'contacted')")
      await connection.query("UPDATE quote_requests SET status = 'fulfilled' WHERE status = 'closed'")
      await connection.query("ALTER TABLE quote_requests MODIFY status ENUM('pending', 'fulfilled') NOT NULL DEFAULT 'pending'")
    }

    const [contactColumns] = await connection.query('SHOW COLUMNS FROM contact_requests')
    if (!contactColumns.some((column) => column.Field === 'status')) {
      await connection.query("ALTER TABLE contact_requests ADD COLUMN status ENUM('pending', 'fulfilled') NOT NULL DEFAULT 'pending'")
    }
  } finally {
    connection.release()
  }
}

export default pool
