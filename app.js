const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models/';
const EMAILJS_SERVICE_ID = "service_mecjyk9";
const EMAILJS_TEMPLATE_ID = "template_y9e32ru";
const EMAIL_COOLDOWN_MS = 5 * 60 * 1000;

let modelsLoaded = false;
let registerVideo, recVideo, regCanvas, recOverlay, beepEl;
let recognitionTimer = null;
let faceMatcher = null;
let labeledDescriptors = [];
const lastEmailSentAt = new Map();

window.addEventListener('DOMContentLoaded', async () => {
  registerVideo = document.getElementById('regVideo');
  recVideo = document.getElementById('recVideo');
  regCanvas = document.getElementById('regCanvas');
  recOverlay = document.getElementById('recOverlay');
  beepEl = document.getElementById('beep');

  document.getElementById('tabRegister').onclick = () => showTab('register');
  document.getElementById('tabRecognize').onclick = () => showTab('recognize');
  document.getElementById('captureBtn').onclick = captureAndRegister;
  document.getElementById('clearAll').onclick = clearAll;
  document.getElementById('startRec').onclick = startRecognition;
  document.getElementById('stopRec').onclick = stopRecognition;

  await loadModels();
  loadStoredDescriptors();
  updateRegisteredList();
  startCamera(registerVideo);
});

function showTab(tab){
  document.getElementById('registerSection').classList.toggle('hidden', tab !== 'register');
  document.getElementById('recognizeSection').classList.toggle('hidden', tab !== 'recognize');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
  document.getElementById('tabRecognize').classList.toggle('active', tab === 'recognize');

  if(tab === 'register'){
    stopRecognition();
    startCamera(registerVideo);
  } else {
    startCamera(recVideo);
  }
}

async function loadModels(){
  if(modelsLoaded) return;
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
  console.log('Models loaded');
}

async function startCamera(videoEl){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    videoEl.srcObject = stream;
    await videoEl.play();

    if(videoEl === recVideo){
      recOverlay.width = recVideo.videoWidth;
      recOverlay.height = recVideo.videoHeight;
    } else {
      regCanvas.width = registerVideo.videoWidth || 320;
      regCanvas.height = registerVideo.videoHeight || 240;
    }
  }catch(e){
    alert('Camera access required. ' + e);
  }
}

function stopCamera(videoEl){
  const s = videoEl?.srcObject;
  if(s) s.getTracks().forEach(t => t.stop());
  if(videoEl) videoEl.srcObject = null;
}

async function captureAndRegister(){
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const fee = document.getElementById('regFee').value;
  const msgEl = document.getElementById('regMsg');

  if(!name || !email){
    msgEl.textContent = 'Enter name and parent email before capture.';
    return;
  }

  msgEl.textContent = 'Capturing image...';

  const canvas = regCanvas;
  canvas.width = registerVideo.videoWidth || 320;
  canvas.height = registerVideo.videoHeight || 240;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(registerVideo, 0, 0, canvas.width, canvas.height);

  const det = await faceapi
    .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if(!det){
    msgEl.textContent = 'No face found. Please try again.';
    return;
  }

  const descriptor = det.descriptor;
  const label = `${name}||${fee}||${email}`;
  const existing = labeledDescriptors.find(ld => ld.label === label);

  if(existing){
    existing.descriptors.push(Array.from(descriptor));
  }else{
    labeledDescriptors.push({ label, descriptors: [Array.from(descriptor)] });
  }

  saveDescriptorsToStorage();
  updateRegisteredList();
  msgEl.textContent = `Registered ${name} (${fee})`;

  document.getElementById('regName').value = '';
  document.getElementById('regEmail').value = '';
}

const STORAGE_KEY = 'bus_faces_v1';
function saveDescriptorsToStorage(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(labeledDescriptors));
  buildFaceMatcher();
}
function loadStoredDescriptors(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw) return;
  try{ labeledDescriptors = JSON.parse(raw); }catch{ labeledDescriptors = []; }
  buildFaceMatcher();
}
function clearAll(){
  if(!confirm('Clear all registered faces?')) return;
  labeledDescriptors = [];
  localStorage.removeItem(STORAGE_KEY);
  updateRegisteredList();
  buildFaceMatcher();
}
function buildFaceMatcher(){
  if(!labeledDescriptors.length){
    faceMatcher = null;
    return;
  }
  const labeledFaceDescriptors = labeledDescriptors.map(ld => {
    const descs = ld.descriptors.map(d => new Float32Array(d));
    return new faceapi.LabeledFaceDescriptors(ld.label, descs);
  });
  faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, 0.6);
  console.log('FaceMatcher built with', labeledFaceDescriptors.length, 'labels');
}
function updateRegisteredList(){
  const ul = document.getElementById('registeredList');
  ul.innerHTML = '';
  if(!labeledDescriptors.length){
    ul.innerHTML = '<li class="muted">No registered faces yet</li>';
    return;
  }
  labeledDescriptors.forEach(ld => {
    const [name, fee, email] = ld.label.split('||');
    const li = document.createElement('li');
    li.textContent = `${name} — ${fee} — ${email} — samples: ${ld.descriptors.length}`;
    ul.appendChild(li);
  });
}

