/* app.js - FINAL (300+ lines)
   Works with:
   - index.html (map, top-bar, alert-overlay, speed-display, admin-panel, popup-container)
   - style.css (provided)
   - SCDB_SpeedCams.json and avg_zones.json in same folder
   - assets/chime.mp3 in assets/
   - NoSleep loaded (NoSleep is global if included from CDN)
*/

/* =========================
   CONFIG
   ========================= */
const CONFIG = {
  CAMERA_VISIBLE_M: 10000,    // show markers within 10km
  ALERT_DISTANCE_M: 1000,     // alert when within 1km
  ALERT_THROTTLE_MS: 5000,    // throttle same-camera alerts
  GEO_OPTIONS: { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  PIP_FPS: 20,
  PIP_CANVAS_W: 320,
  PIP_CANVAS_H: 180,
  USER_ICON_SIZE: [44, 44],
  MIN_ZOOM: 12,
  DEFAULT_ZOOM: 15
};

/* =========================
   DOM references
   ========================= */
const el = {
  map: document.getElementById('map'),
  alertOverlay: document.getElementById('alert-overlay') || document.getElementById('alert-overlay'),
  alertBox: document.getElementById('alert-box') || document.getElementById('alertPopup'),
  alertText: document.getElementById('alert-text') || document.getElementById('alertText'),
  progressBar: document.querySelector('#progress-bar > div'),
  progressBarRoot: document.getElementById('progress-bar'),
  speedValue: document.getElementById('speed-value'),
  speedUnit: document.getElementById('speed-unit'),
  adminPanel: document.getElementById('admin-panel'),
  reloadBtn: document.getElementById('reload-btn'),
  togglePipBtn: document.getElementById('toggle-pip'),
  clearAlertsBtn: document.getElementById('clear-alerts'),
  popupContainer: document.getElementById('popup-container'),
  topBar: document.getElementById('top-bar'),
  pipCanvas: document.getElementById('pipCanvas') || (() => {
    const c = document.createElement('canvas');
    c.id = 'pipCanvas';
    c.width = CONFIG.PIP_CANVAS_W;
    c.height = CONFIG.PIP_CANVAS_H;
    c.style.display = 'none';
    document.body.appendChild(c);
    return c;
  })()
};

/* make sure required DOM exists */
if (!el.map) throw new Error('index.html must contain <div id="map"></div>');
if (!el.alertText) console.warn('No alert text element found — alerts will be printed to console');

/* =========================
   STATE
   ========================= */
let map, userMarker, userHeading = 0, lastPos = null;
let radars = [], avgZones = [];
let radarLayerGroup = null;
let watchId = null;
let lastAlertTs = 0;
let perCameraLastAlert = new Map();
let lastSpeedKmh = 0;
let pipEnabled = false;
let pipStream = null, pipVideo = null;
let pipRAF = null;
let pipCtx = null;
let noSleep = window.NoSleep ? new NoSleep() : null; // NoSleep lib if included
let adminTapCount = 0, lastAdminTapTs = 0;

/* Audio chime */
const chime = new Audio('assets/chime.mp3');

/* =========================
   UTILITIES
   ========================= */

// Haversine distance (meters)
function distanceMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = (v) => v * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aa = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

// Bearing (degrees) from A to B
function bearing(aLat, aLon, bLat, bLon) {
  const toRad = v => v * Math.PI / 180;
  const toDeg = v => v * 180 / Math.PI;
  const φ1 = toRad(aLat);
  const φ2 = toRad(bLat);
  const Δλ = toRad(bLon - aLon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// clamp
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// throttle wrapper (ms)
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      return fn(...args);
    }
  };
}

// create popup message in UI
function pushPopup(text, type = 'info', ttl = 3000) {
  if (!el.popupContainer) return;
  const div = document.createElement('div');
  div.className = `popup ${type}`;
  div.textContent = text;
  el.popupContainer.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 400);
  }, ttl);
}

/* =========================
   DATA LOADING
   Robust SCDB parser that handles several nonstandard formats:
   - single JSON array
   - many JSON objects concatenated (no commas)
   - JSON objects separated by newlines or spaces
   - initial _meta object which should be ignored
   ========================= */
