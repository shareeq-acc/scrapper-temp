const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/scraper';

const pool = new Pool({
  connectionString,
});

async function initDb() {
  const client = await pool.connect();
  try {
    console.log('Initializing database tables...');
    // Create batches table
    await client.query(`
      CREATE TABLE IF NOT EXISTS batches (
        id VARCHAR(50) PRIMARY KEY,
        total_urls INT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create jobs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        batch_id VARCHAR(50) REFERENCES batches(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        attempts INT DEFAULT 0,
        error_message TEXT,
        metadata JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE
      );
    `);
    console.log('Database tables verified/created successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  initDb,
};
