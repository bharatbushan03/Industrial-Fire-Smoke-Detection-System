/**
 * Industrial Fire & Smoke Detection AI — Frontend Logic
 * Talks to Azure Functions at /api/*
 */

'use strict';

// ── API base (same origin for Azure Functions) ─────────────────────────────
const API = '/api';

// ── State ──────────────────────────────────────────────────────────────────
let currentMode   = 'image';
let videoFrames   = [];      // [{frame, thumbnail, fire_conf, smoke_conf, risk, ...}]
let currentFrame  = 0;
let statsInterval = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const systemStatus    = $('systemStatus');
const gpuBadge        = $('gpuBadge');
const alertBanner     = $('alertBanner');
const clock           = $('clock');

const imagePanel      = $('imagePanel');
const videoPanel      = $('videoPanel');
const imageDropzone   = $('imageDropzone');
const videoDropzone   = $('videoDropzone');
const imageInput      = $('imageInput');
const videoInput      = $('videoInput');
const imageDropLabel  = $('imageDropLabel');
const videoDropLabel  = $('videoDropLabel');
const analyseImageBtn = $('analyseImageBtn');
const analyseVideoBtn = $('analyseVideoBtn');
const imageProgress   = $('imageProgress');
const imageProgressBar= $('imageProgressBar');
const videoProgress   = $('videoProgress');
const videoProgressBar= $('videoProgressBar');
const maxFrames       = $('maxFrames');

const viewer          = $('viewer');
const viewerPlaceholder = $('viewerPlaceholder');
const resultImage     = $('resultImage');
const scrubber        = $('scrubber');
const frameSlider     = $('frameSlider');
const scrubberPrev    = $('scrubberPrev');
const scrubberNext    = $('scrubberNext');
const scrubberLabel   = $('scrubberLabel');

const riskCard        = $('riskCard');
const riskRing        = $('riskRing');
const riskLabel       = $('riskLabel');
const fireBar         = $('fireBar');
const smokeBar        = $('smokeBar');
const fireConf        = $('fireConf');
const smokeConf       = $('smokeConf');
const fireZones       = $('fireZones');
const smokeZones      = $('smokeZones');
const sceneObjs       = $('sceneObjs');
const frameIdx        = $('frameIdx');
const alertLog        = $('alertLog');
const clearLogBtn     = $('clearLogBtn');

// Toast container
const toastContainer  = document.createElement('div');
toastContainer.className = 'toast-container';
document.body.appendChild(toastContainer);

// ── Clock ──────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ── Health poll ────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const res  = await fetch(`${API}/health`);
    const data = await res.json();
    if (data.status === 'ready') {
      systemStatus.className   = 'badge badge--ready';
      systemStatus.textContent = '● System Ready';
      const mode = data.fp16 ? 'GPU FP16' : data.gpu ? 'GPU' : 'CPU';
      gpuBadge.textContent  = `⚙ ${mode}`;
      gpuBadge.style.display = 'inline';
      return true;
    } else {
      systemStatus.className   = 'badge badge--loading';
      systemStatus.textContent = '● Loading models…';
      return false;
    }
  } catch {
    systemStatus.className   = 'badge badge--error';
    systemStatus.textContent = '● Offline';
    return false;
  }
}

// Poll health every 4 s until ready
(async function waitForReady() {
  const ready = await checkHealth();
  if (!ready) setTimeout(waitForReady, 4000);
})();

// ── Mode tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(t => {
      t.classList.remove('mode-tab--active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('mode-tab--active');
    tab.setAttribute('aria-selected', 'true');
    currentMode = tab.dataset.mode;

    if (currentMode === 'image') {
      imagePanel.hidden = false;
      videoPanel.hidden = true;
    } else {
      imagePanel.hidden = true;
      videoPanel.hidden = false;
    }
    resetViewer();
  });
});

// ── Drag-and-drop helpers ──────────────────────────────────────────────────
function setupDropzone(dropzone, input, labelEl, onFile) {
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dropzone--over');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dropzone--over');
  });
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dropzone--over');
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') input.click();
  });
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
  });
}

function setDropzoneReady(dropzone, labelEl, filename) {
  dropzone.classList.add('dropzone--ready');
  labelEl.textContent = `✓ ${filename}`;
}

// ── Image flow ─────────────────────────────────────────────────────────────
let selectedImageFile = null;

