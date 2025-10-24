let map, userMarker;
let radars = [], avgZones = [];
let radarMarkers = [];
let watchId = null;
let lastSpeed = 0;
let pipEnabled = false;
let pipVideo = document.getElementById('pipVideo');
let pipCanvas = document.getElementById('pipCanvas');
let pipCtx = pipCanvas.getContext('2d');
let pipStream = null;
let pipInterval = null;

const alertPopup = document.getElementById('alertPopup');
const alertText = document.getElementById('alertText');
const avgZoneBar = document.getElementById('avgZoneBar');
const avgSpeedVal = document.getElementById('avgSpeedVal');
const zoneLimitVal = document.getElementById('zoneLimitVal');
const progressFill = document.getElementById('progressFill');
const carMarker = document.getElementById('carMarker');
const speedDisplay = document.getElementById('speedDisplay');
const pipToggle = document.getElementById('pipToggle');
const adminButtons = document.querySelectorAll('#adminMenu button');

const chime = new Audio('assets/chime.mp3');

let currentPos = null;
let activeAvgZone = null;

// --- Load JSONs ---
async function loadData() {
  try {
    let txt = await fetch('SCDB_SpeedCams.json').then(r => r.text());
    txt = txt.replace(/}\s*{/g, '},{'); 
    const data = JSON.parse(`[${txt}]`);
    radars = data.map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,
      unt: cam.unt
    }));
    console.log(`Loaded ${radars.length} cameras`);
    avgZones = await fetch('avg_zones.json').then(r => r.json());
  } catch (e) {
    console.error(e);
    showAlert(`Error loading JSON: ${e.message}`);
  }
}

// --- Initialize map ---
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([39, 35], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  userMarker = L.circleMarker([0, 0], {
    radius: 8, color: '#00e5ff', fillColor: '#00a3b7', fillOpacity: 1
  }).addTo(map);
}

// --- GPS ---
function startGeolocation() {
  if (!navigator.geolocation) {
    alert('Geolocation not supported');
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 500,
    timeout: 10000
  });
}

function onGeoError(err) {
  console.warn(err);
  showAlert(`GPS error: ${err.message}`);
}

function onPosition(p) {
  const lat = p.coords.latitude, lng = p.coords.longitude;
  const speedMps = p.coords.speed;
  const kmh = speedMps == null ? lastSpeed : Math.round(speedMps * 3.6);
  lastSpeed = kmh;
  speedDisplay.textContent = `${kmh} km/h`;
  currentPos = { lat, lng };
  map.setView([lat, lng], 13);
  userMarker.setLatLng([lat, lng]);
  updateRadarMarkers();
  detectRadars(lat, lng);
  detectAvgZones(lat, lng, kmh);
  drawPiP(kmh);
  if (window.AndroidKeepAwake) window.AndroidKeepAwake();
}

