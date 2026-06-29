const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const bucketName = process.env.AWS_S3_BUCKET;

// AWS SDK Client configuration
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'mock',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'mock',
  },
});

/**
 * Uploads a local directory and all its files recursively to S3
 * @param {string} localDir Local path to the directory
 * @param {string} batchId The ID of the current batch
 * @param {string} folderName The subfolder inside the batch (domain name)
 */
async function uploadDirToS3(localDir, batchId, folderName) {
  if (!bucketName) {
    console.warn('WARNING: AWS_S3_BUCKET is not set. Skipping S3 upload.');
    return;
  }

  const files = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  walk(localDir);

  for (const filePath of files) {
    const relativePath = path.relative(localDir, filePath).replace(/\\/g, '/');
    const s3Key = `scrapes/${batchId}/${folderName}/${relativePath}`;
    
    let contentType = 'application/octet-stream';
    if (filePath.endsWith('.html')) contentType = 'text/html';
    else if (filePath.endsWith('.json')) contentType = 'application/json';
    else if (filePath.endsWith('.png')) contentType = 'image/png';
    else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (filePath.endsWith('.gif')) contentType = 'image/gif';
    else if (filePath.endsWith('.css')) contentType = 'text/css';
    else if (filePath.endsWith('.js')) contentType = 'application/javascript';
    else if (filePath.endsWith('.mp4')) contentType = 'video/mp4';
    else if (filePath.endsWith('.webm')) contentType = 'video/webm';

    const fileStream = fs.createReadStream(filePath);

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: fileStream,
          ContentType: contentType,
        })
      );
      console.log(`Uploaded to S3: ${s3Key}`);
    } catch (err) {
      console.error(`Failed to upload ${relativePath} to S3:`, err.message);
      throw err;
    }
  }
}

module.exports = {
  s3,
  uploadDirToS3,
};