async function loadSCDB() {
  try {
    const resp = await fetch('SCDB_SpeedCams.json');
    const text = await resp.text();

    // Attempt 1: direct parse as JSON (array/object)
    try {
      const parsed = JSON.parse(text);
      // If it's an object with cameras property, try to detect
      if (Array.isArray(parsed)) {
        radars = parsed;
      } else if (parsed && parsed.cameras && Array.isArray(parsed.cameras)) {
        radars = parsed.cameras;
      } else {
        // fall through to fallback parsing
        throw new Error('Not array');
      }
    } catch (_) {
      // fallback: split into individual {...} objects
      const chunks = text
        .replace(/\r\n/g, '\n')
        .replace(/\}\s*\{/g, '}|{') // insert delimiter between adjacent objects
        .split('|')
        .map(s => s.trim())
        .filter(Boolean);

      const parsedItems = [];
      for (const chunk of chunks) {
        try {
          const obj = JSON.parse(chunk);
          // skip meta entries
          if (obj && obj._meta) continue;
          parsedItems.push(obj);
        } catch (e) {
          // sometimes file has "}{\n{" patterns handled by replace,
          // but still could have broken entries - skip them
          // If chunk starts with something like {"lat":..., but has trailing garbage, try to extract {...}
          const m = chunk.match(/\{.*\}/s);
          if (m) {
            try {
              parsedItems.push(JSON.parse(m[0]));
            } catch (e2) {
              // give up for this chunk
            }
          }
        }
      }
      radars = parsedItems;
    }

    // normalize keys (some SCDB versions use "lon" vs "lng" or "unt " with stray spaces)
    radars = radars.map(item => {
      const lat = parseFloat(item.lat || item.latitude || item.LAT || item.Lat);
      const lon = parseFloat(item.lon || item.lng || item.lonitude || item.LON);
      const flg = item.flg != null ? parseInt(item.flg) : (item.type || 2);
      const unt = (item.unt || item.unit || item['unt '] || 'kmh').trim();
      return { lat, lon, flg, unt, raw: item };
    }).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));

    console.log('Loaded SCDB cameras:', radars.length);
  } catch (err) {
    console.error('Failed to load SCDB_SpeedCams.json', err);
    pushPopup('Failed to load camera data', 'error');
    radars = [];
  }
}

async function loadAvgZones() {
  try {
    const resp = await fetch('avg_zones.json');
    const data = await resp.json();
    avgZones = Array.isArray(data) ? data : data.zones || [];
    console.log('Loaded avg zones:', avgZones.length);
  } catch (err) {
    console.warn('avg_zones.json missing or invalid. avgZones empty.');
    avgZones = [];
  }
}

/* =========================
   MAP & UI INITIALIZATION
   ========================= */
function initLeafletMap() {
  map = L.map(el.map, {
    zoomControl: false,
    attributionControl: false,
    maxZoom: 20,
    minZoom: CONFIG.MIN_ZOOM
  }).setView([39.0, 35.0], CONFIG.DEFAULT_ZOOM); // reasonable default (Turkey center-ish)

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap & CARTO',
    maxZoom: 20
  }).addTo(map);

  // user marker
  const iconHtml = `<div class="car-arrow" style="transform: rotate(0deg)"></div>`;
  const userIcon = L.divIcon({
    className: 'user-icon',
    html: iconHtml,
    iconSize: CONFIG.USER_ICON_SIZE
  });
  userMarker = L.marker([0, 0], { icon: userIcon, rotationAngle: 0 }).addTo(map);

  // Layer group for radars
  radarLayerGroup = L.layerGroup().addTo(map);
}

/* =========================
   MARKER MANAGEMENT
   Efficient: create markers only for visible radars and reuse if possible
   ========================= */
const visibleMarkers = new Map(); // key: index into radars array -> marker

