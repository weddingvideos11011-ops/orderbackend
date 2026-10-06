import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool, { initializeDatabase } from './db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const app = express()
const port = Number(process.env.PORT || 3001)
const jwtSecret = process.env.JWT_SECRET || 'change-this-secret'

const allowedOrigins = [process.env.CLIENT_ORIGIN || 'https://orderfrontend.vercel.app/', 'vvivers.com', 'vvivers.com/', 'https://vvivers.com', 'https://vvivers.com/', 'https://vvivers.com', 'www.vvivers.com','admin.vvivers.com', 'orderfrontend.vercel.app/', process.env.ADMIN_ORIGIN || 'https://orderadminportal.vercel.app/', 'orderadminportal.vercel.app/', 'orderadminportal.vercel.app', 'https://orderadminportal.vercel.app', 'orderfrontend.vercel.app','https://orderfrontend.vercel.app']
app.use(cors({ origin: allowedOrigins }))
app.use(express.json())

function requireAdmin(request, response, next) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return response.status(401).json({ error: 'Admin login required' })
  try {
    const payload = jwt.verify(token, jwtSecret)
    if (payload.role !== 'admin') return response.status(403).json({ error: 'Admin access required' })
    request.admin = payload
    next()
  } catch {
    response.status(401).json({ error: 'Admin session expired. Please log in again.' })
  }
}

function secureCompare(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''))
  const expectedBuffer = Buffer.from(String(expected || ''))
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

function slugify(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}

app.get('/api/health', async (_request, response) => {
  try {
    await pool.query('SELECT 1')
    response.json({ ok: true, database: 'mysql' })
  } catch {
    response.status(503).json({ ok: false, error: 'Database unavailable' })
  }
})

app.get('/api/company', (_request, response) => {
  response.json({
    name: 'Vvivers India Pvt Ltd',
    address: 'C-6 Patparganj Industrial Area, Delhi-110092',
    phone: process.env.COMPANY_PHONE || '+91 98100 00000',
    email: process.env.COMPANY_EMAIL || 'vviversindia@gmail.com',
  })
})

app.get('/api/categories', async (_request, response, next) => {
  try {
    const [rows] = await pool.query(`SELECT categories.id, categories.name, COUNT(products.id) AS product_count
      FROM categories LEFT JOIN products ON products.category_id = categories.id
      GROUP BY categories.id, categories.name ORDER BY categories.name`)
    response.json(rows.map((category) => ({ ...category, product_count: Number(category.product_count) })))
  } catch (error) { next(error) }
})

app.post('/api/admin/login', (request, response) => {
  const { userId, password } = request.body
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-this-secret') {
    return response.status(503).json({ error: 'Admin credentials and a unique JWT_SECRET must be configured on the server' })
  }
  if (!secureCompare(userId, process.env.ADMIN_USER) || !secureCompare(password, process.env.ADMIN_PASSWORD)) {
    return response.status(401).json({ error: 'Invalid user ID or password' })
  }
  const token = jwt.sign({ role: 'admin', userId: process.env.ADMIN_USER }, jwtSecret, { expiresIn: '8h' })
  response.json({ token, userId: process.env.ADMIN_USER })
})

app.get('/api/admin/overview', requireAdmin, async (_request, response, next) => {
  try {
    const [[products]] = await pool.query('SELECT COUNT(*) AS total, SUM(is_featured = TRUE) AS featured FROM products')
    const [[categories]] = await pool.query('SELECT COUNT(*) AS total FROM categories')
    const [[quotes]] = await pool.query("SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending FROM quote_requests")
    const [[inquiries]] = await pool.query("SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending FROM contact_requests")
    response.json({ products, categories, quotes, inquiries })
  } catch (error) { next(error) }
})

app.get('/api/admin/quotes', requireAdmin, async (_request, response, next) => {
  try {
    const [rows] = await pool.query(`SELECT quote_requests.id, quote_requests.product_id, products.name AS product_name,
      quote_requests.name, quote_requests.email, quote_requests.notes, quote_requests.status, quote_requests.created_at
      FROM quote_requests JOIN products ON products.id = quote_requests.product_id
      ORDER BY quote_requests.created_at DESC`)
    response.json(rows)
  } catch (error) { next(error) }
})

