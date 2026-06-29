const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

function createZip(batchId, jobs, resultsDir) {
  return new Promise((resolve, reject) => {
    const zipPath = path.resolve(resultsDir, `${batchId}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = new archiver.ZipArchive({ zlib: { level: 6 } });

    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);

    for (const job of jobs) {
      if (job.status !== 'completed') continue;
      if (!job.result || !job.result.folderName) continue;

      const jobDir = path.resolve(resultsDir, job.result.folderName);
      if (fs.existsSync(jobDir)) {
        archive.directory(jobDir, job.result.folderName);
      }
    }

    archive.finalize();
  });
}

module.exports = { createZip };