function refreshVisibleMarkers(userLat, userLon) {
  if (!radars || !radars.length) return;
  const visibleIndices = new Set();

  // Only show radars within 10km
  for (let i = 0; i < radars.length; i++) {
    const r = radars[i];
    if (!r || r.lat == null || r.lon == null) continue;
    const d = distanceMeters(userLat, userLon, r.lat, r.lon);
    if (d <= CONFIG.CAMERA_VISIBLE_M) {
      visibleIndices.add(i);
      if (!visibleMarkers.has(i)) {
        const color = r.flg === 1 ? '#00c853' : '#ffb300';
        const marker = L.circleMarker([r.lat, r.lon], {
          radius: 8,
          fillColor: color,
          color: '#000000',
          weight: 1,
          opacity: 0.9,
          fillOpacity: 0.9
        }).addTo(radarLayerGroup);
        marker.bindPopup(`${r.flg === 1 ? 'Average speed zone camera' : 'Fixed camera'}`);
        visibleMarkers.set(i, marker);
      }
    } else {
      // remove markers outside range
      if (visibleMarkers.has(i)) {
        const m = visibleMarkers.get(i);
        radarLayerGroup.removeLayer(m);
        visibleMarkers.delete(i);
      }
    }
  }

  // remove any marker indexes not in visibleIndices
  for (const idx of [...visibleMarkers.keys()]) {
    if (!visibleIndices.has(idx)) {
      const m = visibleMarkers.get(idx);
      radarLayerGroup.removeLayer(m);
      visibleMarkers.delete(idx);
    }
  }
}

/* =========================
   GEOLOCATION & HEADING
   ========================= */
function trackPositionStart() {
  if (!navigator.geolocation) {
    pushPopup('Geolocation unsupported', 'error');
    return;
  }

  watchId = navigator.geolocation.watchPosition(onPositionUpdate, onPositionError, CONFIG.GEO_OPTIONS);
  pushPopup('Waiting for GPS fix...', 'info', 2500);
}

function onPositionError(err) {
  console.warn('Geolocation error', err);
  pushPopup('GPS error: ' + (err.message || err.code), 'error', 4000);
}

// Use throttling to avoid too-frequent heavy work
const handlePositionThrottled = throttle(handlePositionInternal, 300);

function onPositionUpdate(pos) {
  // pos.coords: latitude, longitude, speed (m/s), heading (deg)
  handlePositionThrottled(pos);
}

function handlePositionInternal(pos) {
  try {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const speedMps = pos.coords.speed;
    const heading = pos.coords.heading;

    userPosition = { lat, lon };
    if (typeof heading === 'number' && !Number.isNaN(heading)) {
      userHeading = heading;
    } else if (lastPos) {
      // compute bearing from lastPos to current
      const computed = bearing(lastPos.lat, lastPos.lon, lat, lon);
      // only update if movement is significant
      userHeading = computed;
    }

    lastPos = { lat, lon };

    // update map & markers
    map.setView([lat, lon], map.getZoom());
    const rotation = userHeading || 0;
    // rotate the user icon by manipulating its inner element
    const iconEl = userMarker.getElement();
    if (iconEl) {
      const arrow = iconEl.querySelector('.car-arrow');
      if (arrow) arrow.style.transform = `rotate(${rotation}deg)`;
    }
    userMarker.setLatLng([lat, lon]);

    // update accuracy circle if desired
    if (pos.coords.accuracy && !isNaN(pos.coords.accuracy)) {
      if (!accuracyCircle) {
        accuracyCircle = L.circle([lat, lon], { radius: pos.coords.accuracy, color: '#00aaff', opacity: 0.2 }).addTo(map);
      } else {
        accuracyCircle.setLatLng([lat, lon]).setRadius(pos.coords.accuracy);
      }
    }

    // speed in km/h (rounded)
    const kmh = (typeof speedMps === 'number' && !isNaN(speedMps)) ? Math.round(speedMps * 3.6) : lastSpeedKmh;
    lastSpeedKmh = kmh;
    updateSpeedDisplay(kmh);

    // update visible markers and check for alerts
    refreshVisibleMarkers(lat, lon);
    detectApproachingCameras(lat, lon, rotation);
    detectAvgZoneProgress(lat, lon, kmh);
    // PiP content updated (it draws from lastSpeedKmh)
  } catch (err) {
    console.error('handlePositionInternal error', err);
  }
}

/* =========================
   UI: speed display
   ========================= */
function updateSpeedDisplay(kmh) {
  if (el.speedValue) el.speedValue.textContent = `${kmh}`;
}

/* =========================
   CAMERA ALERT DETECTION
   - only alert if camera within ALERT_DISTANCE_M
   - check approx direction: only if camera is within +/- 60 degrees of heading
   - throttle per camera
   ========================= */
