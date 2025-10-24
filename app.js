// app.js - RadarNav prototype with SCDB integration
// Dependencies: Leaflet (loaded in index.html)

let map, userMarker;
let radars = [];
let avgZones = [];
let watchId = null;
let lastSpeed = 0;
let pipEnabled = false;
let pipVideo = document.getElementById('pipVideo');
let pipCanvas = document.getElementById('pipCanvas');
let pipCtx = pipCanvas.getContext('2d');
let pipStream = null;
let pipInterval = null;

// UI elements
const alertPopup = document.getElementById('alertPopup');
const alertText = document.getElementById('alertText');
const avgZoneBar = document.getElementById('avgZoneBar');
const avgSpeedVal = document.getElementById('avgSpeedVal');
const zoneLimitVal = document.getElementById('zoneLimitVal');
const progressFill = document.getElementById('progressFill');
const carMarker = document.getElementById('carMarker');
const speedDisplay = document.getElementById('speedDisplay');
const pipToggle = document.getElementById('pipToggle');
const adminMenu = document.getElementById('adminMenu');
const errorPopup = document.getElementById('errorPopup');

// Chime alert
const chime = new Audio('assets/chime.mp3');

// ------------------- INIT -------------------
async function init() {
  await loadData();
  initMap();
  setupPiPButton();
  setupAdminMenu();
  startGeolocation();
  startCanvasLoop();
}

// ------------------- LOAD DATA -------------------
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const data = await res.json();

    radars = data.map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,
      unt: cam.unt
    }));
    showError(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch (err) {
    showError('Failed to load SCDB: ' + err);
    console.error(err);
  }
}

// ------------------- MAP -------------------
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([39, 38], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0, 0], {
    radius: 10, color: '#00e5ff', fillColor: '#00a3b7', fillOpacity: 1
  }).addTo(map);

  // Add radar markers
  radars.forEach(r => {
    const color = r.flg === 3 ? '#88f' : '#ffcc00'; // avg vs fixed
    const circle = L.circle([r.lat, r.lon], { radius: 14, color, weight: 3 }).addTo(map);
    circle.bindPopup(`Radar: ${r.unt || ''} (${r.flg === 3 ? 'Average' : 'Fixed'})`);
  });

  // Draw avg zones
  avgZones.forEach(z => {
    L.polyline(
      [[z.start.lat, z.start.lng], [z.end.lat, z.end.lng]],
      { color: '#88f', weight: 6, opacity: 0.8 }
    ).addTo(map);
  });
}

// ------------------- GEO -------------------
function startGeolocation() {
  if (!('geolocation' in navigator)) {
    showError('Geolocation not supported');
    return;
  }

  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 500,
    timeout: 10000
  });
}

function onGeoError(err) {
  showError('Geo error: ' + err.message);
}

// ------------------- POSITION -------------------
let currentPos = null;
let activeAvgZone = null;

function onPosition(p) {
  const lat = p.coords.latitude;
  const lng = p.coords.longitude;
  const speedMps = p.coords.speed;

  currentPos = { lat, lng, speedMps };
  map.setView([lat, lng], map.getZoom());
  userMarker.setLatLng([lat, lng]);

  let kmh = speedMps == null ? lastSpeed : Math.round(speedMps * 3.6);
  lastSpeed = kmh;
  speedDisplay.textContent = `${kmh} km/h`;

  detectRadars(lat, lng);
  detectAvgZones(lat, lng, kmh);
  drawPiP(kmh);
}

// ------------------- DISTANCE -------------------
function distanceMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = v => v * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aa = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

// ------------------- RADARS -------------------
let lastAlertTime = 0;
function detectRadars(lat, lng) {
  const now = Date.now();
  radars.forEach(r => {
    const d = distanceMeters(lat, lng, r.lat, r.lon);
    if (d < 500 && now - lastAlertTime > 5000) {
      showAlert(`${r.flg === 3 ? 'Average' : 'Fixed'} Radar — ${Math.round(d)} m`);
      lastAlertTime = now;
    }
  });
}

function showAlert(text) {
  alertText.textContent = text;
  alertPopup.style.top = '40%';
  alertPopup.style.left = '50%';
  alertPopup.classList.remove('hidden');

  if (chime) {
    chime.currentTime = 0;
    const playPromise = chime.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.catch(e => console.warn('Chime play prevented:', e));
    }
  }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout = setTimeout(() => {
    alertPopup.classList.add('hidden');
  }, 4000);
}

