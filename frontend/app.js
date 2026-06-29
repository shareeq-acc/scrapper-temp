let currentBatchId = null;
let pollInterval = null;

async function submitUrls() {
  const urlInput = document.getElementById('urlInput').value.trim();
  const fileInput = document.getElementById('fileInput').files[0];
  const submitBtn = document.getElementById('submitBtn');

  if (!urlInput && !fileInput) {
    alert('Please paste URLs or upload a file');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

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
      submitBtn.textContent = 'Start Scraping';
      return;
    }

    currentBatchId = data.batchId;

    document.getElementById('progressCard').style.display = 'block';
    document.getElementById('totalCount').textContent = data.total;
    submitBtn.textContent = 'Scraping...';

    // Start polling
    pollInterval = setInterval(pollStatus, 3000);
    pollStatus();

  } catch (err) {
    alert('Error: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Start Scraping';
  }
}

async function pollStatus() {
  if (!currentBatchId) return;

  try {
    const res = await fetch(`/api/jobs/${currentBatchId}`);
    const data = await res.json();

    // Update summary counts
    document.getElementById('completedCount').textContent = data.completed;
    document.getElementById('failedCount').textContent = data.failed;
    document.getElementById('pendingCount').textContent = data.pending;

    // Update progress bar
    const pct = Math.round((data.completed + data.failed) / data.total * 100);
    document.getElementById('progressBar').style.width = pct + '%';

    // Update jobs table
    const tbody = document.getElementById('jobsBody');
    tbody.innerHTML = '';

    for (const job of data.jobs) {
      const tr = document.createElement('tr');

      const meta = job.result?.metadata || {};
      const title = meta.branding?.pageTitle || meta.person?.name || '—';
      const links = meta.allLinks
        ? Object.values(meta.allLinks).flat().length
        : '—';
      const count =
        meta.sections?.portfolio?.length ?? meta.assets?.images?.length;
      const media = count != null ? count : '—';

      tr.innerHTML = `
        <td title="${job.url}">${job.url}</td>
        <td><span class="status ${job.status}">${job.status}</span></td>
        <td title="${title}">${title}</td>
        <td>${links}</td>
        <td>${media}</td>
      `;

      tbody.appendChild(tr);
    }

    // If all done — stop polling
    if (data.pending === 0) {
      clearInterval(pollInterval);
      pollInterval = null;

      document.getElementById('submitBtn').textContent = 'Done';
      document.getElementById('downloadBtn').style.display = 'block';
    }

  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

async function downloadZip() {
  if (!currentBatchId) return;
  window.location.href = `/api/jobs/${currentBatchId}/download`;
}