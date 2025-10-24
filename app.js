// app.full.js - RadarNav single-file (final)
// Requires: Leaflet loaded in page, NoSleep.js optional (recommended)

// -------------------- Config --------------------
const CAMERA_RADIUS_KM = 10;     // show cameras within 10 km
const ALERT_RADIUS_KM = 1.0;     // alert when within 1 km
const AHEAD_ANGLE_DEG = 50;      // ± deg considered "ahead"
const VISUAL_THROTTLE_MS = 600;  // throttle heavy UI updates
const MAX_MARKERS = 250;         // keep nearest N markers for perf

// -------------------- Globals / UI refs --------------------
let map = null;
let userMarker = null;
let radars = [];         // loaded radar objects
let avgZones = [];       // average speed zones
let watchId = null;

let userLat = null;
let userLon = null;
let userSpeed = 0;       // km/h
let userHeading = null;  // degrees
let lastPos = null;      // previous {lat, lon, t}

let lastVisualUpdate = 0;
let lastAlertTime = 0;

const alertPopup = document.getElementById('alertPopup');
const alertText = document.getElementById('alertText');
const avgZoneBar = document.getElementById('avgZoneBar');
const avgSpeedVal = document.getElementById('avgSpeedVal');
const zoneLimitVal = document.getElementById('zoneLimitVal');
const progressFill = document.getElementById('progressFill');
const carMarker = document.getElementById('carMarker');
const pipCanvas = document.getElementById('pipCanvas');
const pipVideo = document.getElementById('pipVideo');
const pipToggle = document.getElementById('pipToggle');
const errorBox = document.getElementById('errorBox');
const adminMenu = document.getElementById('adminMenu');
const btnRadar = document.getElementById('testRadar');
const btnAvgZone = document.getElementById('testAvgZone');
const btnClear = document.getElementById('testClear');

const pipCtx = pipCanvas ? pipCanvas.getContext('2d') : null;
const chime = new Audio('assets/chime.mp3'); // ensure this exists or remove

// NoSleep
let noSleep = (typeof NoSleep !== 'undefined') ? new NoSleep() : null;

// Marker pooling
const markerPool = [];
const activeMarkers = new Map(); // key -> {marker, idx}

// -------------------- Utilities --------------------
function showError(msg, duration = 4000) {
  if (!errorBox) return console.warn(msg);
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
  setTimeout(()=> errorBox.classList.add('hidden'), duration);
}

function showAlert(text) {
  if (!alertPopup || !alertText) return console.log('ALERT:', text);
  alertText.textContent = text;
  alertPopup.classList.remove('hidden');
  // play chime
  if (chime) { chime.currentTime = 0; chime.play().catch(()=>{}); }
  setTimeout(()=> alertPopup.classList.add('hidden'), 4000);
}

// haversine distance in km
function distance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371; // km
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// bearing from p1 -> p2 in degrees 0..360
function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y,x)) + 360) % 360;
}

function angleDiffAbs(a,b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function deriveHeading(prev, curr) {
  if (!prev) return null;
  return bearingDeg(prev.lat, prev.lon, curr.lat, curr.lon);
}

// throttle
function throttle(fn, wait) {
  let last = 0;
  return function(...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn.apply(this, args);
    }
  };
}

// -------------------- Marker pool --------------------
function getMarker() {
  if (markerPool.length) return markerPool.pop();
  return L.circleMarker([0,0], { radius:6, weight:1, fillOpacity:0.9, interactive:false });
}
function releaseMarker(m) {
  try { map.removeLayer(m); } catch(e){}
  markerPool.push(m);
}

// -------------------- Data loading (robust for SCDB) --------------------
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const text = await res.text();
    // SCDB sometimes delivers concatenated JSON objects. Extract objects that contain "lat"
    const re = /\{[^}]*"lat"[^}]*\}/g;
    const matches = text.match(re);
    if (matches && matches.length) {
      radars = matches.map(s => {
        try { const o = JSON.parse(s); return o; } catch(e) { return null; }
      }).filter(Boolean);
    } else {
      // maybe valid JSON array
      try { radars = await JSON.parse(text); } catch(e) { radars = []; }
    }
    console.log('Loaded radars:', radars.length);
  } catch (err) {
    console.error('Failed loading SCDB_SpeedCams.json', err);
    showError('Failed to load radars JSON');
    radars = [];
  }

  try {
    const res2 = await fetch('avg_zones.json');
    avgZones = await res2.json();
    console.log('avgZones:', (avgZones||[]).length);
  } catch(e) {
    console.warn('avg_zones.json not loaded or missing');
    avgZones = [];
  }
}