async function startRecognition(){
  if(!faceMatcher){
    alert('No registered faces found. Register some faces first.');
    return;
  }
  if(recognitionTimer) return;
  const interval = parseInt(document.getElementById('recInterval').value) || 2000;
  recognitionTimer = setInterval(checkFrameForRecognition, interval);
  pushLog('Recognition started');
}
function stopRecognition(){
  if(recognitionTimer){
    clearInterval(recognitionTimer);
    recognitionTimer = null;
    pushLog('Recognition stopped');
  }
}

async function checkFrameForRecognition(){
  if(!recVideo || recVideo.paused || recVideo.ended) return;

  const temp = document.createElement('canvas');
  temp.width = recVideo.videoWidth;
  temp.height = recVideo.videoHeight;
  const tctx = temp.getContext('2d');
  tctx.drawImage(recVideo, 0, 0, temp.width, temp.height);

  const detections = await faceapi
    .detectAllFaces(temp, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptors();

  const octx = recOverlay.getContext('2d');
  recOverlay.width = recVideo.videoWidth;
  recOverlay.height = recVideo.videoHeight;
  octx.clearRect(0,0,recOverlay.width, recOverlay.height);

  if(!detections.length) return;

  detections.forEach(det => {
    const box = det.detection.box;
    const best = faceMatcher.findBestMatch(det.descriptor);

    let name = 'Unknown', fee = null, email = null;
    if(best.label !== 'unknown'){
      const parts = best.label.split('||');
      if(parts.length === 3){ [name, fee, email] = parts; }
      else if(parts.length === 2){ [name, fee] = parts; }
      else { name = best.label; }
    }

    octx.lineWidth = 3;
    octx.strokeStyle = fee === 'Paid' ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)';
    octx.strokeRect(box.x, box.y, box.width, box.height);

    const label = (name === 'Unknown') ? 'Unknown' : `${name} • ${fee ?? ''}`.trim();
    octx.font = '16px Arial';
    octx.textBaseline = 'top';
    const textWidth = octx.measureText(label).width + 12;
    octx.fillStyle = fee === 'Paid' ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)';
    octx.fillRect(box.x, Math.max(0, box.y - 22), textWidth, 20);
    octx.fillStyle = '#021018';
    octx.fillText(label, box.x + 6, Math.max(0, box.y - 20));

    if(name === 'Unknown'){
      showAlert('Unrecognized person detected');
      try { beepEl.play().catch(()=>{}); } catch(e){}
    } else {
     
      pushLog(`OK: ${name} (${fee})`);
      maybeSendBoardedEmail(name, email, fee);
    }
  });
}

let alertTimeout = null;
function showAlert(text){
  const box = document.getElementById('alertBox');
  box.classList.remove('hidden');
  box.textContent = '🚨 ' + text;
  if(alertTimeout) clearTimeout(alertTimeout);
  alertTimeout = setTimeout(()=> box.classList.add('hidden'), 4500);
}

function pushLog(text){
  const ul = document.getElementById('logList');
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  ul.prepend(li);
}

// NEW: send mail for both paid/unpaid
function maybeSendBoardedEmail(studentName, toEmail, feeStatus){
  if(!toEmail){
    console.warn('No email stored for', studentName);
    pushLog(`⚠ No email on file for ${studentName}`);
    return;
  }

  const last = lastEmailSentAt.get(toEmail) || 0;
  const now = Date.now();
  if(now - last < EMAIL_COOLDOWN_MS){ return; }

  // English first, then Tamil
  let message = ` Your child ${studentName} boarded the bus successfully.

அன்பிற்குரிய பெற்றோர்/பாதுகாவலர்,
உங்கள் பிள்ளை ${studentName} பேருந்தில் ஏறியுள்ளார் என்பதை தெரிவித்துக்கொள்கிறோம்.`;

  if(feeStatus === 'Unpaid'){
    message += `

⚠ Attention: Your child has pending bus fees. Please clear the fees as soon as possible.

⚠ கவனத்திற்கு: உங்கள் பிள்ளையின் பேருந்து கட்டணம் இன்னும் செலுத்தப்படவில்லை. தயவுசெய்து விரைவில் கட்டணத்தை செலுத்தவும்.`;
  }

  const params = {
    student_name: studentName,
    to_email: toEmail,
    message: message,
    name: "Bus Attendance System",
    email: "noreply@kongu.edu"
  };

  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, params)
    .then(res => {
      lastEmailSentAt.set(toEmail, now);
      pushLog(`📧 Email sent to ${toEmail} for ${studentName}`);
      console.log('EmailJS OK', res);
    })
    .catch(err => {
      console.error('EmailJS error', err);
      pushLog(`❌ Email failed for ${studentName} (${toEmail})`);
    });
}
