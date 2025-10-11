if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(registration => {
        console.log('ServiceWorker registration successful with scope: ', registration.scope);
      })
      .catch(err => {
        console.log('ServiceWorker registration failed: ', err);
      });
  });
}

// Global state
let allShots = [], appConfig = {}, tfModel = null, currentShot = null;
let currentFacingMode = 'user', videoStream = null, mediaRecorder = null, recordedChunks = [], isRecording = false, solverFrameId = null, guidanceIntervalId = null;

let db;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('ActionCamDB', 1);

        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('effects')) {
                db.createObjectStore('effects', { keyPath: 'name' });
            }
        };

        request.onsuccess = event => {
            db = event.target.result;
            console.log('IndexedDB initialized.');
            resolve();
        };

        request.onerror = event => {
            console.error('IndexedDB error:', event.target.errorCode);
            reject(event.target.errorCode);
        };
    });
}

function saveEffect(effect) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['effects'], 'readwrite');
        const store = transaction.objectStore('effects');
        const request = store.put(effect);

        request.onsuccess = () => resolve();
        request.onerror = event => reject(event.target.error);
    });
}

function loadEffects() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['effects'], 'readonly');
        const store = transaction.objectStore('effects');
        const request = store.getAll();

        request.onsuccess = event => resolve(event.target.result);
        request.onerror = event => reject(event.target.error);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        loadData();
        console.log('Setting up event listeners...');
        setupEventListeners();
        console.log('Event listeners set up.');
    } catch (error) {
        console.error('Error during initialization:', error);
    }
});

// --- DATA LOADING & SETUP ---
async function loadData() {
    try {
        const [shotsResponse, configResponse, customEffects] = await Promise.all([
            fetch('shots.json'),
            fetch('config.json'),
            loadEffects()
        ]);
        const [shotsData, configData] = await Promise.all([shotsResponse.json(), configResponse.json()]);
        
        allShots = shotsData.shots;
        appConfig = configData;

        // Combine default and custom effects
        appConfig.effects = { ...appConfig.effects, ...customEffects.reduce((acc, effect) => {
            acc[effect.name] = effect;
            return acc;
        }, {}) };

        renderShotList(allShots);
    } catch (error) { console.error('Error loading data:', error); document.body.innerHTML = '<div class="alert alert-danger">Failed to load app configuration.</div>'; }
}

let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent the mini-infobar from appearing on mobile
  e.preventDefault();
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  // Update UI notify the user they can install the PWA
  const installBtn = document.getElementById('install-btn');
  if (installBtn) {
    installBtn.style.display = 'block';
  }
});

function setupInstallButton() {
    const installBtn = document.getElementById('install-btn');
    if(installBtn) {
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                console.log(`User response to the install prompt: ${outcome}`);
                deferredPrompt = null;
                installBtn.style.display = 'none';
            }
        });
    }
}