// -------------------- Map init --------------------
function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true }).setView([39.9334, 32.8597], 13); // Turkey center fallback
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
}

// user marker
function updateUserMarker(lat, lon) {
  if (!userMarker) {
    try {
      userMarker = L.marker([lat, lon], {
        icon: L.icon({ iconUrl: 'car-icon.png', iconSize:[36,36], iconAnchor:[18,18] })
      }).addTo(map);
    } catch(e) {
      userMarker = L.circleMarker([lat,lon], { radius:8, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);
    }
  } else {
    userMarker.setLatLng([lat, lon]);
  }
}

// -------------------- Nearby marker update (throttled) --------------------
function updateNearbyMarkers(userLat, userLon) {
  // build list of radars within CAMERA_RADIUS_KM
  const nearby = [];
  for (let i=0;i<radars.length;i++){
    const r = radars[i];
    if (!r || r.lat==null || r.lon==null) continue;
    const dKm = distance(userLat, userLon, r.lat, r.lon);
    if (dKm <= CAMERA_RADIUS_KM) nearby.push({r, idx:i, dKm});
  }
  // sort by distance and keep nearest MAX_MARKERS
  nearby.sort((a,b)=>a.dKm - b.dKm);
  const keep = new Set();
  const toShow = nearby.slice(0, MAX_MARKERS);
  toShow.forEach(item => keep.add(item.idx));

  // remove markers not in keep
  for (const [idx, marker] of activeMarkers.entries()) {
    if (!keep.has(idx)) {
      releaseMarker(marker);
      activeMarkers.delete(idx);
    }
  }

  // add/update markers for keep
  toShow.forEach(item => {
    const { r, idx } = item;
    if (!activeMarkers.has(idx)) {
      const marker = getMarker();
      const color = (r.flg === 2) ? '#ff3333' : '#ffcc00';
      marker.setStyle({ color, fillColor: color, radius:6 });
      marker.addTo(map);
      activeMarkers.set(idx, marker);
    }
    // set position
    const marker = activeMarkers.get(idx);
    marker.setLatLng([r.lat, r.lon]);
  });
}

// -------------------- Approaching detection --------------------
function isRadarAhead(radar, heading) {
  // get bearing from user to radar
  const br = bearingDeg(userLat, userLon, radar.lat, radar.lon);
  if (heading != null && !isNaN(heading)) {
    return angleDiffAbs(br, heading) <= AHEAD_ANGLE_DEG;
  }
  // fallback: use lastPos-derived heading if available
  if (lastPos && lastPos.lat != null) {
    const derived = deriveHeading(lastPos, { lat:userLat, lon:userLon });
    if (derived != null) return angleDiffAbs(br, derived) <= AHEAD_ANGLE_DEG;
  }
  return true; // if no heading info at all, be permissive
}

function findNearestRelevantRadar(distanceLimitKm = CAMERA_RADIUS_KM) {
  let nearest = null;
  let minKm = Infinity;
  for (let r of radars) {
    if (!r || r.lat==null || r.lon==null) continue;
    const dKm = distance(userLat, userLon, r.lat, r.lon);
    if (dKm > distanceLimitKm) continue;
    if (!isRadarAhead(r, userHeading)) continue;
    if (dKm < minKm) { minKm = dKm; nearest = { r, dKm }; }
  }
  return nearest;
}

function detectApproachingAndAlert() {
  const now = Date.now();
  const nearest = findNearestRelevantRadar(CAMERA_RADIUS_KM);
  if (!nearest) return;
  // if within alert radius and throttle ok
  if (nearest.dKm <= ALERT_RADIUS_KM && (now - lastAlertTime > 5000)) {
    // optional road-check: if avgZones exist, check if radar projects close to any zone segment
    let onRoad = false;
    if (avgZones && avgZones.length) {
      for (const z of avgZones) {
        if (!z || !z.start || !z.end) continue;
        // compute projection approx using distance to segment via simple check:
        // compute distances start->radar + radar->end and compare with start->end length
        const total = distance(z.start.lat, z.start.lng, z.end.lat, z.end.lng) * 1000; // meters
        const d1 = distance(z.start.lat, z.start.lng, nearest.r.lat, nearest.r.lon) * 1000;
        const d2 = distance(nearest.r.lat, nearest.r.lon, z.end.lat, z.end.lng) * 1000;
        const gap = Math.abs((d1 + d2) - total);
        if (gap < 60) { onRoad = true; break; }
      }
    } else {
      onRoad = true;
    }

    if (onRoad) {
      lastAlertTime = now;
      showAlert(`${nearest.r.flg === 2 ? 'Average' : 'Fixed'} camera ahead — ${Math.round(nearest.dKm * 1000)} m`);
      // force pip to show alert frame on next render
      renderPipFrame(userSpeed, true);
    }
  }
}

// -------------------- Average-speed zone detection --------------------
function detectAndShowAvgZone() {
  if (!avgZones || !avgZones.length) { hideAvgZone(); return; }
  for (const z of avgZones) {
    if (!z || !z.start || !z.end) continue;
    // approximate math: project user's position onto segment via distances
    const totalM = distance(z.start.lat, z.start.lng, z.end.lat, z.end.lng) * 1000;
    const dStart = distance(z.start.lat, z.start.lng, userLat, userLon) * 1000;
    const dEnd = distance(z.end.lat, z.end.lng, userLat, userLon) * 1000;
    const gap = Math.abs((dStart + dEnd) - totalM);
    if (gap < 60 && dStart <= totalM + 30) {
      // inside / near segment
      const pct = Math.min(1, Math.max(0, dStart / totalM));
      avgZoneBar.classList.remove('hidden');
      avgSpeedVal.textContent = Math.round(userSpeed);
      zoneLimitVal.textContent = z.limit || '?';
      const percent = Math.round(pct * 100);
      progressFill.style.width = `${percent}%`;
      carMarker.style.left = `${percent}%`;

      // color ramp
      const over = userSpeed - (z.limit || 0);
      if (over <= 0) {
        progressFill.style.background = 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
      } else {
        const r = Math.min(255, Math.round((over / (z.limit || 1)) * 255 * 1.4));
        const g = Math.max(0, 200 - Math.round((over / (z.limit || 1)) * 200));
        progressFill.style.background = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
      }
      return;
    }
  }
  hideAvgZone();
}

function hideAvgZone() {
  avgZoneBar.classList.add('hidden');
}

// -------------------- PiP / Canvas rendering --------------------
function renderPipFrame(speedKmh, alertFrame = false) {
  if (!pipCanvas || !pipCtx) return;
  const w = pipCanvas.width, h = pipCanvas.height;
  pipCtx.clearRect(0, 0, w, h);
  // background
  pipCtx.fillStyle = '#071021';
  pipCtx.fillRect(0, 0, w, h);

  if (alertFrame) {
    // alert card with speed
    roundRect(pipCtx, 8, 8, w - 16, h - 16, 12, '#122033');
    pipCtx.font = '18px Arial';
    pipCtx.fillStyle = '#ffd7d7';
    pipCtx.textAlign = 'left';
    pipCtx.fillText('🚨 Approaching Camera', 28, 40);
    pipCtx.font = '24px Arial';
    pipCtx.fillStyle = '#00e5ff';
    pipCtx.textAlign = 'center';
    pipCtx.fillText(`${Math.round(speedKmh)} km/h`, w/2, h - 28);
  } else {
    // speed-only tile
    roundRect(pipCtx, 16, 24, w - 32, h - 48, 10, '#0b2a33');
    pipCtx.font = '36px Arial';
    pipCtx.fillStyle = '#00e5ff';
    pipCtx.textAlign = 'center';
    pipCtx.fillText(`${Math.round(speedKmh)} km/h`, w/2, h/2 + 8);
  }
}

// helper rounded rect and wrapText
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
  for (let n=0;n<words.length;n++){
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

// pip loop (animationFrame)
let pipLoopId = null;
function startPipLoop() {
  if (pipLoopId) return;
  function loop() {
    const approaching = isApproachingCameraFast();
    renderPipFrame(userSpeed || 0, approaching);
    pipLoopId = requestAnimationFrame(loop);
  }
  loop();
}

// quick check whether any radar within alert radius & ahead (fast)
function isApproachingCameraFast() {
  for (const r of radars) {
    if (!r || r.lat==null) continue;
    const dKm = distance(userLat, userLon, r.lat, r.lon);
    if (dKm <= ALERT_RADIUS_KM && isRadarAhead(r, userHeading)) return true;
  }
  return false;
}

// -------------------- Throttled visual update --------------------
const visualUpdate = throttle(function() {
  // update markers
  updateNearbyMarkers(userLat, userLon);

  // approaching detection + alerts
  detectApproachingAndAlert();

  // avg zone bar
  detectAndShowAvgZone();

  // update pip frame (if not in pip loop also update)
  renderPipFrame(userSpeed || 0, isApproachingCameraFast());

  // update user marker & map center (keeps map centered)
  if (userLat != null && userLon != null) {
    updateUserMarker(userLat, userLon);
  }
}, VISUAL_THROTTLE_MS);

// -------------------- Geolocation wrapper --------------------
function onGPSUpdate(lat, lon, speedMps, headingFromDevice) {
  // update lastPos for derived heading
  const now = Date.now();
  if (lastPos && lastPos.lat != null) {
    // keep previous
  }
  lastPos = { lat: userLat, lon: userLon, t: now };

  userLat = lat; userLon = lon;
  if (speedMps != null && !isNaN(speedMps)) userSpeed = Math.round(speedMps * 3.6);
  if (headingFromDevice != null && !isNaN(headingFromDevice)) userHeading = headingFromDevice;
  else {
    const derived = deriveHeading(lastPos, {lat:userLat, lon:userLon});
    if (derived != null) userHeading = derived;
  }

  // minimal immediate update: speed number and small pip redraw
  renderPipFrame(userSpeed || 0, isApproachingCameraFast());

  // throttled heavy update
  visualUpdate();
}

// -------------------- Geolocation start --------------------
function startGeolocationWatcher() {
  if (!('geolocation' in navigator)) {
    showError('Geolocation not supported in this browser.');
    return;
  }
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(ev => {
    onGPSUpdate(ev.coords.latitude, ev.coords.longitude, ev.coords.speed, ev.coords.heading);
  }, err => {
    console.warn('GPS error', err);
    showError('GPS error: ' + (err && err.message ? err.message : err));
  }, { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 });
}

// -------------------- Admin menu (triple-tap toggle) --------------------
(function adminSetup() {
  let tapCounter = 0, tTimer = null;
  document.addEventListener('click', () => {
    tapCounter++;
    if (tapCounter === 3) {
      if (adminMenu) adminMenu.classList.toggle('collapsed');
      tapCounter = 0;
      clearTimeout(tTimer);
      return;
    }
    clearTimeout(tTimer);
    tTimer = setTimeout(()=> tapCounter = 0, 800);
  });

  if (btnRadar) btnRadar.addEventListener('click', ()=> showApproachingAlert({ flg:1 }, 500));
  if (btnAvgZone) btnAvgZone.addEventListener('click', ()=> showApproachingAlert({ flg:2 }, 800));
  if (btnClear) btnClear.addEventListener('click', ()=> { alertPopup.classList.add('hidden'); hideAvgZone(); });
})();

// -------------------- PiP button --------------------
if (pipToggle) {
  pipToggle.addEventListener('click', async () => {
    if (!document.pictureInPictureEnabled) {
      showError('Picture-in-Picture not supported in this browser.');
      return;
    }
    try {
      if (!pipVideo.srcObject) {
        const stream = pipCanvas.captureStream(25);
        pipVideo.srcObject = stream;
        await pipVideo.play().catch(()=>{});
      }
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        pipToggle.textContent = 'Enable PiP';
      } else {
        await pipVideo.requestPictureInPicture();
        pipToggle.textContent = 'Disable PiP';
      }
    } catch (e) {
      console.error('PiP error', e);
      showError('PiP error: ' + (e && e.message ? e.message : e));
    }
  });
}

// -------------------- NoSleep enable on user gesture --------------------
if (noSleep) {
  document.addEventListener('click', () => {
    try { noSleep.enable(); } catch(e) { /* ignore */ }
  }, { once: true });
}

// -------------------- Init function (load data, map, start gps, pip loop) --------------------
async function initAppFull() {
  try {
    initMap();
    await loadData();
    // center map on first known good position when available by waiting a bit or using geolocation
    startGeolocationWatcher();
    startPipLoop();
    // initial render of pip
    renderPipFrame(userSpeed || 0, false);
  } catch (e) {
    console.error('init error', e);
    showError('Initialization error');
  }
}

// run init
initAppFull();

// expose debug helpers
window.RadarNav = {
  findNearest: () => findNearestRelevantRadar?.() ?? null,
  radarsCount: () => radars.length,
  refetch: async () => { await loadData(); updateNearbyMarkers(userLat, userLon); },
  clearMarkers: () => { for (const m of activeMarkers.values()) try{ map.removeLayer(m); } catch{} activeMarkers.clear(); }
};