function detectApproachingCameras(userLat, userLon, headingDeg) {
  if (!radars || radars.length === 0) return;
  const now = Date.now();

  for (let i = 0; i < radars.length; i++) {
    const r = radars[i];
    if (!r || r.lat == null || r.lon == null) continue;

    const d = distanceMeters(userLat, userLon, r.lat, r.lon);
    if (d > CONFIG.ALERT_DISTANCE_M) continue; // too far

    // compute bearing to camera and angular difference
    const brg = bearing(userLat, userLon, r.lat, r.lon);
    let angleDiff = Math.abs((brg - headingDeg + 360) % 360);
    if (angleDiff > 180) angleDiff = 360 - angleDiff;

    // require camera to be roughly ahead (within 60 degrees)
    if (angleDiff > 60) continue;

    // per-camera throttle
    const lastTs = perCameraLastAlert.get(r.lat + ',' + r.lon) || 0;
    if (now - lastTs < CONFIG.ALERT_THROTTLE_MS) continue;

    // Fire alert
    perCameraLastAlert.set(r.lat + ',' + r.lon, now);
    triggerCameraAlert(r, Math.round(d));
  }
}

function triggerCameraAlert(camera, distanceM) {
  // show large centered alert
  showCenteredAlert(`${camera.flg === 1 ? 'Average speed zone' : 'Speed camera'} ahead — ${distanceM} m`);

  // If camera is average, activate avg zone UI logic
  if (camera.flg === 1) {
    // find matching avg zone if any nearby (optional)
    // We'll just show the avg bar with default limit if not found
    const found = findAvgZoneMatchingCamera(camera);
    if (found) {
      activeAvgZoneState.enter(found.zone);
    } else {
      // dummy zone object for UI
      activeAvgZoneState.enter({ start: { lat: camera.lat, lon: camera.lon }, end: { lat: camera.lat, lon: camera.lon }, limit: 50 }, true);
    }
  }

  // play chime (try/catch)
  if (chime) {
    try {
      chime.currentTime = 0;
      const play = chime.play();
      if (play && play.then) play.catch(() => { /* ignore autoplay block */ });
    } catch (e) {}
  }

  // enable pip when approaching
  if (!pipEnabled && el.togglePipBtn) {
    // no automatic PiP in browsers without user gesture; we just prepare canvas
    // show PiP canvas visually only; user can toggle PiP if desired
  }
}

/* find avg zone near a camera */
function findAvgZoneMatchingCamera(camera) {
  if (!avgZones || !avgZones.length) return null;
  for (const z of avgZones) {
    const d1 = distanceMeters(camera.lat, camera.lon, z.start.lat, z.start.lon);
    const d2 = distanceMeters(camera.lat, camera.lon, z.end.lat, z.end.lon);
    if (Math.min(d1, d2) < 200) return { zone: z };
  }
  return null;
}

/* =========================
   AVERAGE ZONE STATE (encapsulate UI)
   ========================= */
const activeAvgZoneState = (function () {
  let active = null;
  let progress = 0;

  function enter(zone, synthetic = false) {
    active = zone;
    progress = 0;
    showAvgUI(zone, progress, synthetic);
  }

  function update(pct, currentKmh) {
    progress = pct;
    showAvgUI(active, progress);
    if (currentKmh != null && active && active.limit != null) {
      // if over limit, color ramp handled by CSS via inline style
      const over = currentKmh - active.limit;
      const fill = progressFill;
      if (fill) {
        if (over <= 0) {
          fill.style.background = 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
        } else {
          const r = Math.min(255, Math.round((over / active.limit) * 255 * 1.4));
          const g = Math.max(0, 200 - Math.round((over / active.limit) * 200));
          fill.style.background = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
        }
      }
    }
  }

  function exit() {
    active = null;
    hideAvgUI();
  }

  function showAvgUI(zone, pct, synthetic = false) {
    if (!el.progressBarRoot) return;
    el.progressBarRoot.style.display = 'block'; // container
    if (el.progressBar) el.progressBar.style.width = `${Math.round(pct * 100)}%`;
    // show limit and current speed if elements exist in index
    const limitEl = document.getElementById('zoneLimitVal') || document.getElementById('zoneLimitVal');
    const curEl = document.getElementById('avgSpeedVal') || document.getElementById('avgSpeedVal');
    if (limitEl) limitEl.textContent = zone.limit || '';
    if (curEl) curEl.textContent = lastSpeedKmh || '';
  }

  function hideAvgUI() {
    if (el.progressBarRoot) el.progressBarRoot.style.display = 'none';
  }

  return { enter, update, exit };
})();