function setupEventListeners() {
    setupInstallButton();
    document.getElementById('quick-record-btn').addEventListener('click', () => {
        currentShot = {
            id: 'quick-record',
            name: 'Quick Record',
            description: 'A quick recording with no guidance.',
            guidance_steps: [],
            effect: null
        };
        startCamera(currentShot.id);
    });
    document.getElementById('close-camera-btn').addEventListener('click', () => { stopCamera(); showView('shot-detail-view'); });
    document.getElementById('switch-camera-btn').addEventListener('click', () => { currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user'; stopCamera(); startCamera(currentShot.id); });
    document.getElementById('record-btn').addEventListener('click', toggleRecording);
    document.getElementById('edit-effect-btn').addEventListener('click', () => {
        console.log('Edit effect button clicked!');
        document.getElementById('effect-editor').classList.add('open');
    });
    document.getElementById('close-editor-btn').addEventListener('click', () => {
        document.getElementById('effect-editor').classList.remove('open');
    });
    document.getElementById('save-preset-btn').addEventListener('click', saveCurrentEffectAsPreset);

    document.getElementById('smooth-transition-checkbox').addEventListener('change', (e) => {
        document.getElementById('camera-video').classList.toggle('smooth-transition', e.target.checked);
    });

    ['brightness', 'contrast', 'saturation', 'sepia', 'hue'].forEach(filter => {
        document.getElementById(`${filter}-slider`).addEventListener('input', updateLiveEffect);
    });
}

function updateLiveEffect() {
    const brightness = document.getElementById('brightness-slider').value;
    const contrast = document.getElementById('contrast-slider').value;
    const saturation = document.getElementById('saturation-slider').value;
    const sepia = document.getElementById('sepia-slider').value;
    const hue = document.getElementById('hue-slider').value;

    document.getElementById('brightness-value').innerText = `${brightness}%`;
    document.getElementById('contrast-value').innerText = `${contrast}%`;
    document.getElementById('saturation-value').innerText = `${saturation}%`;
    document.getElementById('sepia-value').innerText = `${sepia}%`;
    document.getElementById('hue-value').innerText = `${hue}deg`;

    const filterValue = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) sepia(${sepia}%) hue-rotate(${hue}deg)`;
    
    const video = document.getElementById('camera-video');
    video.style.filter = filterValue;

    const effectOverlay = document.getElementById('effect-overlay');
    effectOverlay.innerText = 'Custom Effect';
    effectOverlay.style.display = 'block';
}

async function saveCurrentEffectAsPreset() {
    const presetName = document.getElementById('preset-name-input').value;
    if (!presetName) {
        alert('Please enter a name for your preset.');
        return;
    }

    const brightness = document.getElementById('brightness-slider').value;
    const contrast = document.getElementById('contrast-slider').value;
    const saturation = document.getElementById('saturation-slider').value;
    const sepia = document.getElementById('sepia-slider').value;
    const hue = document.getElementById('hue-slider').value;

    const effect = {
        name: presetName,
        type: 'COLOR_GRADING',
        css_filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) sepia(${sepia}%) hue-rotate(${hue}deg)`
    };

    await saveEffect(effect);
    alert(`Preset '${presetName}' saved!`);

    // Reload effects
    const customEffects = await loadEffects();
    appConfig.effects = { ...appConfig.effects, ...customEffects.reduce((acc, effect) => {
        acc[effect.name] = effect;
        return acc;
    }, {}) };
}

// --- VIEW NAVIGATION ---
function showView(viewId) {
    ['shot-list-view', 'shot-detail-view', 'camera-view'].forEach(id => document.getElementById(id).style.display = 'none');
    document.getElementById(viewId).style.display = 'block';
}

// --- UI RENDERING ---
function renderShotList(shots) {
    const container = document.getElementById('shot-list-container');
    container.innerHTML = '';
    shots.forEach(shot => {
        const col = document.createElement('div');
        col.className = 'col';
        const el = document.createElement('a');
        el.href = '#';
        el.className = 'card h-100 text-white bg-secondary'; // Use card for each shot item
        el.onclick = (e) => { e.preventDefault(); renderShotDetail(shot.id); };
        el.innerHTML = `<div class="card-body"><h5 class="card-title">${shot.name}</h5><p class="card-text">${shot.description}</p></div>`;
        col.appendChild(el);
        container.appendChild(col);
    });
}

function renderShotDetail(shotId) {
    currentShot = allShots.find(s => s.id === shotId);
    if (!currentShot) return;
    const container = document.getElementById('shot-detail-view');
    const youtubeEmbedUrl = getYoutubeEmbedUrl(currentShot.youtube_example_url);
    
    const guidanceStepsHtml = currentShot.guidance_steps.map((step, index) => `
        <li class="list-group-item d-flex justify-content-between align-items-center">
            <span id="step-text-${index}" contenteditable="true" oninput="updateShotStep(${index}, this.innerText)">${step.start_time_seconds}s: ${step.step}</span>
            <input type="number" class="form-control custom-duration-input" value="${step.duration_seconds}" data-step-index="${index}" onchange="updateShotPlan()">
        </li>`).join('');

    container.innerHTML = `<h2>${currentShot.name}</h2><p>${currentShot.description}</p><div class="ratio ratio-16x9 mb-4"><iframe src="${youtubeEmbedUrl}" allowfullscreen></iframe></div><h4>Shot Plan</h4><ul class="list-group mb-4">${guidanceStepsHtml}</ul><div class="d-grid gap-2"><button class="btn btn-primary btn-lg" onclick="startCamera('${currentShot.id}')">Record</button><button class="btn btn-outline-secondary" onclick="showView('shot-list-view')">Back to List</button></div>`;
    updateShotPlan(); // Initialize start times
    showView('shot-detail-view');
}

function updateShotStep(index, newText) {
    currentShot.guidance_steps[index].step = newText.split(': ')[1];
}

