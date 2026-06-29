const path = require('path');
const fs = require('fs');

// Clean a URL into a safe folder name
function urlToFolderName(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/[^a-z0-9]/gi, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase()
      .slice(0, 100);
  } catch {
    return 'unknown_' + Date.now();
  }
}

// Ensure a directory exists
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Clean and validate URLs from a raw string
function parseUrls(raw) {
  return raw
    .split(/[\n,]+/)
    .map(u => u.trim())
    .filter(u => {
      try {
        const url = new URL(u);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    });
}

// Generate a simple batch ID
function generateBatchId() {
  return 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

module.exports = { urlToFolderName, ensureDir, parseUrls, generateBatchId };