app.get('/api/admin/inquiries', requireAdmin, async (_request, response, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, phone, message, status, created_at FROM contact_requests ORDER BY created_at DESC')
    response.json(rows)
  } catch (error) { next(error) }
})

app.patch('/api/admin/quotes/:id/status', requireAdmin, async (request, response, next) => {
  try {
    const { status } = request.body
    if (!['pending', 'fulfilled'].includes(status)) return response.status(400).json({ error: 'Status must be pending or fulfilled' })
    const [result] = await pool.execute('UPDATE quote_requests SET status = ? WHERE id = ?', [status, request.params.id])
    if (!result.affectedRows) return response.status(404).json({ error: 'Quotation not found' })
    response.json({ id: request.params.id, status })
  } catch (error) { next(error) }
})

app.patch('/api/admin/inquiries/:id/status', requireAdmin, async (request, response, next) => {
  try {
    const { status } = request.body
    if (!['pending', 'fulfilled'].includes(status)) return response.status(400).json({ error: 'Status must be pending or fulfilled' })
    const [result] = await pool.execute('UPDATE contact_requests SET status = ? WHERE id = ?', [status, request.params.id])
    if (!result.affectedRows) return response.status(404).json({ error: 'Inquiry not found' })
    response.json({ id: request.params.id, status })
  } catch (error) { next(error) }
})

app.post('/api/admin/categories', requireAdmin, async (request, response, next) => {
  try {
    const name = request.body.name?.trim()
    const id = slugify(name || '')
    if (!name || !id) return response.status(400).json({ error: 'A valid category name is required' })
    await pool.execute('INSERT INTO categories (id, name) VALUES (?, ?)', [id, name])
    response.status(201).json({ id, name, product_count: 0 })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'That category already exists' })
    next(error)
  }
})

app.delete('/api/admin/categories/:id', requireAdmin, async (request, response, next) => {
  try {
    const [result] = await pool.execute('DELETE FROM categories WHERE id = ?', [request.params.id])
    if (!result.affectedRows) return response.status(404).json({ error: 'Category not found' })
    response.json({ deleted: request.params.id })
  } catch (error) {
    if (error.code === 'ER_ROW_IS_REFERENCED_2') return response.status(409).json({ error: 'Remove or move this category’s products before deleting it' })
    next(error)
  }
})

