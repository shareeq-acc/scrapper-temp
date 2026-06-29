require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { startWorkers } = require('./queue');
const jobsRouter = require('./routes/jobs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// API routes
app.use('/api/jobs', jobsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

async function startServer() {
  // Retry connection to Database (helpful in Docker Compose environments)
  let retries = 10;
  while (retries > 0) {
    try {
      await db.initDb();
      break;
    } catch (err) {
      console.error(`Database connection failed. Retries remaining: ${retries - 1}. Error:`, err.message);
      retries -= 1;
      // Wait 3 seconds before next retry
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  if (retries === 0) {
    console.error('CRITICAL: Database connection failed after multiple attempts. Exiting.');
    process.exit(1);
  }

  // Start the background Postgres-backed scraper workers
  startWorkers();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();