function updateShotPlan() {
    let cumulativeTime = 0;
    currentShot.guidance_steps.forEach((step, index) => {
        const input = document.querySelector(`.custom-duration-input[data-step-index="${index}"]`);
        const newDuration = parseInt(input.value, 10);
        
        step.start_time_seconds = cumulativeTime;
        step.duration_seconds = newDuration;

        const stepTextElement = document.getElementById(`step-text-${index}`);
        stepTextElement.innerHTML = `${step.start_time_seconds}s: ${step.step}`;

        cumulativeTime += newDuration;
    });
}

// --- CAMERA & SOLVER ---
async function startCamera(shotId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('Camera not supported.'); return; }
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(()=>{});
    const constraints = {
        video: {
            facingMode: currentFacingMode,
            width: { ideal: 4096 },
            height: { ideal: 2160 }
        },
        audio: true
    };
    try {
        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        const video = document.getElementById('camera-video');
        video.srcObject = videoStream;

        if (currentFacingMode === 'user') {
            video.classList.add('mirrored');
        } else {
            video.classList.remove('mirrored');
        }

        if (document.getElementById('smooth-transition-checkbox').checked) {
            video.classList.add('smooth-transition');
        }
        video.onloadedmetadata = () => {
            applyEffect(video, currentShot.effect);
            video.play();
            showView('camera-view');
            loadSolverModel(currentShot.solver_type).then(() => {
                runSolver();
            });

            const recordingCanvas = document.getElementById('recording-canvas');
            const recordingCtx = recordingCanvas.getContext('2d');
            let renderLoop = () => {
                if (video.paused || video.ended) return;
                recordingCanvas.width = video.videoWidth;
                recordingCanvas.height = video.videoHeight;
                recordingCtx.filter = getComputedStyle(video).filter;
                if (currentFacingMode === 'user') {
                    recordingCtx.translate(video.videoWidth, 0);
                    recordingCtx.scale(-1, 1);
                }
                recordingCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                requestAnimationFrame(renderLoop);
            };
            renderLoop();
        };
    } catch (err) { console.error(err); alert('Could not access camera.'); }
}

function stopCamera() {
    if (isRecording) toggleRecording();
    if (videoStream) videoStream.getTracks().forEach(track => track.stop());
    if (solverFrameId) cancelAnimationFrame(solverFrameId);
    if (guidanceIntervalId) clearInterval(guidanceIntervalId);
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    const video = document.getElementById('camera-video');
    video.classList.remove('mirrored');
    applyEffect(video, null);
    videoStream = null; tfModel = null; solverFrameId = null; guidanceIntervalId = null;
    renderShotDetail(currentShot.id); // Re-render detail view to restore original plan
}

async function loadSolverModel(solverType) {
    const solverConfig = appConfig.solvers[solverType];
    if (!solverConfig) { tfModel = null; return; }
    try {
        if (solverConfig.model === 'blazeface') tfModel = await blazeface.load();
    } catch (err) { console.error('Failed to load model:', err); }
}

async function runSolver() {
    if (!tfModel || !currentShot || !currentShot.solver_rules) return;
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const predictions = await tfModel.estimateFaces(video, false);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (predictions.length > 0) {
        const face = predictions[0];
        const rule = currentShot.solver_rules[0]; // Simple case: one rule
        let feedback = '';

        // Example rule: { "type": "face_position", "x": 0.5, "y": 0.5, "tolerance": 0.1 }
        if (rule.type === 'face_position') {
            const faceCenterX = (face.topLeft[0] + face.bottomRight[0]) / 2 / canvas.width;
            const faceCenterY = (face.topLeft[1] + face.bottomRight[1]) / 2 / canvas.height;
            
            const dx = Math.abs(faceCenterX - rule.x);
            const dy = Math.abs(faceCenterY - rule.y);

            if (dx > rule.tolerance || dy > rule.tolerance) {
                feedback = `Move ${faceCenterY < rule.y ? 'down' : 'up'} and ${faceCenterX < rule.x ? 'right' : 'left'}`;
            } else {
                feedback = 'Perfect!';
            }
        }
        document.getElementById('feedback-overlay').innerText = feedback;
    } else {
        document.getElementById('feedback-overlay').innerText = 'No face detected';
    }
    solverFrameId = requestAnimationFrame(runSolver);
}

