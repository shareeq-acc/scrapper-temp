const db = require('../db');
const { scrapeUrl } = require('../scraper');
const { uploadDirToS3 } = require('../s3');
const fs = require('fs');

const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 5;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 2;

async function fetchAndProcessJob() {
  // Concurrency-safe atomic transaction to grab the next job
  const queryText = `
    UPDATE jobs 
    SET status = 'active', started_at = NOW(), attempts = attempts + 1 
    WHERE id = (
      SELECT id FROM jobs 
      WHERE status IN ('pending', 'failed') AND attempts < $1 
      ORDER BY created_at ASC 
      LIMIT 1 
      FOR UPDATE SKIP LOCKED
    ) 
    RETURNING *
  `;
  
  const result = await db.query(queryText, [MAX_RETRIES]);
  
  if (result.rows.length === 0) {
    return false; // No jobs processed
  }

  const job = result.rows[0];
  console.log(`[Worker] Started processing Job ${job.id}: ${job.url}`);

  try {
    const scrapeResult = await scrapeUrl(job.url);
    
    if (scrapeResult && scrapeResult.metadata && scrapeResult.metadata.error) {
      throw new Error(scrapeResult.metadata.error);
    }

    // Upload files to S3
    if (scrapeResult && scrapeResult.outputDir) {
      console.log(`[Worker] Uploading output folder for Job ${job.id} to S3...`);
      await uploadDirToS3(scrapeResult.outputDir, job.batch_id, scrapeResult.folderName);
      
      // Clean up local files
      fs.rmSync(scrapeResult.outputDir, { recursive: true, force: true });
      console.log(`[Worker] Cleaned up local files for Job ${job.id}`);
    }

    // Update job status to completed and store metadata
    await db.query(
      `UPDATE jobs SET status = 'completed', metadata = $1, completed_at = NOW() WHERE id = $2`,
      [scrapeResult ? scrapeResult.metadata : {}, job.id]
    );
    console.log(`[Worker] Successfully completed Job ${job.id}: ${job.url}`);
    
  } catch (err) {
    console.error(`[Worker] Error processing Job ${job.id}:`, err.message);
    
    // Update job status to failed
    await db.query(
      `UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [err.message, job.id]
    );

    // Ensure cleanup of local directory on failure if created
    try {
      const { urlToFolderName } = require('../utils');
      const folderName = urlToFolderName(job.url);
      const RESULTS_DIR = process.env.RESULTS_DIR || './results';
      const path = require('path');
      const localDir = path.resolve(RESULTS_DIR, folderName);
      if (fs.existsSync(localDir)) {
        fs.rmSync(localDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.error(`[Worker] Failed cleaning up local dir on error:`, cleanupErr.message);
    }
  }

  return true; // Job was processed
}

async function workerLoop(workerId) {
  // console.log(`[Worker ${workerId}] Started loop.`);
  while (true) {
    try {
      const processed = await fetchAndProcessJob();
      if (!processed) {
        // Sleep for 2 seconds if no jobs
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (err) {
      console.error(`[Worker ${workerId}] Error in loop:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

let workersStarted = false;

function startWorkers() {
  if (workersStarted) return;
  workersStarted = true;
  console.log(`[Worker Manager] Starting ${CONCURRENCY} worker threads...`);
  for (let i = 1; i <= CONCURRENCY; i++) {
    workerLoop(i);
  }
}

module.exports = {
  startWorkers,
};
