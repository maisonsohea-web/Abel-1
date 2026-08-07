
(() => {
  'use strict';

  const MAX_SECONDS = 90;
  const DEFAULT_NAME = 'Abel';
  const DB_NAME = 'AbelJungleVideoBooth';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'settings';
  const PHOTO_KEY = 'photo';

  const $ = id => document.getElementById(id);
  const screens = [...document.querySelectorAll('.screen')];

  let stream = null;
  let recorder = null;
  let chunks = [];
  let currentBlob = null;
  let timerInterval = null;
  let elapsedSeconds = 0;
  let adminTapCount = 0;
  let pendingConfirmAction = null;
  let currentPhotoUrl = null;

  function showScreen(id) {
    screens.forEach(screen => screen.classList.remove('active'));
    $(id).classList.add('active');
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function metaGet(key) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function metaSet(key, value) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function metaDelete(key) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function loadSettings() {
    const settings = (await metaGet(SETTINGS_KEY)) || { name: DEFAULT_NAME };
    const name = (settings.name || DEFAULT_NAME).trim() || DEFAULT_NAME;
    $('home-name').textContent = 'pour ' + name;
    $('name-input').value = name;
  }

  async function loadPhoto() {
    const blob = await metaGet(PHOTO_KEY);
    if (currentPhotoUrl) URL.revokeObjectURL(currentPhotoUrl);

    if (blob instanceof Blob) {
      currentPhotoUrl = URL.createObjectURL(blob);
      $('home-photo').src = currentPhotoUrl;
      $('admin-photo').src = currentPhotoUrl;
    } else {
      currentPhotoUrl = null;
      $('home-photo').src = 'assets/placeholder.svg';
      $('admin-photo').src = 'assets/placeholder.svg';
    }
  }

  async function saveSettings() {
    const name = $('name-input').value.trim() || DEFAULT_NAME;
    await metaSet(SETTINGS_KEY, { name });
    await loadSettings();
    showMessage('settings-message', '✓ Les réglages ont été enregistrés');
  }

  async function importPhoto(file) {
    if (!file) return;
    $('settings-message').textContent = 'Import de la photo…';

    try {
      const dataUrl = await readFileAsDataURL(file);
      const image = await loadImage(dataUrl);
      const blob = await createCenteredPhotoBlob(image);
      await metaSet(PHOTO_KEY, blob);
      await loadPhoto();
      showMessage('settings-message', '✓ La photo a été ajoutée');
    } catch (error) {
      console.error(error);
      $('settings-message').textContent =
        'La photo n’a pas pu être ajoutée. Essayez une capture d’écran ou une photo JPEG.';
    }
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function createCenteredPhotoBlob(image) {
    return new Promise((resolve, reject) => {
      const size = 900;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;

      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const x = (size - width) / 2;
      const y = (size - height) / 2;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(image, x, y, width, height);

      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Conversion impossible')),
        'image/jpeg',
        0.82
      );
    });
  }

  async function removePhoto() {
    await metaDelete(PHOTO_KEY);
    await loadPhoto();
    showMessage('settings-message', '✓ La photo a été retirée');
  }

  function preferredMimeType() {
    const candidates = [
      'video/mp4;codecs=h264,aac',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    return candidates.find(type => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
  }

  async function startCameraFlow() {
    $('camera-error').textContent = '';

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      $('live-video').srcObject = stream;
      showScreen('screen-camera');
      await runCountdown();
      startRecording();
    } catch (error) {
      console.error(error);
      showScreen('screen-camera');
      $('camera-error').textContent =
        'Impossible d’ouvrir la caméra. Autorisez la caméra et le microphone dans Safari.';
    }
  }

  async function runCountdown() {
    const countdown = $('countdown');
    countdown.classList.remove('hidden');

    for (const value of [3, 2, 1]) {
      countdown.textContent = String(value);
      await wait(850);
    }

    countdown.textContent = '♡';
    await wait(350);
    countdown.classList.add('hidden');
  }

  function startRecording() {
    chunks = [];
    elapsedSeconds = 0;
    updateTimer();

    const mimeType = preferredMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = () => {
      currentBlob = new Blob(chunks, {
        type: recorder.mimeType || mimeType || 'video/mp4'
      });

      $('review-video').src = URL.createObjectURL(currentBlob);
      stopMediaTracks();
      showScreen('screen-review');
    };

    recorder.start(1000);

    timerInterval = setInterval(() => {
      elapsedSeconds += 1;
      updateTimer();
      if (elapsedSeconds >= MAX_SECONDS) stopRecording();
    }, 1000);
  }

  function updateTimer() {
    const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const seconds = String(elapsedSeconds % 60).padStart(2, '0');
    $('timer').textContent = `${minutes}:${seconds}`;
  }

  function stopRecording() {
    clearInterval(timerInterval);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function stopMediaTracks() {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    $('live-video').srcObject = null;
  }

  async function saveCurrentVideo() {
    if (!currentBlob) return;

    const id = Date.now();
    const extension = currentBlob.type.includes('webm') ? 'webm' : 'mp4';
    const record = {
      id,
      createdAt: new Date().toISOString(),
      blob: currentBlob,
      extension
    };

    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('videos', 'readwrite');
        tx.objectStore('videos').put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }

    currentBlob = null;
    $('review-video').removeAttribute('src');
    $('review-video').load();
    showScreen('screen-thanks');
  }

  async function getVideos() {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction('videos', 'readonly').objectStore('videos').getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => b.id - a.id));
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function renderGallery() {
    const videos = await getVideos();
    $('video-count').textContent = String(videos.length);
    const gallery = $('video-gallery');
    gallery.innerHTML = '';

    if (videos.length === 0) {
      gallery.innerHTML = '<p class="center">Aucune vidéo enregistrée.</p>';
      return;
    }

    videos.forEach((video, index) => {
      const url = URL.createObjectURL(video.blob);
      const item = document.createElement('div');
      item.className = 'video-item';
      item.innerHTML = `
        <video src="${url}" controls playsinline></video>
        <div>
          <strong>Message ${videos.length - index}</strong>
          <small>${new Date(video.createdAt).toLocaleString('fr-FR')}</small>
        </div>
        <button class="download-one">Télécharger</button>
      `;

      item.querySelector('button').addEventListener('click', () => {
        downloadBlob(url, `message-abel-${video.id}.${video.extension}`);
      });

      gallery.appendChild(item);
    });
  }

  async function clearAllVideos() {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('videos', 'readwrite');
        tx.objectStore('videos').clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    await renderGallery();
  }

  async function downloadAllVideos() {
    const videos = await getVideos();

    if (videos.length === 0) {
      $('actions-message').textContent = 'Aucune vidéo à télécharger';
      return;
    }

    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];
      const url = URL.createObjectURL(video.blob);
      downloadBlob(
        url,
        `message-abel-${String(index + 1).padStart(2, '0')}.${video.extension}`
      );
      await wait(800);
    }

    showMessage('actions-message', '✓ Les téléchargements ont été lancés');
  }

  function downloadBlob(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function resetReview() {
    currentBlob = null;
    $('review-video').removeAttribute('src');
    $('review-video').load();
  }

  function returnHome() {
    clearInterval(timerInterval);
    stopMediaTracks();
    resetReview();
    showScreen('screen-home');
  }

  function activatePanel(panelId) {
    document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    $(panelId).classList.add('active');
    document.querySelector(`.tab[data-panel="${panelId}"]`).classList.add('active');

    if (panelId === 'panel-videos') renderGallery();
  }

  function openAdmin() {
    loadSettings();
    loadPhoto();
    activatePanel('panel-settings');
    showScreen('screen-admin');
  }

  function requestConfirmation(title, text, action) {
    pendingConfirmAction = action;
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-modal').classList.remove('hidden');
  }

  function closeConfirmation() {
    pendingConfirmAction = null;
    $('confirm-modal').classList.add('hidden');
  }

  function showMessage(id, message) {
    $(id).textContent = message;
    setTimeout(() => {
      if ($(id).textContent === message) $(id).textContent = '';
    }, 2400);
  }

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  $('start-button').addEventListener('click', startCameraFlow);
  $('stop-button').addEventListener('click', stopRecording);
  $('redo-button').addEventListener('click', async () => {
    resetReview();
    await startCameraFlow();
  });
  $('save-button').addEventListener('click', saveCurrentVideo);
  $('home-button').addEventListener('click', returnHome);

  $('save-settings-button').addEventListener('click', saveSettings);
  $('photo-input').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    importPhoto(file);
    event.target.value = '';
  });
  $('remove-photo-button').addEventListener('click', removePhoto);

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => activatePanel(tab.dataset.panel));
  });

  $('download-all-button').addEventListener('click', downloadAllVideos);

  $('delete-all-button').addEventListener('click', () => {
    requestConfirmation(
      'Supprimer toutes les vidéos ?',
      'Cette action est définitive. Téléchargez d’abord les vidéos que vous souhaitez conserver.',
      async () => {
        await clearAllVideos();
        showMessage('actions-message', '✓ Toutes les vidéos ont été supprimées');
      }
    );
  });

  $('reset-button').addEventListener('click', () => {
    requestConfirmation(
      'Réinitialiser l’événement ?',
      'Toutes les vidéos, la photo et le prénom personnalisé seront supprimés.',
      async () => {
        await clearAllVideos();
        await metaDelete(PHOTO_KEY);
        await metaDelete(SETTINGS_KEY);
        await loadSettings();
        await loadPhoto();
        activatePanel('panel-settings');
      }
    );
  });

  $('close-admin-button').addEventListener('click', returnHome);

  $('admin-hotspot').addEventListener('click', () => {
    adminTapCount += 1;
    clearTimeout(window.__adminTapTimer);
    window.__adminTapTimer = setTimeout(() => {
      adminTapCount = 0;
    }, 2500);

    if (adminTapCount >= 5) {
      adminTapCount = 0;
      openAdmin();
    }
  });

  $('cancel-confirm-button').addEventListener('click', closeConfirmation);

  $('confirm-action-button').addEventListener('click', async () => {
    const action = pendingConfirmAction;
    closeConfirmation();
    if (action) await action();
  });

  window.addEventListener('beforeunload', stopMediaTracks);

  async function init() {
    await loadSettings();
    await loadPhoto();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
      });
    }
  }

  init().catch(console.error);
})();
