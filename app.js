// app.js - minimal prototype for RadarNav behavior
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

const alertPopup = document.getElementById('alertPopup');
const alertText = document.getElementById('alertText');
const avgZoneBar = document.getElementById('avgZoneBar');
const avgSpeedVal = document.getElementById('avgSpeedVal');
const zoneLimitVal = document.getElementById('zoneLimitVal');
const progressFill = document.getElementById('progressFill');
const carMarker = document.getElementById('carMarker');
const speedDisplay = document.getElementById('speedDisplay');
const pipToggle = document.getElementById('pipToggle');

async function init() {
  loadData();
  initMap();
  setupPiPButton();
  startGeolocation();
  startCanvasLoop(); // update canvas even if no pip, so UI stays responsive
}

async function loadData(){
  // load radars.json and avg_zones.json (same-origin)
  try {
    const r = await fetch('radars.json');
    radars = await r.json();
    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch(err){
    console.warn('Could not load radars/avg zones', err);
  }
}

function initMap(){
  map = L.map('map', { zoomControl: false }).setView([40.73, -73.935], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0,0], { radius:8, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);

  // show radars on map
  radars.forEach(r => {
    L.circle([r.lat, r.lng], { radius: 12, color: '#ffcc00', weight:2 }).addTo(map);
  });

  // draw avg zones as line
  avgZones.forEach(z => {
    const line = L.polyline([[z.start.lat, z.start.lng],[z.end.lat, z.end.lng]], { color:'#88f', weight:4, opacity:0.7 }).addTo(map);
  });
}

function startGeolocation(){
  if (!('geolocation' in navigator)){
    alert('Geolocation not supported in this browser');
    return;
  }

  // watchPosition gives continuous updates while tab is active
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 500,
    timeout: 10000
  });
}

function onGeoError(err){
  console.warn('Geo error', err);
}

let currentPos = null;
let activeAvgZone = null;
let avgZoneData = {}; // keep track of zone progress and travelled distance / speed averages

function onPosition(p){
  const lat = p.coords.latitude;
  const lng = p.coords.longitude;
  const speedMps = p.coords.speed; // meters/sec (may be null)
  const timestamp = p.timestamp;

  currentPos = { lat, lng, speedMps, timestamp };
  map.setView([lat, lng], map.getZoom());
  userMarker.setLatLng([lat, lng]);

  // convert to km/h if possible, else fallback (0)
  let kmh = speedMps == null ? lastSpeed : Math.round(speedMps * 3.6);
  lastSpeed = kmh;
  speedDisplay.textContent = `${kmh} km/h`;

  // detect nearby radars (within threshold)
  detectRadars(lat, lng);

  // detect avg zones progress
  detectAvgZones(lat, lng, kmh);

  // update PiP canvas if active
  drawPiP(kmh);
}

// simple haversine distance in meters
function distanceMeters(aLat, aLng, bLat, bLng){
  const R = 6371000;
  const toRad = v => v * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const sinDLat = Math.sin(dLat/2);
  const sinDLon = Math.sin(dLon/2);
  const aa = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R * c;
}

let lastAlertTime = 0;
function detectRadars(lat, lng){
  const now = Date.now();
  // show any radar within 500m (adjustable)
  radars.forEach(r => {
    const d = distanceMeters(lat, lng, r.lat, r.lng);
    if (d < 500 && now - lastAlertTime > 5000){ // throttle alerts
      showAlert(`${r.label || 'Radar'} — ${Math.round(d)} m`);
      lastAlertTime = now;
    }
  });
}

function showAlert(text){
  alertText.textContent = text;
  alertPopup.classList.remove('hidden');

  // automatically hide after 4s (unless new alert arrives)
  clearTimeout(alertPopup._timeout);
  alertPopup._timeout = setTimeout(()=> {
    alertPopup.classList.add('hidden');
  }, 4000);
}