// --- Distance ---
function distanceMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = v => v * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLng - aLng);
  const lat1 = toRad(aLat), lat2 = toRad(bLat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Radar markers 100km ---
function updateRadarMarkers() {
  if (!currentPos) return;
  radarMarkers.forEach(m => map.removeLayer(m));
  radarMarkers = [];
  radars.forEach(r => {
    const d = distanceMeters(currentPos.lat, currentPos.lon, r.lat, r.lon) / 1000;
    if (d <= 100) {
      const color = r.flg === 2 ? '#ffcc00' : '#88f';
      const m = L.circle([r.lat, r.lon], { radius: 200, color, weight: 2 }).addTo(map);
      radarMarkers.push(m);
    }
  });
}

// --- Detect radars ahead ---
let lastAlertTime = 0;
function detectRadars(lat, lng) {
  const now = Date.now();
  radars.forEach(r => {
    const d = distanceMeters(lat, lng, r.lat, r.lon);
    if (d < 500 && now - lastAlertTime > 5000) {
      showAlert(`${r.flg === 2 ? 'Average' : 'Fixed'} Radar — ${Math.round(d)} m`);
      lastAlertTime = now;
    }
  });
}

// --- Avg zone detection ---
function detectAvgZones(lat, lng, kmh) {
  let found = null;
  for (let z of avgZones) {
    const total = distanceMeters(z.start.lat, z.start.lng, z.end.lat, z.end.lng);
    const dStart = distanceMeters(z.start.lat, z.start.lng, lat, lng);
    const dEnd = distanceMeters(z.end.lat, z.end.lng, lat, lng);
    if (Math.abs(dStart + dEnd - total) < 60 && dStart <= total + 30) {
      found = { zone: z, total, distToStart: dStart };
      break;
    }
  }
  if (found && found.zone.type === 'average') {
    activeAvgZone = found.zone;
    const pct = Math.min(1, Math.max(0, found.distToStart / found.total));
    showAvgZone(activeAvgZone, pct, kmh);
  } else {
    hideAvgZone();
    activeAvgZone = null;
  }
}

function showAvgZone(zone, pct, kmh) {
  avgZoneBar.style.display = 'block';
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit;
  const percent = Math.round(pct * 100);
  progressFill.style.width = `${percent}%`;
  carMarker.style.left = `${percent}%`;
  const over = kmh - zone.limit;
  progressFill.style.background = over <= 0
    ? 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))'
    : `linear-gradient(90deg, rgba(${Math.min(255, Math.round(over / zone.limit * 255 * 1.4))},${Math.max(0, 200 - Math.round(over / zone.limit * 200))},60,0.25), rgba(${Math.min(255, Math.round(over / zone.limit * 255 * 1.4))},${Math.max(0, 200 - Math.round(over / zone.limit * 200))},60,0.7))`;
}

function hideAvgZone() {
  avgZoneBar.style.display = 'none';
}

// --- Alerts ---
function showAlert(text) {
  alertText.textContent = text;
  alertPopup.style.display = 'block';
  if (chime) { chime.currentTime = 0; chime.play().catch(() => {}); }
  setTimeout(() => { alertPopup.style.display = 'none'; }, 4000);
}
// --- PiP setup ---
function setupPiPButton() {
  pipToggle.addEventListener('click', async () => {
    if (!document.pictureInPictureEnabled) {
      alert('PiP not supported on this browser');
      return;
    }
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
    } catch (err) {
      console.error('PiP error', err);
      showAlert(`PiP error: ${err.message}`);
    }
  });

  document.addEventListener('leavepictureinpicture', () => {
    pipEnabled = false;
    pipToggle.textContent = 'Enable PiP';
  });
  document.addEventListener('enterpictureinpicture', () => {
    pipEnabled = true;
    pipToggle.textContent = 'Disable PiP';
  });
}

// --- Draw PiP canvas ---
function drawPiP(kmh = 0) {
  renderPipFrame(kmh);
  if (!pipInterval) {
    pipInterval = setInterval(() => renderPipFrame(lastSpeed || 0), 200);
  }
}

function startCanvasLoop() {
  setInterval(() => renderPipFrame(lastSpeed || 0), 300);
}

function renderPipFrame(kmh) {
  const ctx = pipCtx;
  const w = pipCanvas.width, h = pipCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#071021';
  ctx.fillRect(0, 0, w, h);

  if (alertPopup.style.display !== 'none') {
    roundRect(ctx, 10, 10, w - 20, h - 20, 18, '#122033');
    ctx.font = '22px Inter, Arial';
    ctx.fillStyle = '#ffd7d7';
    ctx.fillText('🚨', 28, 58);
    ctx.font = '18px Inter, Arial';
    ctx.fillStyle = '#ffffff';
    wrapText(ctx, alertText.textContent || 'Alert', 70, 48, w - 100, 22);
  } else {
    roundRect(ctx, 20, 50, w - 40, h - 100, 14, '#0b2a33');
    ctx.font = '26px Inter, Arial';
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${kmh} km/h`, 50, 100);
  }
}

// --- Helpers ---
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
    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
}

// --- Admin menu for testing ---
adminButtons.forEach((btn, i) => {
  btn.addEventListener('click', () => {
    if (i === 0) showAlert('Test Fixed Radar Alert');
    if (i === 1) showAlert('Test Average Radar Alert');
    if (i === 2) showAlert('Test Other Alert');
  });
});

// --- Init ---
async function init() {
  await loadData();
  initMap();
  setupPiPButton();
  startGeolocation();
  startCanvasLoop();
}

init();
