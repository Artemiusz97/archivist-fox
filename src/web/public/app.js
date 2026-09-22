// Archivist Fox - Web UI Frontend Script
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const tabs = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const downloadForm = document.getElementById('downloadForm');
  const urlInput = document.getElementById('urlInput');
  const pasteBtn = document.getElementById('pasteBtn');
  const submitBtn = document.getElementById('submitBtn');
  const audioOnlyToggle = document.getElementById('audioOnlyToggle');
  const forceToggle = document.getElementById('forceToggle');
  const archiveToggle = document.getElementById('archiveToggle');
  const tasksList = document.getElementById('tasksList');
  const emptyTasks = document.getElementById('emptyTasks');
  const clearCompletedBtn = document.getElementById('clearCompletedBtn');
  const versionBadge = document.getElementById('versionBadge');

  // Library Elements
  const libraryList = document.getElementById('libraryList');
  const librarySearchInput = document.getElementById('librarySearchInput');
  const librarySearchBtn = document.getElementById('librarySearchBtn');
  const refreshLibraryBtn = document.getElementById('refreshLibraryBtn');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');
  const pageInfo = document.getElementById('pageInfo');

  // Modal Elements
  const previewModal = document.getElementById('previewModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const closeModalBtn = document.getElementById('closeModalBtn');

  // State
  let activeTasks = new Map(); // taskId -> DOM element
  let libraryPage = 0;
  const libraryPageSize = 24;

  // ─── Tabs ──────────────────────────────────────────────────────────────────
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tabPanes.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.dataset.tab;
      document.getElementById(targetId)?.classList.add('active');

      if (targetId === 'libraryTab') {
        loadLibrary();
      }
    });
  });

  // ─── Clipboard Paste ───────────────────────────────────────────────────────
  pasteBtn?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.startsWith('http')) {
        urlInput.value = text.trim();
        urlInput.focus();
      }
    } catch {
      urlInput.focus();
    }
  });

  // ─── Status & Version ──────────────────────────────────────────────────────
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        if (data.version && versionBadge) {
          versionBadge.textContent = `v${data.version}`;
        }
      }
    } catch {}
  }
  fetchStatus();

  // ─── Download Task Management ──────────────────────────────────────────────
  downloadForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    submitBtn.disabled = true;
    submitBtn.querySelector('.btn-text').textContent = 'Starting...';
    submitBtn.querySelector('.btn-spinner').classList.remove('hidden');

    try {
      const payload = {
        url,
        audioOnly: audioOnlyToggle.checked,
        force: forceToggle.checked,
        saveToArchive: archiveToggle.checked,
      };

      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to submit download');
      }

      // Clear input and create task card
      urlInput.value = '';
      createTaskCard(data.taskId, url);
      listenToTaskProgress(data.taskId);
    } catch (err) {
      alert(`Error starting download: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.querySelector('.btn-text').textContent = 'Download';
      submitBtn.querySelector('.btn-spinner').classList.add('hidden');
    }
  });

  function createTaskCard(taskId, url) {
    if (emptyTasks) emptyTasks.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'task-item';
    card.id = `task-${taskId}`;
    card.innerHTML = `
      <div class="task-header">
        <span class="task-url">${escapeHtml(url)}</span>
        <span class="badge badge-queued">Queued</span>
      </div>
      <div class="task-message">Initializing download task...</div>
      <div class="task-results hidden"></div>
    `;

    tasksList.prepend(card);
    activeTasks.set(taskId, card);
  }

  function listenToTaskProgress(taskId) {
    const eventSource = new EventSource(`/api/progress/${taskId}`);

    eventSource.onmessage = (event) => {
      try {
        const task = JSON.parse(event.data);
        updateTaskCard(taskId, task);

        if (task.stage === 'completed' || task.stage === 'error') {
          eventSource.close();
        }
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };
  }

  const openArchiveFolderBtn = document.getElementById('openArchiveFolderBtn');
  const openLibraryFolderBtn = document.getElementById('openLibraryFolderBtn');

  window.openFolder = async (targetPath) => {
    try {
      const res = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath || '' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to open directory');
      }
    } catch (err) {
      alert('Could not open folder in File Explorer: ' + err.message);
    }
  };

  openArchiveFolderBtn?.addEventListener('click', () => window.openFolder());
  openLibraryFolderBtn?.addEventListener('click', () => window.openFolder());

  function updateTaskCard(taskId, task) {
    const card = activeTasks.get(taskId);
    if (!card) return;

    const badge = card.querySelector('.badge');
    const msg = card.querySelector('.task-message');
    const resultsContainer = card.querySelector('.task-results');

    // Update Badge
    badge.className = `badge badge-${task.stage || 'queued'}`;
    badge.textContent = task.stage || 'queued';

    // Update Message
    msg.textContent = task.message || '';

    // Handle Results
    if (task.stage === 'completed') {
      const files = task.result?.files || task.files || task.data?.files || [];
      resultsContainer.classList.remove('hidden');

      if (files.length > 0) {
        resultsContainer.innerHTML = files
          .map((f) => {
            const icon = f.isVideo ? '🎬' : f.isAudio ? '🎵' : '🖼️';
            const sizeStr = f.size ? formatBytes(f.size) : '';
            const downloadUrl = `/api/file?file=${encodeURIComponent(f.path || f.filename)}&download=1`;
            const previewUrl = `/api/file?file=${encodeURIComponent(f.path || f.filename)}`;
            const mediaType = f.isVideo ? 'video' : f.isAudio ? 'audio' : 'image';
            const safePath = (f.path || f.filename || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            return `
              <div class="result-item">
                <div class="result-info">
                  <span class="result-icon">${icon}</span>
                  <div class="result-meta">
                    <span class="result-title" title="${escapeHtml(f.title || f.filename)}">${escapeHtml(f.title || f.filename)}</span>
                    <span class="result-size">${sizeStr}</span>
                  </div>
                </div>
                <div class="result-actions">
                  <button class="btn btn-sm btn-primary" onclick="previewMedia('${previewUrl}', '${escapeHtml(f.title || f.filename)}', '${mediaType}')" title="Quickly view or play this media file">
                    ▶ View File
                  </button>
                  <button class="btn btn-sm btn-secondary" onclick="openFolder('${safePath}')" title="Open directory in Windows File Explorer">
                    📂 Go to Directory
                  </button>
                </div>
              </div>
            `;
          })
          .join('');
      } else {
        // Fallback if file list was not explicitly populated
        resultsContainer.innerHTML = `
          <div class="result-item">
            <div class="result-info">
              <span class="result-icon">📁</span>
              <div class="result-meta">
                <span class="result-title">Download complete</span>
                <span class="result-size">File saved to your PC archive</span>
              </div>
            </div>
            <div class="result-actions">
              <button class="btn btn-sm btn-secondary" onclick="openFolder()" title="Open download directory in Windows File Explorer">
                📂 Go to Directory
              </button>
            </div>
          </div>
        `;
      }
    } else if (task.stage === 'error') {
      msg.textContent = `❌ ${task.error || task.message || 'Download failed'}`;
    }
  }

  clearCompletedBtn?.addEventListener('click', () => {
    activeTasks.forEach((card, id) => {
      const badge = card.querySelector('.badge');
      if (badge && (badge.classList.contains('badge-completed') || badge.classList.contains('badge-error'))) {
        card.remove();
        activeTasks.delete(id);
      }
    });

    if (activeTasks.size === 0 && emptyTasks) {
      emptyTasks.style.display = 'block';
    }
  });

  function getMediaType(fileName, duration = 0) {
    if (!fileName) return duration > 1.5 ? 'video' : 'image';
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff'];
    const videoExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.flv'];
    const audioExts = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.opus', '.aac', '.alac'];

    if (imageExts.includes(ext)) return 'image';
    if (videoExts.includes(ext)) return 'video';
    if (audioExts.includes(ext)) return 'audio';
    if (duration > 1.5) return 'video';
    return 'image';
  }

  // ─── Archive Library ───────────────────────────────────────────────────────
  async function loadLibrary() {
    if (!libraryList) return;

    libraryList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⏳</span>
        <p>Loading library items...</p>
      </div>
    `;

    const searchQuery = librarySearchInput?.value.trim() || '';
    const offset = libraryPage * libraryPageSize;
    let url = `/api/history?limit=${libraryPageSize}&offset=${offset}`;
    if (searchQuery) {
      url += `&q=${encodeURIComponent(searchQuery)}`;
    }

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to load library');
      }

      const records = data.records || [];
      if (records.length === 0) {
        libraryList.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">📭</span>
            <p>No archived media found.</p>
          </div>
        `;
        nextPageBtn.disabled = true;
        return;
      }

      pageInfo.textContent = `Page ${libraryPage + 1}`;
      prevPageBtn.disabled = libraryPage === 0;
      nextPageBtn.disabled = records.length < libraryPageSize;

      libraryList.innerHTML = records
        .map((r) => {
          const mediaType = getMediaType(r.file_name, r.duration);
          const isVideo = mediaType === 'video';
          const isAudio = mediaType === 'audio';
          const icon = isVideo ? '🎬' : isAudio ? '🎵' : '🖼️';
          const title = r.title || r.file_name || 'Archived Media';
          const dateStr = r.archived_at ? new Date(r.archived_at).toLocaleDateString() : '';
          const previewUrl = `/api/file?file=${encodeURIComponent(r.file_name)}`;
          const downloadUrl = `/api/file?file=${encodeURIComponent(r.file_name)}&download=1`;

          const safePath = (r.file_name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

          return `
            <div class="library-item">
              <div class="library-item-header">
                <span class="result-icon">${icon}</span>
                <div>
                  <h4 class="library-item-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h4>
                  <div class="library-item-meta">
                    <span>${dateStr ? `📅 ${dateStr}` : ''}</span>
                    <span>👤 ${escapeHtml(r.posted_by || 'Unknown')}</span>
                  </div>
                </div>
              </div>
              <div class="library-item-actions">
                <button class="btn btn-sm btn-primary" onclick="previewMedia('${previewUrl}', '${escapeHtml(title)}', '${mediaType}')" title="Quickly view or play media">
                  ▶ View
                </button>
                <button class="btn btn-sm btn-secondary" onclick="openFolder('${safePath}')" title="Open directory in Windows File Explorer">
                  📂 Folder
                </button>
              </div>
            </div>
          `;
        })
        .join('');
    } catch (err) {
      libraryList.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">⚠️</span>
          <p>Failed to load library: ${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }

  librarySearchBtn?.addEventListener('click', () => {
    libraryPage = 0;
    loadLibrary();
  });

  librarySearchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      libraryPage = 0;
      loadLibrary();
    }
  });

  refreshLibraryBtn?.addEventListener('click', () => {
    loadLibrary();
  });

  prevPageBtn?.addEventListener('click', () => {
    if (libraryPage > 0) {
      libraryPage--;
      loadLibrary();
    }
  });

  nextPageBtn?.addEventListener('click', () => {
    libraryPage++;
    loadLibrary();
  });

  // ─── Modal Preview ─────────────────────────────────────────────────────────
  window.previewMedia = (url, title, type) => {
    if (!previewModal) return;

    modalTitle.textContent = title || 'Media Preview';
    modalBody.innerHTML = '';

    const directDownloadBtn = `<div style="margin-top: 12px;"><a href="${url}&download=1" class="btn btn-sm btn-primary" download>⬇ Save to Device</a></div>`;

    if (type === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      video.style.maxWidth = '100%';
      video.style.maxHeight = '70vh';
      video.onerror = () => {
        modalBody.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">⚠️</span>
            <p>Could not stream video in browser.</p>
            ${directDownloadBtn}
          </div>
        `;
      };
      modalBody.appendChild(video);
    } else if (type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      audio.autoplay = true;
      audio.onerror = () => {
        modalBody.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">⚠️</span>
            <p>Could not stream audio in browser.</p>
            ${directDownloadBtn}
          </div>
        `;
      };
      modalBody.appendChild(audio);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.alt = title || 'Image preview';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '70vh';
      img.onerror = () => {
        modalBody.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">⚠️</span>
            <p>Could not load image preview.</p>
            ${directDownloadBtn}
          </div>
        `;
      };
      modalBody.appendChild(img);
    }

    previewModal.classList.remove('hidden');
  };

  function closeModal() {
    if (!previewModal) return;
    previewModal.classList.add('hidden');
    modalBody.innerHTML = ''; // Stop video/audio
  }

  closeModalBtn?.addEventListener('click', closeModal);
  previewModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeModal);

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
});
