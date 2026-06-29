const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer();
const scraperQueue = require('../queue');
const { parseUrls, generateBatchId } = require('../utils');
const { createZip } = require('../zipper');
const path = require('path');
const fs = require('fs');

const RESULTS_DIR = process.env.RESULTS_DIR || './results';

// Store batch info in memory (fine for now, can move to Redis later)
const batches = {};

// POST /api/jobs — submit URLs
router.post('/', upload.single('file'), async (req, res) => {
  try {
    let rawUrls = '';

    if (req.file) {
      rawUrls = req.file.buffer.toString('utf8');
    } else if (req.body.urls) {
      rawUrls = req.body.urls;
    } else {
      return res.status(400).json({ error: 'No URLs provided' });
    }

    const urls = parseUrls(rawUrls);

    if (urls.length === 0) {
      return res.status(400).json({ error: 'No valid URLs found' });
    }

    const batchId = generateBatchId();
    batches[batchId] = { batchId, total: urls.length, jobs: [] };

    for (const url of urls) {
      const job = await scraperQueue.add({ url, batchId });
      batches[batchId].jobs.push({
        jobId: job.id,
        url,
        status: 'pending',
      });
    }

    res.json({
      batchId,
      total: urls.length,
      message: `${urls.length} URLs queued`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:batchId — get status of all jobs in batch
router.get('/:batchId', async (req, res) => {
  const { batchId } = req.params;
  const batch = batches[batchId];

  if (!batch) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  // Update each job status from Bull
  for (const jobInfo of batch.jobs) {
    const job = await scraperQueue.getJob(jobInfo.jobId);
    if (!job) continue;

    const state = await job.getState();
    jobInfo.status = state;

    if (state === 'completed') {
      jobInfo.result = job.returnvalue;
    }
    if (state === 'failed') {
      jobInfo.error = job.failedReason;
    }
  }

  const completed = batch.jobs.filter(j => j.status === 'completed').length;
  const failed = batch.jobs.filter(j => j.status === 'failed').length;
  const pending = batch.jobs.filter(j =>
    ['waiting', 'active', 'delayed', 'pending'].includes(j.status)
  ).length;

  res.json({
    batchId,
    total: batch.total,
    completed,
    failed,
    pending,
    jobs: batch.jobs,
  });
});

// GET /api/jobs/:batchId/download — download ZIP of results
router.get('/:batchId/download', async (req, res) => {
  const { batchId } = req.params;
  const batch = batches[batchId];

  if (!batch) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  try {
    const zipPath = await createZip(batchId, batch.jobs, RESULTS_DIR);
    res.download(zipPath, `results_${batchId}.zip`, () => {
      fs.unlinkSync(zipPath);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/jobs/:batchId — clean up results
router.delete('/:batchId', (req, res) => {
  const { batchId } = req.params;
  delete batches[batchId];
  res.json({ message: 'Batch deleted' });
});

// Register the Bull worker processor
scraperQueue.process(
  parseInt(process.env.CONCURRENCY) || 5,
  async (job) => {
    const { scrapeUrl } = require('../scraper');
    const { url } = job.data;
    console.log(`Scraping: ${url}`);
    const result = await scrapeUrl(url);
    return result;
  }
);

module.exports = router;