/* AVG ZONES: For each zone, compute progress along the straight line from start->end.
   progress = distance(start, current) / distance(start,end) clamped 0..1.
   This is a rough approximation (works if zones are not winding).
*/
function detectAvgZones(lat, lng, kmh){
  let found = null;
  for (let z of avgZones){
    const start = z.start, end = z.end;
    const total = distanceMeters(start.lat, start.lng, end.lat, end.lng);
    const distToStart = distanceMeters(start.lat, start.lng, lat, lng);
    const distToEnd = distanceMeters(end.lat, end.lng, lat, lng);

    // If current position projects between start and end roughly, or near the segment:
    // Use a simple rule: distToStart + distToEnd - total < threshold
    const gap = Math.abs((distToStart + distToEnd) - total);
    if (gap < 60 && distToStart <= total + 30){ // close to the segment
      found = { zone: z, total, distToStart };
      break;
    }
  }

  if (found){
    const z = found.zone;
    const pct = Math.min(1, Math.max(0, found.distToStart / found.total));
    showAvgZone(z, pct, kmh);
    activeAvgZone = z;
  } else {
    hideAvgZone();
    activeAvgZone = null;
  }
}

function showAvgZone(zone, pct, kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit;

  const percent = Math.round(pct * 100);
  progressFill.style.width = `${percent}%`;
  carMarker.style.left = `${percent}%`;

  // color ramp for avg speed vs limit: green -> yellow -> red
  const over = kmh - zone.limit;
  let fillBg;
  if (over <= 0) {
    fillBg = 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
  } else {
    // more red as over increases
    const r = Math.min(255, Math.round((over / zone.limit) * 255 * 1.4));
    const g = Math.max(0, 200 - Math.round((over / zone.limit) * 200));
    fillBg = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
  }
  progressFill.style.background = fillBg;
}

function hideAvgZone(){
  avgZoneBar.classList.add('hidden');
}

/* PiP: We render the alert popup (or the speed text when no alert) into a canvas,
   wire canvas.captureStream() to a hidden <video>, and requestPictureInPicture() on user gesture.
   Important: requestPictureInPicture must be triggered by user gesture in most browsers, so we provide
   a "Enable PiP" button the user can press.
*/
function setupPiPButton(){
  pipToggle.addEventListener('click', async () => {
    if (!document.pictureInPictureEnabled){
      alert('Picture-in-Picture not supported in this browser');
      return;
    }
    try {
      if (!pipStream) {
        pipStream = pipCanvas.captureStream(25); // 25fps
        pipVideo.srcObject = pipStream;
        await pipVideo.play();
      }
      // toggle PiP
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
    }
  });

  // keep drawing while PiP is active so the PiP window updates
  document.addEventListener('leavepictureinpicture', () => {
    pipEnabled = false;
    pipToggle.textContent = 'Enable PiP';
  });
  document.addEventListener('enterpictureinpicture', () => {
    pipEnabled = true;
    pipToggle.textContent = 'Disable PiP';
  });
}

// draw canvas content for PiP. We draw either the alert popup or a simple speed panel.
function drawPiP(kmh = 0){
  // draw once immediately
  renderPipFrame(kmh);

  // we also run a periodic loop to keep it updating
  if (!pipInterval){
    pipInterval = setInterval(()=> {
      renderPipFrame(lastSpeed || 0);
    }, 200);
  }
}

function startCanvasLoop(){
  // keep canvas updated for PiP (even if not enabled).
  setInterval(() => {
    renderPipFrame(lastSpeed || 0);
  }, 300);
}

function renderPipFrame(kmh){
  const ctx = pipCtx;
  const w = pipCanvas.width;
  const h = pipCanvas.height;

  // clear
  ctx.clearRect(0,0,w,h);

  // background
  ctx.fillStyle = '#071021';
  ctx.fillRect(0,0,w,h);

  // If alert visible => draw alert card; else draw small speed tile
  if (!alertPopup.classList.contains('hidden')) {
    // draw card background (rounded rect)
    roundRect(ctx, 10, 10, w-20, h-20, 18, '#122033');
    // draw icon and text
    ctx.font = '22px Inter, Arial';
    ctx.fillStyle = '#ffd7d7';
    ctx.fillText('🚨', 28, 58);
    ctx.font = '18px Inter, Arial';
    ctx.fillStyle = '#ffffff';
    let text = alertText.textContent || 'Alert';
    wrapText(ctx, text, 70, 48, w-100, 22);
  } else {
    // draw speed tile
    roundRect(ctx, 20, 50, w-40, h-100, 14, '#0b2a33');
    ctx.font = '26px Inter, Arial';
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${kmh} km/h`, 50, 100);
  }
}

// small helper: draw rounded rect
function roundRect(ctx, x, y, width, height, radius, fillStyle){
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

// wrapText helper
function wrapText(ctx, text, x, y, maxWidth, lineHeight){
  const words = text.split(' ');
  let line = '';
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    const testWidth = metrics.width;
    if (testWidth > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
}

// start
init();