async function toggleRecording() {
    console.log(`[${new Date().toISOString()}] toggleRecording called. isRecording: ${isRecording}`);
    const recordBtn = document.getElementById('record-btn');
    const icon = recordBtn.querySelector('i');

    if (isRecording) {
        console.log('Stopping recording...');
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        } else {
            console.warn('mediaRecorder not in recording state or not found.');
        }
        recordBtn.classList.remove('recording');
        icon.classList.remove('fa-square');
        icon.classList.add('fa-circle');
        isRecording = false;
        stopGuidance();
    } else {
        console.log('Attempting to start recording...');
        
        try {
            const fileHandle = await window.showSaveFilePicker({
                suggestedName: `${currentShot.name.replace(/\s+/g, '_')}_${new Date().toISOString()}.webm`,
                types: [{
                    description: 'WebM Video File',
                    accept: { 'video/webm': ['.webm'] },
                }],
            });

            const writable = await fileHandle.createWritable();

            const recordingCanvas = document.getElementById('recording-canvas');
            const canvasStream = recordingCanvas.captureStream();

            if (!canvasStream) {
                alert('Could not capture canvas stream!');
                console.error('canvasStream is not available.');
                return;
            }

            const options = { 
                mimeType: 'video/webm; codecs=vp9',
                videoBitsPerSecond: 25000000 // 25 Mbps
            };

            mediaRecorder = new MediaRecorder(canvasStream, options);
            console.log(`MediaRecorder created. State: ${mediaRecorder.state}`);

            mediaRecorder.onstart = () => {
                console.log(`Recording started. State: ${mediaRecorder.state}`);
                recordBtn.classList.add('recording');
                icon.classList.remove('fa-circle');
                icon.classList.add('fa-square');
                isRecording = true;
                startGuidance();
            };

            mediaRecorder.ondataavailable = async (event) => {
                if (event.data.size > 0) {
                    await writable.write(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                console.log(`Recording stopped. State: ${mediaRecorder.state}`);
                await writable.close();
            };

            mediaRecorder.onerror = (event) => {
                console.error(`MediaRecorder error: ${event.error}`);
            };

            mediaRecorder.start();
            console.log(`mediaRecorder.start() called. State is now: ${mediaRecorder.state}`);

        } catch (e) {
            if (e.name === 'AbortError') {
                console.log('File save picker aborted.');
            } else {
                console.error('Exception while setting up recording:', e);
                alert(`Error setting up recording: ${e}.`);
            }
        }
    }
}

function startGuidance() {
    if (!currentShot || !currentShot.guidance_steps) return;
    let stepIndex = 0;

    function nextStep() {
        if (stepIndex >= currentShot.guidance_steps.length) {
            if (isRecording) toggleRecording(); // Auto-stop recording
            return;
        }
        const stepText = currentShot.guidance_steps[stepIndex].step;
        document.getElementById('feedback-overlay').innerText = stepText;
        
        const duration = currentShot.guidance_steps[stepIndex].duration_seconds * 1000;

        stepIndex++;
        
        if (duration > 0) {
            guidanceIntervalId = setTimeout(nextStep, duration);
        } else {
            nextStep(); // If duration is 0, proceed immediately
        }
    }

    stopGuidance(); // Ensure no other guidance is running
    nextStep();
}

function stopGuidance() {
    if (guidanceIntervalId) clearInterval(guidanceIntervalId);
    guidanceIntervalId = null;
    document.getElementById('feedback-overlay').innerText = '';
}
function getYoutubeEmbedUrl(url) {
    if (!url) return '';
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    if (match && match[2].length === 11) {
        return `https://www.youtube.com/embed/${match[2]}`;
    }
    return ''; // Return empty string for invalid URLs
}
function applyEffect(videoElement, effectName) {
    const effect = appConfig.effects[effectName];
    const effectOverlay = document.getElementById('effect-overlay');

    // Reset any existing animations
    videoElement.style.animation = 'none';

    if (videoElement && effect) {
        if (effect.type === 'COLOR_GRADING') {
            videoElement.style.filter = effect.css_filter;
            effectOverlay.innerText = effect.name;
            effectOverlay.style.display = 'block';
        } else if (effect.type === 'ZOOM') {
            const keyframes = `
                @keyframes slowZoom {
                    from { transform: scale(${effect.from}); }
                    to { transform: scale(${effect.to}); }
                }
            `;
            const styleSheet = document.createElement("style");
            styleSheet.type = "text/css";
            styleSheet.innerText = keyframes;
            document.head.appendChild(styleSheet);

            videoElement.style.animation = `slowZoom ${effect.duration_ms}ms ${effect.timing_function} forwards`;
            effectOverlay.innerText = effect.name;
            effectOverlay.style.display = 'block';
        }
    } else if (videoElement) {
        videoElement.style.filter = 'none';
        effectOverlay.style.display = 'none';
    }
}