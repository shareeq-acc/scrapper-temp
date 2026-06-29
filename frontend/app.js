let currentBatchId = null;
let pollInterval = null;

// History State
let historyPage = 1;
const historyLimit = 10;
let historyTotal = 0;

// Modal State
let activeModalBatchId = null;

// Add event listener to file input to display uploaded filename
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const fileCustom = document.querySelector('.file-custom');
  if (fileInput && fileCustom) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        fileCustom.textContent = fileInput.files[0].name;
      } else {
        fileCustom.textContent = 'Choose text file...';
      }
    });
  }
});

/* --- TAB NAVIGATION --- */
function switchTab(tab) {
  const scraperBtn = document.getElementById('tab-scraper');
  const historyBtn = document.getElementById('tab-history');
  const scraperSec = document.getElementById('scraper-section');
  const historySec = document.getElementById('history-section');

  if (tab === 'scraper') {
    scraperBtn.classList.add('active');
    historyBtn.classList.remove('active');
    scraperSec.style.display = 'block';
    historySec.style.display = 'none';
  } else {
    scraperBtn.classList.remove('active');
    historyBtn.classList.add('active');
    scraperSec.style.display = 'none';
    historySec.style.display = 'block';
    loadHistory(1);
  }
}

/* --- SUBMIT & RUN SCRAPE --- */
async function submitUrls() {
  const urlInput = document.getElementById('urlInput').value.trim();
  const fileInput = document.getElementById('fileInput').files[0];
  const submitBtn = document.getElementById('submitBtn');

  if (!urlInput && !fileInput) {
    alert('Please paste URLs or upload a .txt file.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span>Submitting batch...</span>';

  try {
    const formData = new FormData();
    if (fileInput) {
      formData.append('file', fileInput);
    } else {
      formData.append('urls', urlInput);
    }

    const res = await fetch('/api/jobs', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      alert('Error: ' + data.error);
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Start Scraping</span>';
      return;
    }

    currentBatchId = data.batchId;

    document.getElementById('progressCard').style.display = 'block';
    document.getElementById('totalCount').textContent = data.total;
    submitBtn.innerHTML = '<span>Scraping in progress...</span>';

    // Start polling the server
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollStatus, 3000);
    pollStatus();

  } catch (err) {
    alert('Submission failed: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Start Scraping</span>';
  }
}

/* --- POLL SCRAPE PROGRESS --- */
async function pollStatus() {
  if (!currentBatchId) return;

  try {
    const res = await fetch(`/api/jobs/${currentBatchId}`);
    const data = await res.json();

    // Update status pills
    document.getElementById('completedCount').textContent = data.completed;
    document.getElementById('failedCount').textContent = data.failed;
    document.getElementById('pendingCount').textContent = data.pending;

    // Update percentage progress bar
    const total = data.total || 1;
    const completedOrFailed = data.completed + data.failed;
    const pct = Math.min(100, Math.round((completedOrFailed / total) * 100));
    document.getElementById('progressBar').style.width = pct + '%';

    // Build progress detail list
    const tbody = document.getElementById('jobsBody');
    tbody.innerHTML = '';

    for (const job of data.jobs) {
      const tr = document.createElement('tr');

      const meta = job.result?.metadata || {};
      const title = meta.branding?.pageTitle || meta.person?.name || '—';
      const links = meta.allLinks
        ? Object.values(meta.allLinks).flat().length
        : '—';
      
      let mediaCount = '—';
      if (meta.sections?.portfolio) {
        mediaCount = meta.sections.portfolio.length;
      } else if (meta.assets?.images) {
        mediaCount = meta.assets.images.length;
      }

      tr.innerHTML = `
        <td title="${job.url}">${job.url}</td>
        <td><span class="status ${job.status}">${job.status}</span></td>
        <td title="${title}">${title}</td>
        <td>${links}</td>
        <td>${mediaCount}</td>
      `;
      tbody.appendChild(tr);
    }

    // Stop polling if complete
    if (data.pending === 0) {
      clearInterval(pollInterval);
      pollInterval = null;

      const submitBtn = document.getElementById('submitBtn');
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Start Scraping</span>';

      document.getElementById('downloadBtn').style.display = 'inline-flex';
    }

  } catch (err) {
    console.error('Error polling status:', err.message);
  }
}

/* --- GET RUN BATCH HISTORY --- */
async function loadHistory(page) {
  historyPage = page;
  try {
    const res = await fetch(`/api/jobs/history?page=${page}&limit=${historyLimit}`);
    const data = await res.json();

    historyTotal = data.total;
    const batches = data.batches;

    const tbody = document.getElementById('historyBody');
    tbody.innerHTML = '';

    if (batches.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No historical scrape runs found.</td></tr>`;
      updatePaginationControls();
      return;
    }

    for (const batch of batches) {
      const date = new Date(batch.created_at).toLocaleString();
      const tr = document.createElement('tr');

      // Create details link and zip downloads
      tr.innerHTML = `
        <td><code>${batch.id}</code></td>
        <td>${date}</td>
        <td>${batch.total_urls}</td>
        <td><span class="status completed">${batch.completed}</span></td>
        <td><span class="status failed">${batch.failed}</span></td>
        <td><span class="status pending">${batch.pending}</span></td>
        <td>
          <button class="action-btn" onclick="viewBatchDetails('${batch.id}')">View Details</button>
          <button class="action-btn" onclick="downloadZip('${batch.id}')">Download ZIP</button>
          <button class="action-btn delete-btn" onclick="deleteBatch('${batch.id}')">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    updatePaginationControls();

  } catch (err) {
    console.error('Error loading history:', err.message);
    document.getElementById('historyBody').innerHTML = `
      <tr><td colspan="7" class="text-center text-danger">Failed to load run history: ${err.message}</td></tr>
    `;
  }
}

/* --- PAGINATION LOGIC --- */
function updatePaginationControls() {
  const totalPages = Math.max(1, Math.ceil(historyTotal / historyLimit));
  
  document.getElementById('currentPage').textContent = historyPage;
  document.getElementById('totalPages').textContent = totalPages;

  document.getElementById('prevBtn').disabled = (historyPage <= 1);
  document.getElementById('nextBtn').disabled = (historyPage >= totalPages);
}

function changePage(direction) {
  const targetPage = historyPage + direction;
  const totalPages = Math.max(1, Math.ceil(historyTotal / historyLimit));
  if (targetPage >= 1 && targetPage <= totalPages) {
    loadHistory(targetPage);
  }
}

/* --- BATCH DETAILS MODAL --- */
async function viewBatchDetails(batchId) {
  activeModalBatchId = batchId;
  document.getElementById('modalBatchId').textContent = batchId;
  document.getElementById('detailsModal').style.display = 'flex';
  
  const tbody = document.getElementById('modalJobsBody');
  tbody.innerHTML = `<tr><td colspan="5" class="text-center">Loading details...</td></tr>`;

  try {
    const res = await fetch(`/api/jobs/${batchId}`);
    const data = await res.json();

    document.getElementById('modalTotalCount').textContent = data.total;
    document.getElementById('modalCompletedCount').textContent = data.completed;
    document.getElementById('modalFailedCount').textContent = data.failed;
    document.getElementById('modalPendingCount').textContent = data.pending;

    tbody.innerHTML = '';
    for (const job of data.jobs) {
      const tr = document.createElement('tr');

      const meta = job.result?.metadata || {};
      const title = meta.branding?.pageTitle || meta.person?.name || '—';
      const links = meta.allLinks
        ? Object.values(meta.allLinks).flat().length
        : '—';
      
      let mediaCount = '—';
      if (meta.sections?.portfolio) {
        mediaCount = meta.sections.portfolio.length;
      } else if (meta.assets?.images) {
        mediaCount = meta.assets.images.length;
      }

      tr.innerHTML = `
        <td title="${job.url}">${job.url}</td>
        <td><span class="status ${job.status}">${job.status}</span></td>
        <td title="${title}">${title}</td>
        <td>${links}</td>
        <td>${mediaCount}</td>
      `;
      tbody.appendChild(tr);
    }

  } catch (err) {
    console.error('Error fetching batch details:', err.message);
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Failed to load details: ${err.message}</td></tr>`;
  }
}

function closeModal() {
  document.getElementById('detailsModal').style.display = 'none';
  activeModalBatchId = null;
}

/* --- DOWNLOAD & DELETE --- */
function downloadZip(batchId) {
  const id = batchId || currentBatchId;
  if (!id) return;
  window.location.href = `/api/jobs/${id}/download`;
}

function downloadModalZip() {
  if (activeModalBatchId) {
    downloadZip(activeModalBatchId);
  }
}

async function deleteBatch(batchId) {
  if (!confirm(`Are you sure you want to delete Batch ${batchId}?`)) return;

  try {
    const res = await fetch(`/api/jobs/${batchId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      loadHistory(historyPage);
    } else {
      alert('Delete failed: ' + data.error);
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}