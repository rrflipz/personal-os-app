// db.js
//
// Real database, backed by Postgres (Render Postgres or any other Postgres
// host). Replaces the old single-JSON-file version -- same function names
// and shapes as before (findUserByEmail, findUserById, createUser,
// updateUser), so server.js barely has to change.
//
// Everything here is async now (Postgres calls are never instant), so every
// call site in server.js needs `await` in front of it. See server.js for
// the updated call sites.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL in your .env file (or Render environment variables).');
  process.exit(1);
}

// Render's internal Postgres connection doesn't need SSL; most external
// Postgres hosts (and Render's *external* connection string) do. This
// covers both without you having to think about it.
const needsSSL = /render\.com|sslmode=require/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_pro BOOLEAN NOT NULL DEFAULT false,
      free_messages_used INTEGER NOT NULL DEFAULT 0,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      reset_token_hash TEXT,
      reset_token_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // These two are added separately (rather than only in the CREATE TABLE
  // above) so they also get added to a users table that already existed
  // before password reset was built -- CREATE TABLE IF NOT EXISTS does
  // nothing to a table that's already there.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;`);
}

// Run once at startup. If this fails (bad connection string, DB not
// reachable), we want the app to fail loudly instead of silently limping
// along with no database.
const schemaReady = ensureSchema().catch((err) => {
  console.error('Failed to set up the database schema:', err.message);
  process.exit(1);
});

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    isPro: row.is_pro,
    freeMessagesUsed: row.free_messages_used,
    profile: row.profile,
    conversation: row.conversation,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    resetTokenHash: row.reset_token_hash,
    resetTokenExpires: row.reset_token_expires,
    createdAt: row.created_at,
  };
}

async function findUserByEmail(email) {
  await schemaReady;
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rowToUser(rows[0]);
}

async function findUserById(id) {
  await schemaReady;
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rowToUser(rows[0]);
}

async function findUserByStripeSubscriptionId(subscriptionId) {
  await schemaReady;
  const { rows } = await pool.query('SELECT * FROM users WHERE stripe_subscription_id = $1', [subscriptionId]);
  return rowToUser(rows[0]);
}

async function findUserByResetTokenHash(hash) {
  await schemaReady;
  const { rows } = await pool.query('SELECT * FROM users WHERE reset_token_hash = $1', [hash]);
  return rowToUser(rows[0]);
}

async function createUser(user) {
  await schemaReady;
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash, is_pro, free_messages_used, profile, conversation, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      user.id,
      user.email,
      user.passwordHash,
      user.isPro,
      user.freeMessagesUsed,
      JSON.stringify(user.profile || {}),
      JSON.stringify(user.conversation || []),
      user.createdAt,
    ]
  );
  return rowToUser(rows[0]);
}

async function updateUser(id, updates) {
  await schemaReady;
  const current = await findUserById(id);
  if (!current) return null;
  const merged = { ...current, ...updates };
  const { rows } = await pool.query(
    `UPDATE users SET
       email = $2,
       password_hash = $3,
       is_pro = $4,
       free_messages_used = $5,
       profile = $6,
       conversation = $7,
       stripe_customer_id = $8,
       stripe_subscription_id = $9,
       reset_token_hash = $10,
       reset_token_expires = $11
     WHERE id = $1
     RETURNING *`,
    [
      id,
      merged.email,
      merged.passwordHash,
      merged.isPro,
      merged.freeMessagesUsed,
      JSON.stringify(merged.profile || {}),
      JSON.stringify(merged.conversation || []),
      merged.stripeCustomerId || null,
      merged.stripeSubscriptionId || null,
      merged.resetTokenHash || null,
      merged.resetTokenExpires || null,
    ]
  );
  return rowToUser(rows[0]);
}

module.exports = {
  findUserByEmail,
  findUserById,
  findUserByStripeSubscriptionId,
  findUserByResetTokenHash,
  createUser,
  updateUser,
};