/* evaluate if user is inside an avg zone and update progress */
function detectAvgZoneProgress(userLat, userLon, kmh) {
  // find a zone where the current position projects between start/end roughly
  let found = null;
  for (const z of avgZones) {
    const total = distanceMeters(z.start.lat, z.start.lon, z.end.lat, z.end.lon);
    const dStart = distanceMeters(z.start.lat, z.start.lon, userLat, userLon);
    const dEnd = distanceMeters(z.end.lat, z.end.lon, userLat, userLon);
    const gap = Math.abs((dStart + dEnd) - total);
    if (gap < 60 && dStart <= total + 30) {
      const pct = clamp(dStart / total, 0, 1);
      found = { zone: z, pct };
      break;
    }
  }

  if (found) {
    activeAvgZoneState.update(found.pct, kmh);
  } else {
    activeAvgZoneState.exit();
  }
}

/* =========================
   PIP (Picture-in-Picture) handling
   ========================= */
function initPip() {
  // create a hidden video element (re-use if present)
  pipVideo = document.querySelector('video#pipVideo') || document.createElement('video');
  pipVideo.id = 'pipVideo';
  pipVideo.autoplay = true;
  pipVideo.muted = true;
  pipVideo.playsInline = true;
  pipVideo.style.display = 'none';
  if (!document.body.contains(pipVideo)) document.body.appendChild(pipVideo);

  const canvas = el.pipCanvas || document.getElementById('pipCanvas');
  if (!canvas) return;
  canvas.width = CONFIG.PIP_CANVAS_W;
  canvas.height = CONFIG.PIP_CANVAS_H;
  pipCtx = canvas.getContext('2d');

  // toggle button
  const toggleBtn = document.getElementById('toggle-pip') || document.getElementById('toggle-pip') || el.togglePipBtn;
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      if (!('pictureInPictureEnabled' in document)) {
        pushPopup('Picture-in-Picture not supported in this browser', 'error');
        return;
      }
      try {
        if (!pipStream) {
          pipStream = canvas.captureStream(CONFIG.PIP_FPS);
          pipVideo.srcObject = pipStream;
          await pipVideo.play().catch(() => { /* ignore play error */ });
        }
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          pipActive = false;
          toggleBtn.textContent = 'Enable PiP';
        } else {
          await pipVideo.requestPictureInPicture();
          pipActive = true;
          toggleBtn.textContent = 'Disable PiP';
        }
      } catch (err) {
        console.error('PiP error', err);
        pushPopup('PiP error: ' + (err.message || err), 'error');
      }
    });
  }

  // Paint initial PiP frame loop using RAF
  function pipLoop() {
    renderPipFrame(lastSpeedKmh);
    pipRAF = requestAnimationFrame(pipLoop);
  }
  if (!pipRAF) pipLoop();
}