setupDropzone(imageDropzone, imageInput, imageDropLabel, file => {
  if (!file.type.startsWith('image/')) {
    showToast('Please select an image file (JPEG, PNG, …)', 'error');
    return;
  }
  selectedImageFile = file;
  setDropzoneReady(imageDropzone, imageDropLabel, file.name);
  analyseImageBtn.disabled = false;
});

analyseImageBtn.addEventListener('click', async () => {
  if (!selectedImageFile) return;
  const ready = await checkHealth();
  if (!ready) { showToast('Models are still loading. Please wait.', 'info'); return; }

  setLoading(true, 'image');
  try {
    const res = await fetch(`${API}/detect/image`, {
      method:  'POST',
      headers: { 'Content-Type': selectedImageFile.type || 'image/jpeg' },
      body:    selectedImageFile,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const data = await res.json();
    showImageResult(data);
    updateStats(data);
    logAlert(data.risk, data.fire_conf, data.smoke_conf, data.timestamp);
  } catch (e) {
    showToast(`Detection failed: ${e.message}`, 'error');
  } finally {
    setLoading(false, 'image');
  }
});

// ── Video flow ─────────────────────────────────────────────────────────────
let selectedVideoFile = null;

setupDropzone(videoDropzone, videoInput, videoDropLabel, file => {
  if (!file.type.startsWith('video/')) {
    showToast('Please select a video file (MP4, AVI, WebM, …)', 'error');
    return;
  }
  selectedVideoFile = file;
  setDropzoneReady(videoDropzone, videoDropLabel, file.name);
  analyseVideoBtn.disabled = false;
});

analyseVideoBtn.addEventListener('click', async () => {
  if (!selectedVideoFile) return;
  const ready = await checkHealth();
  if (!ready) { showToast('Models are still loading. Please wait.', 'info'); return; }

  setLoading(true, 'video');
  try {
    const max = parseInt(maxFrames.value, 10) || 60;
    const res = await fetch(`${API}/detect/video?max_frames=${max}`, {
      method:  'POST',
      headers: { 'Content-Type': selectedVideoFile.type || 'video/mp4' },
      body:    selectedVideoFile,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const data = await res.json();
    if (!data.frames || data.frames.length === 0) {
      showToast('No frames were returned from the video.', 'error');
      return;
    }
    videoFrames  = data.frames;
    currentFrame = 0;
    setupScrubber(data.frames.length);
    showVideoFrame(0);
    showToast(`Analysed ${data.frame_count} frames`, 'success');
  } catch (e) {
    showToast(`Video analysis failed: ${e.message}`, 'error');
  } finally {
    setLoading(false, 'video');
  }
});

// ── Viewer helpers ─────────────────────────────────────────────────────────
function showImageResult(data) {
  viewerPlaceholder.hidden = true;
  scrubber.hidden          = true;
  resultImage.src          = data.annotated_image;
  resultImage.hidden       = false;
}

function setupScrubber(total) {
  frameSlider.max   = total - 1;
  frameSlider.value = 0;
  scrubber.hidden   = false;
  viewerPlaceholder.hidden = true;
}

function showVideoFrame(idx) {
  if (!videoFrames.length) return;
  idx = Math.max(0, Math.min(idx, videoFrames.length - 1));
  currentFrame = idx;
  const f = videoFrames[idx];
  resultImage.src    = f.thumbnail;
  resultImage.hidden = false;
  frameSlider.value  = idx;
  scrubberLabel.textContent = `Frame ${idx + 1} / ${videoFrames.length}`;
  updateStats(f);
}

frameSlider.addEventListener('input', () => showVideoFrame(+frameSlider.value));
scrubberPrev.addEventListener('click', () => showVideoFrame(currentFrame - 1));
scrubberNext.addEventListener('click', () => showVideoFrame(currentFrame + 1));

function resetViewer() {
  viewerPlaceholder.hidden = false;
  resultImage.hidden       = true;
  resultImage.src          = '';
  scrubber.hidden          = true;
  videoFrames = [];
  resetStats();
}

// ── Stats panel ────────────────────────────────────────────────────────────
function updateStats(data) {
  const fc = +(data.fire_conf  || 0);
  const sc = +(data.smoke_conf || 0);
  const risk = data.risk || 'CLEAR';

  fireBar.style.width   = `${(fc * 100).toFixed(1)}%`;
  smokeBar.style.width  = `${(sc * 100).toFixed(1)}%`;
  fireConf.textContent  = `${(fc * 100).toFixed(0)} %`;
  smokeConf.textContent = `${(sc * 100).toFixed(0)} %`;

  fireZones.textContent  = data.fire_zones    ?? '—';
  smokeZones.textContent = data.smoke_zones   ?? '—';
  sceneObjs.textContent  = data.scene_objects ?? '—';
  frameIdx.textContent   = data.frame         ?? data.frame_idx ?? '—';

  setRisk(risk);
  updateAlertBanner(risk, fc, sc);
}

function resetStats() {
  fireBar.style.width   = '0%';
  smokeBar.style.width  = '0%';
  fireConf.textContent  = '0 %';
  smokeConf.textContent = '0 %';
  fireZones.textContent = '0';
  smokeZones.textContent= '0';
  sceneObjs.textContent = '0';
  frameIdx.textContent  = '—';
  setRisk('CLEAR');
  updateAlertBanner('CLEAR', 0, 0);
}

// ── Risk ring ──────────────────────────────────────────────────────────────
function setRisk(risk) {
  riskRing.dataset.risk     = risk;
  riskLabel.textContent     = risk;
  riskCard.dataset.risk     = risk;
}

// ── Alert banner ───────────────────────────────────────────────────────────
let _lastBannerRisk = 'CLEAR';
function updateAlertBanner(risk, fc, sc) {
  alertBanner.className = `alert-banner alert-banner--${risk.toLowerCase()}`;
  if (risk !== 'CLEAR') {
    alertBanner.textContent =
      `⚠  ${risk} — Fire: ${(fc*100).toFixed(0)}%  |  Smoke: ${(sc*100).toFixed(0)}%`;
  }
  if (risk !== _lastBannerRisk) {
    _lastBannerRisk = risk;
    logAlert(risk, fc, sc, new Date().toISOString());
  }
}

// ── Alert log ──────────────────────────────────────────────────────────────
function logAlert(risk, fc, sc, ts) {
  // Remove "no alerts" placeholder
  const empty = alertLog.querySelector('.alert-log__empty');
  if (empty) empty.remove();

  const item   = document.createElement('li');
  item.className = `alert-log__item alert-log__item--${risk}`;

  const time   = new Date(ts);
  const timeStr = isNaN(time) ? '—' : time.toLocaleTimeString('en-GB', { hour12: false });

  item.innerHTML =
    `<span class="alert-log__time">${timeStr}</span>` +
    `<span class="alert-log__msg">${risk} &nbsp; Fire:${(fc*100).toFixed(0)}% Smoke:${(sc*100).toFixed(0)}%</span>`;

  alertLog.prepend(item);

  // Cap log at 50 entries
  while (alertLog.children.length > 50) alertLog.lastElementChild.remove();
}

clearLogBtn.addEventListener('click', () => {
  alertLog.innerHTML = '<li class="alert-log__empty">No alerts yet.</li>';
  _lastBannerRisk = 'CLEAR';
});

// ── Loading state ──────────────────────────────────────────────────────────
function setLoading(on, mode) {
  if (mode === 'image') {
    analyseImageBtn.disabled = on;
    imageProgress.hidden     = !on;
    if (on) animateProgressBar(imageProgressBar);
    else    imageProgressBar.style.width = '0%';
  } else {
    analyseVideoBtn.disabled = on;
    videoProgress.hidden     = !on;
    if (on) animateProgressBar(videoProgressBar);
    else    videoProgressBar.style.width = '0%';
  }

  if (on) {
    viewerPlaceholder.hidden = false;
    resultImage.hidden       = true;
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    spinner.id        = 'loadingSpinner';
    viewerPlaceholder.appendChild(spinner);
  } else {
    const s = $('loadingSpinner');
    if (s) s.remove();
  }
}

function animateProgressBar(bar) {
  let w = 0;
  const id = setInterval(() => {
    w = Math.min(w + Math.random() * 12, 90);
    bar.style.width = `${w}%`;
    if (w >= 90) clearInterval(id);
  }, 250);
  bar._intervalId = id;
}

// ── Toast notifications ────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ── Polling /api/stats for live updates ───────────────────────────────────
// Polls every 3 s so the stat panel reflects the most recent detection
// even if the user is not actively uploading.
function startStatsPolling() {
  if (statsInterval) return;
  statsInterval = setInterval(async () => {
    try {
      const res  = await fetch(`${API}/stats`);
      const data = await res.json();
      // Only update if there's been at least one detection
      if (data.timestamp) updateStats(data);
    } catch { /* silently ignore */ }
  }, 3000);
}

startStatsPolling();

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft')  showVideoFrame(currentFrame - 1);
  if (e.key === 'ArrowRight') showVideoFrame(currentFrame + 1);
});