app.post('/api/admin/products', requireAdmin, async (request, response, next) => {
  try {
    const { name, category_id: categoryId, size, price, image, description, accent = 'coral', tags = [], is_featured: isFeatured = false } = request.body
    if (!name?.trim() || !categoryId || !size?.trim() || !Number.isFinite(Number(price)) || Number(price) < 0 || !image?.trim() || !description?.trim()) {
      return response.status(400).json({ error: 'Name, category, size, valid price, image URL, and description are required' })
    }
    if (!Array.isArray(tags)) return response.status(400).json({ error: 'Tags must be a list' })
    const id = randomUUID()
    await pool.execute(`INSERT INTO products (id, name, category_id, size, price, accent, image, description, tags, is_featured, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [id, name.trim(), categoryId, size.trim(), Number(price), accent, image.trim(), description.trim(), JSON.stringify(tags), Boolean(isFeatured)])
    response.status(201).json({ id, name: name.trim() })
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') return response.status(400).json({ error: 'Select an existing category' })
    next(error)
  }
})

app.patch('/api/admin/products/:id/featured', requireAdmin, async (request, response, next) => {
  try {
    const isFeatured = Boolean(request.body.is_featured)
    const [result] = await pool.execute('UPDATE products SET is_featured = ? WHERE id = ?', [isFeatured, request.params.id])
    if (!result.affectedRows) return response.status(404).json({ error: 'Product not found' })
    response.json({ id: request.params.id, is_featured: isFeatured })
  } catch (error) { next(error) }
})

app.delete('/api/admin/products/:id', requireAdmin, async (request, response, next) => {
  try {
    const [result] = await pool.execute('DELETE FROM products WHERE id = ?', [request.params.id])
    if (!result.affectedRows) return response.status(404).json({ error: 'Product not found' })
    response.json({ deleted: request.params.id })
  } catch (error) {
    if (error.code === 'ER_ROW_IS_REFERENCED_2') return response.status(409).json({ error: 'This product has quotation history and cannot be deleted' })
    next(error)
  }
})

app.post('/api/contact', async (request, response, next) => {
  try {
    const { name, email, phone = '', message } = request.body
    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return response.status(400).json({ error: 'Name, email, and message are required' })
    }
    const [result] = await pool.execute(
      'INSERT INTO contact_requests (name, email, phone, message) VALUES (?, ?, ?, ?)',
      [name.trim(), email.trim().toLowerCase(), phone.trim(), message.trim()],
    )
    response.status(201).json({ id: result.insertId, message: 'Your message has been received' })
  } catch (error) { next(error) }
})

app.get('/api/products', async (request, response, next) => {
  try {
    const conditions = []
    const values = []
    if (request.query.category) {
      conditions.push('products.category_id = ?')
      values.push(request.query.category)
    }
    if (request.query.featured === 'true') conditions.push('products.is_featured = TRUE')

    const sortOptions = {
      category: 'categories.name, products.name',
      name: 'products.name',
      price_asc: 'products.price ASC, products.name',
      price_desc: 'products.price DESC, products.name',
      default: 'products.sort_order, products.name',
    }
    const orderBy = sortOptions[request.query.sort] || sortOptions.default
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [rows] = await pool.execute(`SELECT products.id, products.name, products.category_id,
      categories.name AS category, products.size, products.price, products.accent, products.image,
      products.description, products.tags, products.is_featured, products.sort_order
      FROM products JOIN categories ON categories.id = products.category_id ${where} ORDER BY ${orderBy}`, values)
    response.json(rows.map((product) => ({ ...product, price: Number(product.price), tags: typeof product.tags === 'string' ? JSON.parse(product.tags) : product.tags })))
  } catch (error) { next(error) }
})

app.get('/api/products/:id', async (request, response, next) => {
  try {
    const [rows] = await pool.execute(`SELECT products.id, products.name, products.category_id,
      categories.name AS category, products.size, products.price, products.accent, products.image,
      products.description, products.tags, products.is_featured, products.sort_order
      FROM products JOIN categories ON categories.id = products.category_id WHERE products.id = ?`, [request.params.id])
    if (!rows[0]) return response.status(404).json({ error: 'Product not found' })
    response.json({ ...rows[0], price: Number(rows[0].price), tags: typeof rows[0].tags === 'string' ? JSON.parse(rows[0].tags) : rows[0].tags })
  } catch (error) { next(error) }
})

app.post('/api/quotes', async (request, response, next) => {
  try {
    const { productId, name, email, notes = '' } = request.body
    if (!productId || !name?.trim() || !email?.trim()) return response.status(400).json({ error: 'Product, name, and email are required' })
    const [result] = await pool.execute('INSERT INTO quote_requests (product_id, name, email, notes) VALUES (?, ?, ?, ?)', [productId, name.trim(), email.trim(), notes.trim()])
    response.status(201).json({ id: result.insertId, message: 'Quote request received' })
  } catch (error) { next(error) }
})

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const { email, password } = request.body
    const [rows] = await pool.execute('SELECT id, email, password_hash FROM users WHERE email = ?', [email?.trim().toLowerCase()])
    if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return response.status(401).json({ error: 'Invalid email or password' })
    const token = jwt.sign({ userId: rows[0].id, email: rows[0].email }, jwtSecret, { expiresIn: '7d' })
    response.json({ token, user: { id: rows[0].id, email: rows[0].email } })
  } catch (error) { next(error) }
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ error: 'Internal server error' })
})

initializeDatabase().then(() => {
  if (!process.env.VERCEL) {
    app.listen(port, () => console.log(`Vvivers Express API listening on http://localhost:${port}`))
  } else {
    console.log('Vercel serverless runtime ready')
  }
}).catch((error) => {
  console.error('Unable to initialize MySQL database:', error.message)
  process.exit(1)
})

export default app