/* draw PiP frame: either simple speed tile or alert card */
function renderPipFrame(kmh = 0) {
  const canvas = el.pipCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  // background
  ctx.fillStyle = '#071021';
  ctx.fillRect(0, 0, w, h);

  // if there's an active alert overlay visible, show the alert card; else show speed tile
  const alertVisible = (document.getElementById('alert-overlay') && !document.getElementById('alert-overlay').classList.contains('hidden'))
    || (document.querySelector('#alert-box') && !document.querySelector('#alert-box').classList.contains('hidden'))
    || (document.getElementById('alertPopup') && !document.getElementById('alertPopup').classList.contains('hidden'));

  if (alertVisible) {
    // draw alert card
    roundRect(ctx, 12, 12, w - 24, h - 24, 12, '#122033');
    ctx.font = '18px Inter, Arial';
    ctx.fillStyle = '#ffd7d7';
    ctx.fillText('🚨', 28, 48);
    ctx.font = '14px Inter, Arial';
    ctx.fillStyle = '#ffffff';
    const text = (el.alertText && el.alertText.textContent) ? el.alertText.textContent : 'Alert';
    wrapText(ctx, text, 70, 38, w - 90, 18);
  } else {
    // speed tile
    roundRect(ctx, 20, 40, w - 40, h - 80, 12, '#0b2a33');
    ctx.font = '28px Inter, Arial';
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${kmh} km/h`, 34, 100);
  }
}

/* helper: rounded rect on canvas */
function roundRect(ctx, x, y, width, height, r, fillStyle) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/* helper: wrap text in canvas */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
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

/* =========================
   Admin UI
   - triple tap to open/close admin panel
   ========================= */
function initAdminMenu() {
  // hook up buttons if exist
  if (el.reloadBtn) el.reloadBtn.addEventListener('click', async () => {
    pushPopup('Reloading data...', 'info', 1200);
    await loadAllData();
    pushPopup('Data reloaded', 'success', 1200);
  });
  if (el.togglePipBtn) el.togglePipBtn.addEventListener('click', async () => {
    const btn = el.togglePipBtn;
    btn.disabled = true;
    // try to trigger PiP toggle programmatically (requires user gesture)
    const pipEvent = new Event('click');
    document.getElementById('toggle-pip')?.dispatchEvent(pipEvent);
    setTimeout(() => { btn.disabled = false; }, 800);
  });
  if (el.clearAlertsBtn) el.clearAlertsBtn.addEventListener('click', () => {
    document.getElementById('alert-overlay')?.classList.add('hidden');
    document.querySelector('#alert-box')?.classList.add('hidden');
    pushPopup('Alerts cleared', 'success', 1200);
  });

  // triple tap (touch) to toggle admin panel
  document.body.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastAdminTapTs < 600) adminTapCount++;
    else adminTapCount = 1;
    lastAdminTapTs = now;
    if (adminTapCount >= 3) {
      adminTapCount = 0;
      if (el.adminPanel) {
        el.adminPanel.classList.toggle('collapsed');
        if (!el.adminPanel.classList.contains('collapsed')) {
          pushPopup('Admin opened', 'info', 1200);
        }
      }
    }
  });
}

/* =========================
   Mini API: reload everything
   ========================= */
async function loadAllData() {
  await Promise.all([loadSCDB(), loadAvgZones()]);
  // refresh markers based on last known position
  if (lastPos) refreshVisibleMarkers(lastPos.lat, lastPos.lon);
}

/* =========================
   UI helpers
   ========================= */
function showCenteredAlert(text) {
  if (!el.alertOverlay || !el.alertBox || !el.alertText) {
    pushPopup(text, 'info', 3000);
    return;
  }
  el.alertText.textContent = text;
  el.alertOverlay.classList.remove('hidden');
  // show progress bar only if avg zone active
  if (el.progressBarRoot) el.progressBarRoot.style.display = 'none';
  setTimeout(() => {
    el.alertOverlay.classList.add('hidden');
  }, 3600);
}

function showPopup(msg, type = 'info', ttl = 3000) {
  if (!el.popupContainer) return;
  const node = document.createElement('div');
  node.className = `popup ${type}`;
  node.textContent = msg;
  el.popupContainer.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 400);
  }, ttl);
}

/* show a small overlay (alert box) - kept for backward compatibility with some HTML */
function showAlertBox(text) {
  if (!el.alertBox) return;
  const txtEl = el.alertText || document.querySelector('#alert-text');
  if (txtEl) txtEl.textContent = text;
  el.alertBox.classList.remove('hidden');
  setTimeout(() => el.alertBox.classList.add('hidden'), 3600);
}

/* =========================
   Initialization sequence
   ========================= */
async function boot() {
  try {
    // load data
    await loadSCDB();
    await loadAvgZones();
    // init map and pip
    initLeafletMap();
    initPip();
    // start tracking
    trackPositionStart();
    // admin and UI
    initAdminMenu();
    pushPopup('RadarNav ready', 'success', 1500);
  } catch (err) {
    console.error('Boot error', err);
    pushPopup('Boot failed: ' + (err.message || err), 'error', 5000);
  }
}

/* start */
boot();
