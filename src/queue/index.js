const Bull = require('bull');

const scraperQueue = new Bull('scraper', {
  redis: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  defaultJobOptions: {
    attempts: parseInt(process.env.MAX_RETRIES) || 2,
    backoff: {
      type: 'exponential',
      delay: 3000,
    },
    removeOnComplete: false,
    removeOnFail: false,
  },
});

scraperQueue.on('error', (err) => {
  console.error('Queue error:', err.message);
});

module.exports = scraperQueue;