// ------------------- ERRORS -------------------
function showError(msg) {
  errorPopup.textContent = msg;
  errorPopup.classList.remove('hidden');
  setTimeout(() => { errorPopup.classList.add('hidden'); }, 5000);
}

// ------------------- AVG ZONES -------------------
function detectAvgZones(lat, lng, kmh) {
  let found = null;
  for (let z of avgZones) {
    const start = z.start, end = z.end;
    const total = distanceMeters(start.lat, start.lng, end.lat, end.lng);
    const distToStart = distanceMeters(start.lat, start.lng, lat, lng);
    const distToEnd = distanceMeters(end.lat, end.lng, lat, lng);
    const gap = Math.abs((distToStart + distToEnd) - total);
    if (gap < 60 && distToStart <= total + 30) {
      found = { zone: z, total, distToStart };
      break;
    }
  }

  if (found) {
    const z = found.zone;
    const pct = Math.min(1, Math.max(0, found.distToStart / found.total));
    showAvgZone(z, pct, kmh);
    activeAvgZone = z;
  } else {
    hideAvgZone();
    activeAvgZone = null;
  }
}

function showAvgZone(zone, pct, kmh) {
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit;

  const percent = Math.round(pct * 100);
  progressFill.style.width = `${percent}%`;
  carMarker.style.left = `${percent}%`;

  const over = kmh - zone.limit;
  let fillBg = over <= 0
    ? 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))'
    : `linear-gradient(90deg, rgba(${Math.min(255, Math.round((over / zone.limit) * 255))},0,60,0.25), rgba(${Math.min(255, Math.round((over / zone.limit) * 255))},0,60,0.7))`;
  progressFill.style.background = fillBg;
}

function hideAvgZone() {
  avgZoneBar.classList.add('hidden');
}

// ------------------- PiP -------------------
function setupPiPButton() {
  pipToggle.addEventListener('click', async () => {
    if (!document.pictureInPictureEnabled) { showError('PiP not supported'); return; }
    try {
      if (!pipStream) {
        pipStream = pipCanvas.captureStream(25);
        pipVideo.srcObject = pipStream;
        await pipVideo.play();
      }
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        pipToggle.textContent = 'Enable PiP';
        pipEnabled = false;
      } else {
        await pipVideo.requestPictureInPicture();
        pipToggle.textContent = 'Disable PiP';
        pipEnabled = true;
      }
    } catch (err) { showError('PiP error: ' + err.message); }
  });
  document.addEventListener('leavepictureinpicture', () => { pipEnabled = false; pipToggle.textContent = 'Enable PiP'; });
  document.addEventListener('enterpictureinpicture', () => { pipEnabled = true; pipToggle.textContent = 'Disable PiP'; });
}

function drawPiP(kmh = 0) {
  renderPipFrame(kmh);
  if (!pipInterval) pipInterval = setInterval(() => renderPipFrame(lastSpeed || 0), 200);
}

function startCanvasLoop() {
  setInterval(() => renderPipFrame(lastSpeed || 0), 300);
}

function renderPipFrame(kmh) {
  const ctx = pipCtx, w = pipCanvas.width, h = pipCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#071021';
  ctx.fillRect(0, 0, w, h);

  if (!alertPopup.classList.contains('hidden')) {
    roundRect(ctx, 10, 10, w - 20, h - 20, 18, '#122033');
    ctx.font = '22px Inter, Arial'; ctx.fillStyle = '#ffd7d7';
    ctx.fillText('🚨', 28, 58);
    ctx.font = '18px Inter, Arial'; ctx.fillStyle = '#fff';
    wrapText(ctx, alertText.textContent || 'Alert', 70, 48, w - 100, 22);
  } else {
    roundRect(ctx, 20, 50, w - 40, h - 100, 14, '#0b2a33');
    ctx.font = '26px Inter, Arial'; ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${kmh} km/h`, 50, 100);
  }
}

// ------------------- ADMIN MENU -------------------
function setupAdminMenu() {
  adminMenu.addEventListener('click', () => {
    adminMenu.classList.toggle('collapsed');
  });

  const testBtns = adminMenu.querySelectorAll('.admin-btn');
  testBtns.forEach(btn => {
    btn.addEventListener('click', () => showAlert(`${btn.dataset.test} alert`));
  });
}

// ------------------- HELPERS -------------------
function roundRect(ctx, x, y, width, height, radius, fillStyle) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) { ctx.fillText(line, x, y); line = words[n] + ' '; y += lineHeight; }
    else { line = testLine; }
  }
  ctx.fillText(line, x, y);
}

// ------------------- START -------------------
init();
