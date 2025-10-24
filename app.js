/* app.js - Full-featured RadarNav (approx. 750 lines)
   - Leaflet-based (OpenStreetMap tiles)
   - Robust SCDB parser (handles malformed concatenated JSON)
   - avg_zones.json loader
   - Markers shown within 10km radius
   - Alerts 1km ahead, bearing-aware
   - Average speed zones progress bar
   - PiP (Picture-in-Picture) canvas rendering
   - Admin triple-tap menu
   - NoSleep integration
   - Marker pooling, throttling and performance optimizations
   - Comments and hooks provided.
*/

/* =========================
   CONFIGURATION
   ========================= */
const CONFIG = {
  CAMERA_VISIBLE_M: 10000, // show markers within 10 km
  ALERT_DISTANCE_M: 1000, // alert when within 1 km
  ALERT_THROTTLE_MS: 5000, // same camera not alerted more than once per 5s
  GLOBAL_ALERT_THROTTLE_MS: 3000, // global throttle to avoid spam
  PIP_FPS: 20,
  PIP_CANVAS_W: 360,
  PIP_CANVAS_H: 180,
  GEO_OPTIONS: { enableHighAccuracy: true, maximumAge: 500, timeout: 20000 },
  USER_ICON_SIZE: [44, 44],
  DEFAULT_VIEW: { lat: 39.0, lon: 35.0, zoom: 13 }, // Turkey-ish safe default
  BEARING_AHEAD_ANGLE: 60, // degrees - camera must be within +/-60 deg of heading
  MIN_DISTANCE_TO_UPDATE_MARKERS: 50, // meters - only refresh visible markers if moved > this
  MAX_MARKERS_RENDERED: 1200, // safety cap
  DEBUG: false
};

/* =========================
   DOM ELEMENTS (assumes index.html has these IDs)
   ========================= */
const D = {
  mapContainer: document.getElementById('map'),
  speedDisplay: document.getElementById('speed-display') || document.getElementById('speedDisplay') || document.getElementById('speed-value'),
  alertOverlay: document.getElementById('alert-overlay') || document.getElementById('alertPopup') || document.getElementById('alertPopup'),
  alertText: document.getElementById('alert-text') || document.getElementById('alertText'),
  avgZoneBar: document.getElementById('avgZoneBar'),
  progressFill: document.getElementById('progressFill') || document.querySelector('#progress-bar > div'),
  carMarker: document.getElementById('carMarker') || document.getElementById('carMarker'),
  pipToggleBtn: document.getElementById('toggle-pip') || document.getElementById('pipToggle'),
  pipVideo: document.getElementById('pipVideo') || null,
  pipCanvas: document.getElementById('pipCanvas') || null,
  adminPanel: document.getElementById('admin-panel'),
  reloadBtn: document.getElementById('reload-btn'),
  clearAlertsBtn: document.getElementById('clear-alerts'),
  popupContainer: document.getElementById('popup-container')
};

/* fallback for missing dom elements - create minimal ones */
if (!D.pipCanvas) {
  const c = document.createElement('canvas');
  c.id = 'pipCanvas';
  c.width = CONFIG.PIP_CANVAS_W;
  c.height = CONFIG.PIP_CANVAS_H;
  c.style.display = 'none';
  document.body.appendChild(c);
  D.pipCanvas = c;
}
if (!D.pipVideo) {
  const v = document.createElement('video');
  v.id = 'pipVideo';
  v.autoplay = true;
  v.muted = true;
  v.playsInline = true;
  v.style.display = 'none';
  document.body.appendChild(v);
  D.pipVideo = v;
}

/* =========================
   State
   ========================= */
let map = null;
let userMarker = null;
let accuracyCircle = null;
let radars = []; // loaded camera objects {lat, lon, flg, unt, raw}
let avgZones = []; // average speed zone objects
let visibleMarkerMap = new Map(); // index -> Leaflet marker
let lastPosition = null; // {lat, lon}
let lastMarkerRefreshPos = null;
let positionWatchId = null;
let lastGlobalAlertTs = 0;
let perCameraLastAlertTs = new Map();
let lastSpeedKmh = 0;
let pipStream = null;
let pipCtx = D.pipCanvas.getContext('2d');
let pipRAF = null;
let pipEnabled = false;
let noSleep = (window.NoSleep) ? new NoSleep() : null;
let adminTapCounter = 0;
let lastAdminTapTime = 0;

/* chime */
const chime = new Audio('assets/chime.mp3');

/* convenience logging */
function dbg(...args) {
  if (CONFIG.DEBUG) console.log(...args);
}

/* =========================
   Utility functions
   ========================= */
// degrees -> radians
const toRad = d => d * Math.PI / 180;
// radians -> degrees
const toDeg = r => r * 180 / Math.PI;

/**
 * Haversine distance between two lat/lon points in meters
 */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Bearing from lat1,lon1 to lat2,lon2 in degrees (0..360)
 */
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) -
            Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * angular difference (smallest) between two bearings (deg)
 */
function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * clamp
 */
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * throttle wrapper
 */
function throttle(fn, ms) {
  let last = 0;
  return function(...args) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      return fn(...args);
    }
  };
}

/* =========================
   SCDB parser - robust handling of non-strict JSON from SCDB
   Behavior:
   - Try to parse as array/object first
   - Fallback: split on '}{' or line breaks, try to JSON.parse each chunk
   - Normalize keys: lat/lon, lon/lng, unt with stray spaces, etc.
   ========================= */
async function loadSCDBFile(url = 'SCDB_SpeedCams.json') {
  try {
    const res = await fetch(url);
    const text = await res.text();

    // 1) try JSON.parse directly
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        radars = parsed;
      } else if (parsed && Array.isArray(parsed.cameras)) {
        radars = parsed.cameras;
      } else if (parsed && Array.isArray(parsed.data)) {
        radars = parsed.data;
      } else {
        // fallback to chunk parsing
        throw new Error('Not straightforward array');
      }
    } catch (err) {
      // fallback: split into potential JSON objects
      const normalized = text
        .replace(/\r\n/g, '\n')          // normalize newlines
        .replace(/\}\s*\{/g, '}|{')      // insert delimiter between adjacent objects
        .split('|')
        .map(s => s.trim())
        .filter(Boolean);

      const items = [];
      for (let chunk of normalized) {
        // Sometimes chunk may be missing braces if split by newline; attempt to repair
        chunk = chunk.trim();
        if (!chunk.startsWith('{')) {
          const i = chunk.indexOf('{');
          if (i >= 0) chunk = chunk.slice(i);
        }
        if (!chunk.endsWith('}')) {
          const i = chunk.lastIndexOf('}');
          if (i >= 0) chunk = chunk.slice(0, i+1);
        }
        try {
          const obj = JSON.parse(chunk);
          items.push(obj);
        } catch (e) {
          // try to extract the first {...} substring
          const m = chunk.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              items.push(JSON.parse(m[0]));
            } catch (e2) {
              // give up on this chunk
            }
          } else {
            // skip
          }
        }
      }
      radars = items;
    }

    // normalize radars and clean
    const normalized = [];
    for (const r of radars) {
      if (!r) continue;
      // Accept keys: lat, latitude, LAT, etc. Same for lon/lng
      const lat = parseFloat(r.lat ?? r.latitude ?? r.LAT ?? r.Lat);
      const lon = parseFloat(r.lon ?? r.lng ?? r.longitude ?? r.LON ?? r.Lon ?? r.long);
      const flg = r.flg != null ? parseInt(r.flg) : (r.type != null ? parseInt(r.type) : 2);
      const unt = (r.unt ?? r.unit ?? r['unt '] ?? 'kmh');
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        normalized.push({ lat, lon, flg, unt: String(unt).trim(), raw: r });
      }
    }
    radars = normalized;
    console.log(`[SCDB] Loaded ${radars.length} camera entries`);
    return radars;
  } catch (err) {
    console.error('[SCDB] Error loading file', err);
    radars = [];
    return radars;
  }
}

/* =========================
   avg_zones loader
   expects avg_zones.json to be an array of:
   { start: {lat, lon}, end: {lat, lon}, limit: number, id?: string }
   ========================= */
async function loadAvgZones(url = 'avg_zones.json') {
  try {
    const res = await fetch(url);
    const parsed = await res.json();
    // Accept either array or object with zones property
    if (Array.isArray(parsed)) {
      avgZones = parsed;
    } else if (Array.isArray(parsed.zones)) {
      avgZones = parsed.zones;
    } else {
      avgZones = [];
    }

    // normalize coordinates (some files use lat/lng vs lat/lon)
    avgZones = avgZones.map((z, idx) => {
      const start = { lat: z.start.lat ?? z.start.latitude ?? z.start.LAT, lon: z.start.lon ?? z.start.lng ?? z.start.longitude ?? z.start.LON };
      const end = { lat: z.end.lat ?? z.end.latitude ?? z.end.LAT, lon: z.end.lon ?? z.end.lng ?? z.end.longitude ?? z.end.LON };
      return { start, end, limit: z.limit ?? z.speed ?? z.limit_kmh ?? 50, id: z.id ?? `zone_${idx}` };
    }).filter(z => Number.isFinite(z.start.lat) && Number.isFinite(z.start.lon) && Number.isFinite(z.end.lat) && Number.isFinite(z.end.lon));
    console.log(`[avg_zones] Loaded ${avgZones.length} average zones`);
    return avgZones;
  } catch (err) {
    console.warn('[avg_zones] missing or invalid file', err);
    avgZones = [];
    return avgZones;
  }
}

/* =========================
   MAP initialization
   - create Leaflet map, user marker (rotatable via DOM)
   - marker pooling / layerGroup for radars
   ========================= */
function initMap() {
  if (!D.mapContainer) throw new Error('index.html must have <div id="map">');

  // initialize map with a tile layer that looks like Google/Carto light
  map = L.map(D.mapContainer, { zoomControl: true, attributionControl: false }).setView([CONFIG.DEFAULT_VIEW.lat, CONFIG.DEFAULT_VIEW.lon], CONFIG.DEFAULT_VIEW.zoom);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap & CARTO',
    maxZoom: 20
  }).addTo(map);

  // user marker using a small div with arrow (rotate via CSS transform)
  const userHtml = '<div class="user-icon"><div class="car-arrow" style="transform: rotate(0deg);"></div></div>';
  const userIcon = L.divIcon({ className: 'user-icon-wrapper', html: userHtml, iconSize: CONFIG.USER_ICON_SIZE, iconAnchor: [CONFIG.USER_ICON_SIZE[0]/2, CONFIG.USER_ICON_SIZE[1]/2] });

  userMarker = L.marker([CONFIG.DEFAULT_VIEW.lat, CONFIG.DEFAULT_VIEW.lon], { icon: userIcon, interactive: false }).addTo(map);

  // group to contain radar markers for efficient clearing
  const radarLayer = L.layerGroup().addTo(map);
  map._radarLayer = radarLayer;

  // group for avg zones visual (polylines)
  const avgLayer = L.layerGroup().addTo(map);
  map._avgLayer = avgLayer;

  // draw avg zones (deferred - only draw if zones loaded)
  for (const z of avgZones) {
    try {
      const line = L.polyline([[z.start.lat, z.start.lon], [z.end.lat, z.end.lon]], { color: '#3388ff', weight: 4, opacity: 0.5 }).addTo(map._avgLayer);
      z._line = line;
    } catch (e) {}
  }
}

/* =========================
   Manage radar marker visibility
   - show only markers within CONFIG.CAMERA_VISIBLE_M
   - pool markers to avoid recreating
   - cap total markers for performance
   ========================= */
function refreshRadarMarkers(centerLat, centerLon) {
  const radarLayer = map._radarLayer;
  if (!radarLayer) return;

  // track which indices should be visible this update
  const visibleIndices = new Set();
  let renderedCount = 0;

  for (let i = 0; i < radars.length; i++) {
    if (renderedCount >= CONFIG.MAX_MARKERS_RENDERED) break; // enforce cap
    const r = radars[i];
    if (!r) continue;
    const d = distanceMeters(centerLat, centerLon, r.lat, r.lon);
    if (d <= CONFIG.CAMERA_VISIBLE_M) {
      visibleIndices.add(i);
      renderedCount++;
      if (!visibleMarkerMap.has(i)) {
        const color = (r.flg === 1) ? '#00c853' : '#ffb300';
        const marker = L.circleMarker([r.lat, r.lon], { radius: 8, fillColor: color, color: '#111', weight: 1, opacity: 0.95, fillOpacity: 0.9 });
        marker.addTo(radarLayer);
        // store reference to index
        visibleMarkerMap.set(i, marker);
      } else {
        // marker already exists; ensure it's in the layer
        const marker = visibleMarkerMap.get(i);
        if (!radarLayer.hasLayer(marker)) radarLayer.addLayer(marker);
      }
    } else {
      // outside radius
      if (visibleMarkerMap.has(i)) {
        const marker = visibleMarkerMap.get(i);
        if (radarLayer.hasLayer(marker)) radarLayer.removeLayer(marker);
        // keep in map for reuse (pooling) — don't delete
      }
    }
  }

  // remove any markers that are currently in visibleMarkerMap but not needed
  for (const [idx, marker] of visibleMarkerMap.entries()) {
    if (!visibleIndices.has(idx)) {
      if (radarLayer.hasLayer(marker)) radarLayer.removeLayer(marker);
    }
  }
}

/* =========================
   Detect approaching cameras and fire alerts
   - must be within ALERT_DISTANCE_M
   - must be roughly ahead (bearing within +/- BEARING_AHEAD_ANGLE)
   - per-camera throttling and global throttling
   ========================= */
function detectApproachingCameras(userLat, userLon, userHeading) {
  const now = Date.now();

  // global throttle
  if (now - lastGlobalAlertTs < CONFIG.GLOBAL_ALERT_THROTTLE_MS) return;

  for (let i = 0; i < radars.length; i++) {
    const r = radars[i];
    if (!r) continue;
    const d = distanceMeters(userLat, userLon, r.lat, r.lon);
    if (d > CONFIG.ALERT_DISTANCE_M) continue;

    // bearing check
    const brg = bearingTo(userLat, userLon, r.lat, r.lon);
    const diff = angleDiff(brg, userHeading || brg); // if heading unknown, allow
    if (diff > CONFIG.BEARING_AHEAD_ANGLE) continue;

    // per-camera throttle
    const key = `${r.lat},${r.lon}`;
    const lastTs = perCameraLastAlertTs.get(key) || 0;
    if (now - lastTs < CONFIG.ALERT_THROTTLE_MS) continue;

    // trigger alert for this camera
    perCameraLastAlertTs.set(key, now);
    lastGlobalAlertTs = now;
    handleCameraAlert(r, Math.round(d));
    // Do not break — still allow multiple close cameras if needed? We'll break to avoid spam
    break;
  }
}

/* handle camera alert:
   - show central alert overlay
   - prepare avg zone UI if flg == 1
   - optionally speak / vibrate / play chime
*/
function handleCameraAlert(camera, distanceM) {
  const typeLabel = camera.flg === 1 ? 'Average speed zone' : 'Fixed camera';
  const msg = `${typeLabel} ahead — ${distanceM} m`;
  showCenteredAlert(msg);

  // play chime
  try {
    chime.currentTime = 0;
    const p = chime.play();
    if (p && p.then) p.catch(() => {});
  } catch (e) {}

  // if avg zone camera, show avg UI (attempt to match zone)
  if (camera.flg === 1) {
    const matched = findAvgZoneNearCamera(camera);
    if (matched) {
      activeAvgZoneState.enter(matched.zone);
    } else {
      // show a synthetic zone with default limit if none found
      activeAvgZoneState.enter({ start: { lat: camera.lat, lon: camera.lon }, end: { lat: camera.lat, lon: camera.lon }, limit: 50 }, true);
    }
  }
}

/* Attempt to find an avg zone close to the camera location */
function findAvgZoneNearCamera(camera) {
  if (!avgZones || !avgZones.length) return null;
  for (const z of avgZones) {
    const d1 = distanceMeters(camera.lat, camera.lon, z.start.lat, z.start.lon);
    const d2 = distanceMeters(camera.lat, camera.lon, z.end.lat, z.end.lon);
    if (Math.min(d1, d2) < 200) {
      return { zone: z };
    }
  }
  return null;
}

/* =========================
   Average zone UI state
   encapsulate showing/hiding/updating of the progress bar
   ========================= */
const activeAvgZoneState = (function() {
  let active = null;
  let synthetic = false;

  function enter(zoneObj, isSynthetic = false) {
    active = zoneObj;
    synthetic = !!isSynthetic;
    showAvgUI();
  }

  function updateProgress(pct, currentKmh) {
    if (!active) return;
    const percent = clamp(Math.round(pct * 100), 0, 100);
    if (D.progressFill) D.progressFill.style.width = `${percent}%`;
    // color ramp
    const limit = active.limit || 50;
    const over = (currentKmh || lastSpeedKmh) - limit;
    if (D.progressFill) {
      if (over <= 0) {
        D.progressFill.style.background = 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
      } else {
        const r = clamp(Math.round((over / limit) * 255 * 1.4), 0, 255);
        const g = clamp(200 - Math.round((over / limit) * 200), 0, 200);
        D.progressFill.style.background = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
      }
    }
    // update textual elements if present
    const limitEl = document.getElementById('zoneLimitVal');
    const curEl = document.getElementById('avgSpeedVal');
    if (limitEl) limitEl.textContent = active.limit || '';
    if (curEl) curEl.textContent = currentKmh || lastSpeedKmh || '';
  }

  function exit() {
    active = null;
    if (D.progressFill) D.progressFill.style.width = '0%';
    const root = document.getElementById('avgZoneBar') || D.avgZoneBar;
    if (root) root.classList.add('hidden');
  }

  function showAvgUI() {
    const root = document.getElementById('avgZoneBar') || D.avgZoneBar;
    if (root) root.classList.remove('hidden');
    // set initial progress to 0
    if (D.progressFill) D.progressFill.style.width = '0%';
  }

  return { enter, updateProgress, exit };
})();

/* Called on each GPS update to see if user is inside an avg zone and update progress */
function detectAvgZoneForPosition(lat, lon, currentKmh) {
  if (!avgZones || !avgZones.length) {
    activeAvgZoneState.exit();
    return;
  }

  let matched = null;
  for (const z of avgZones) {
    const total = distanceMeters(z.start.lat, z.start.lon, z.end.lat, z.end.lon);
    const dStart = distanceMeters(z.start.lat, z.start.lon, lat, lon);
    const dEnd = distanceMeters(z.end.lat, z.end.lon, lat, lon);
    const gap = Math.abs((dStart + dEnd) - total);
    if (gap < 60 && dStart <= total + 30) {
      const pct = clamp(dStart / total, 0, 1);
      matched = { zone: z, pct };
      break;
    }
  }

  if (matched) {
    activeAvgZoneState.updateProgress(matched.pct, currentKmh);
  } else {
    activeAvgZoneState.exit();
  }
}

/* =========================
   Centered alert overlay
   ========================= */
function showCenteredAlert(text, duration = 4000) {
  try {
    const overlay = document.getElementById('alert-overlay') || D.alertOverlay;
    const textEl = document.getElementById('alert-text') || D.alertText;
    if (overlay && textEl) {
      textEl.textContent = text;
      overlay.classList.remove('hidden');
      // animation: show
      overlay.style.opacity = '1';
      setTimeout(() => {
        overlay.style.opacity = '0';
        overlay.classList.add('hidden');
      }, duration);
    } else {
      // fallback popup
      pushPopup(text, 'info', duration);
    }
  } catch (e) {
    pushPopup(text, 'info', duration);
  }
}

/* =========================
   Popups (top small toasts)
   ========================= */
function pushPopup(text, type = 'info', ttl = 3000) {
  if (!D.popupContainer) return;
  const node = document.createElement('div');
  node.className = `popup ${type}`;
  node.textContent = text;
  D.popupContainer.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 350);
  }, ttl);
}

/* =========================
   PiP functions
   - create stream from canvas, attach to hidden video
   - requestPictureInPicture on user gesture
   - render PiP canvas with speed or alert card
   ========================= */
function initPiP() {
  // ensure canvas size
  D.pipCanvas.width = CONFIG.PIP_CANVAS_W;
  D.pipCanvas.height = CONFIG.PIP_CANVAS_H;

  // ensure pip video exists
  if (!D.pipVideo) {
    const v = document.createElement('video');
    v.id = 'pipVideo';
    v.style.display = 'none';
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    document.body.appendChild(v);
    D.pipVideo = v;
  }

  // wire up toggle button (user must tap)
  const btn = D.pipToggleBtn || document.getElementById('pipToggle');
  if (btn) {
    btn.addEventListener('click', async () => {
      if (!('pictureInPictureEnabled' in document)) {
        pushPopup('PiP not supported on this browser', 'error', 2000);
        return;
      }
      try {
        if (!pipStream) {
          pipStream = D.pipCanvas.captureStream(CONFIG.PIP_FPS);
          D.pipVideo.srcObject = pipStream;
          await D.pipVideo.play().catch(() => {});
        }
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          pipEnabled = false;
          btn.textContent = 'Enable PiP';
        } else {
          await D.pipVideo.requestPictureInPicture();
          pipEnabled = true;
          btn.textContent = 'Disable PiP';
        }
      } catch (err) {
        console.error('PiP error', err);
        pushPopup('PiP error', 'error', 2000);
      }
    });
  }

  // Start RAF-based PiP drawing loop
  function pipLoop() {
    renderPipFrame(lastSpeedKmh);
    pipRAF = requestAnimationFrame(pipLoop);
  }
  if (!pipRAF) pipLoop();
}

/* Draw PiP frame into canvas
   - If alert is visible: show alert card
   - Else show speed tile
*/
function renderPipFrame(kmh = 0) {
  const canvas = D.pipCanvas;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // dark background
  ctx.fillStyle = '#071021';
  ctx.fillRect(0, 0, w, h);

  // check if centered alert is visible
  const overlay = document.getElementById('alert-overlay') || D.alertOverlay;
  const alertVisible = overlay && !overlay.classList.contains('hidden') && overlay.style.opacity !== '0';

  if (alertVisible) {
    // show alert card
    roundRect(ctx, 10, 10, w - 20, h - 20, 12, '#122033');
    ctx.font = '20px Inter, Arial';
    ctx.fillStyle = '#ffd7d7';
    ctx.fillText('🚨', 28, 48);
    ctx.font = '14px Inter, Arial';
    ctx.fillStyle = '#fff';
    const txt = (document.getElementById('alert-text') || D.alertText)?.textContent || 'Alert';
    wrapText(ctx, txt, 70, 38, w - 90, 18);
  } else {
    // speed tile
    roundRect(ctx, 20, 40, w - 40, h - 80, 12, '#0b2a33');
    ctx.font = '28px Inter, Arial';
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${kmh} km/h`, 34, 100);

    // if avg zone active, show small label
    if (activeAvgZone) {
      ctx.font = '12px Inter, Arial';
      ctx.fillStyle = '#fff';
      ctx.fillText(`AVG ZONE ${activeAvgZone.limit || ''}`, 34, 130);
    }
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

/* wrap text on canvas */
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
   NoSleep and wake lock
   ========================= */
function initNoSleep() {
  try {
    if (window.NoSleep) {
      noSleep = new NoSleep();
      // We'll enable on first user interaction to satisfy browser gesture rules
      const onFirst = () => { noSleep.enable(); document.removeEventListener('touchstart', onFirst); document.removeEventListener('click', onFirst); };
      document.addEventListener('touchstart', onFirst, { once: true });
      document.addEventListener('click', onFirst, { once: true });
    } else {
      console.warn('NoSleep not present (include nosleep.js for wake-lock)');
    }
  } catch (e) {
    console.warn('NoSleep init error', e);
  }
}

/* =========================
   Heading & "snap-to-road" note
   We attempt to use GPS heading if present. If not present, compute bearing between last two positions.
   For proper road snapping, you'd call an external Roads/MapMatching API (Google/Mapbox/OpenRouteService)
   which requires API keys and calls; we include a stub hook below you can implement later.
   ========================= */

function computeHeading(prevPos, curPos) {
  if (!prevPos || !curPos) return 0;
  return bearingTo(prevPos.lat, prevPos.lon, curPos.lat, curPos.lon);
}

/* optional road snapping hook - not active by default
   Implementers: replace with actual API call and return a promise resolving to snapped coordinate and heading
*/
async function snapToRoadStub(lat, lon, heading) {
  // Example: call Mapbox/OSRM/Roads API here.
  // Return { lat, lon, heading } when implemented.
  return { lat, lon, heading };
}

/* =========================
   Position handling: main watcher
   - on each position update:
     * update user marker
     * refresh visible markers when moved enough
     * detect approaching cameras
     * detect avg zone progress
     * update PiP canvas
   ========================= */
async function onPositionUpdate(pos) {
  try {
    const coords = pos.coords;
    const lat = coords.latitude;
    const lon = coords.longitude;
    const speedMps = coords.speed;
    const heading = (typeof coords.heading === 'number' && !isNaN(coords.heading)) ? coords.heading : null;

    // compute speed km/h
    const kmh = (typeof speedMps === 'number' && !isNaN(speedMps)) ? Math.round(speedMps * 3.6) : lastSpeedKmh;
    lastSpeedKmh = kmh;

    // compute heading: use GPS heading if available, else compute from movement if we have lastPosition
    let usedHeading = heading;
    if (usedHeading == null && lastPosition) {
      usedHeading = computeHeading(lastPosition, { lat, lon });
    }

    // optional: snap to road (not activated by default)
    // const snapped = await snapToRoadStub(lat, lon, usedHeading);
    // if (snapped) { lat = snapped.lat; lon = snapped.lon; usedHeading = snapped.heading; }

    // update lastPosition
    const movedEnough = !lastPosition || distanceMeters(lastPosition.lat, lastPosition.lon, lat, lon) > CONFIG.MIN_DISTANCE_TO_UPDATE_MARKERS;

    lastPosition = { lat, lon, heading: usedHeading, speed: kmh, timestamp: Date.now() };

    // update UI: speed display
    updateSpeedUI(kmh);

    // update user marker & rotation
    updateUserMarker(lat, lon, usedHeading);

    // refresh visible markers only when moved enough to save work
    if (movedEnough) {
      refreshRadarMarkers(lat, lon);
      lastMarkerRefreshPos = { lat, lon };
    }

    // detect approaching cameras (bearing-aware)
    detectApproachingCameras(lat, lon, usedHeading || 0);

    // avg zone detection / progress
    detectAvgZoneForPosition(lat, lon, kmh);

    // draw PiP frame (keeps canvas fresh even if PiP not active)
    renderPipFrame(kmh);

  } catch (err) {
    console.error('onPositionUpdate error', err);
  }
}

/* wrapper for navigator.watchPosition callback (throttled) */
const onPositionUpdateThrottled = throttle(onPositionUpdate, 300);

/* =========================
   Hook into browser geolocation
   ========================= */
function startPositionWatcher() {
  if (!navigator.geolocation) {
    pushPopup('Geolocation not available', 'error', 4000);
    return;
  }
  positionWatchId = navigator.geolocation.watchPosition(onPositionUpdateThrottled, (err) => {
    console.warn('geolocation error', err);
    pushPopup('GPS error: ' + (err.message || err.code), 'error', 3000);
  }, CONFIG.GEO_OPTIONS);
}

/* update the speed display widget (safe checks) */
function updateSpeedUI(kmh) {
  const el = D.speedDisplay;
  if (el) {
    // harmonize possible element shapes (container with value/unit or single value)
    if (el.tagName === 'DIV' || el.tagName === 'SPAN') {
      // check for nested value
      const valEl = document.getElementById('speed-value') || document.querySelector('#speed-display #speed-value');
      if (valEl) {
        valEl.textContent = kmh;
      } else {
        el.textContent = `${kmh} km/h`;
      }
    } else {
      el.textContent = `${kmh} km/h`;
    }
  }
}

/* update user marker location and rotation */
function updateUserMarker(lat, lon, heading) {
  if (!userMarker) return;
  userMarker.setLatLng([lat, lon]);
  // rotate arrow inside marker DOM
  const elMarker = userMarker.getElement();
  if (elMarker) {
    const arrow = elMarker.querySelector('.car-arrow');
    if (arrow) arrow.style.transform = `rotate(${heading || 0}deg)`;
  }
  // accuracy circle update if available
  if (accuracyCircle) accuracyCircle.setLatLng([lat, lon]);
}

/* =========================
   Admin panel: triple-tap to toggle
   - test alerts, reload data, clear alerts
   ========================= */
function setupAdminInteractions() {
  // triple tap on body to toggle admin panel
  document.body.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastAdminTapTime < 600) adminTapCounter++;
    else adminTapCounter = 1;
    lastAdminTapTime = now;
    if (adminTapCounter >= 3) {
      adminTapCounter = 0;
      const panel = D.adminPanel || document.getElementById('admin-panel');
      if (panel) panel.classList.toggle('collapsed');
      pushPopup('Admin toggled', 'info', 900);
    }
  });

  // wire default admin buttons if present
  if (D.reloadBtn) {
    D.reloadBtn.addEventListener('click', async () => {
      pushPopup('Reloading SCDB & zones...', 'info', 1200);
      await loadAllData();
      pushPopup('Reload complete', 'success', 1000);
    });
  }
  if (D.clearAlertsBtn) {
    D.clearAlertsBtn.addEventListener('click', () => {
      document.getElementById('alert-overlay')?.classList.add('hidden');
      pushPopup('Alerts cleared', 'success', 800);
    });
  }
}

/* reload scdb and avg zones */
async function loadAllData() {
  await loadSCDBFile();
  await loadAvgZones();
  // redraw avg zones and radar markers if lastPosition known
  if (map && avgZones && Array.isArray(avgZones) && map._avgLayer) {
    map._avgLayer.clearLayers();
    for (const z of avgZones) {
      try {
        const line = L.polyline([[z.start.lat, z.start.lon], [z.end.lat, z.end.lon]], { color: '#3388ff', weight: 4, opacity: 0.5 }).addTo(map._avgLayer);
        z._line = line;
      } catch (e) {}
    }
  }
  if (lastPosition) refreshRadarMarkers(lastPosition.lat, lastPosition.lon);
}

/* =========================
   Startup / Boot sequence
   ========================= */
async function boot() {
  try {
    // load data first (fast)
    await loadSCDBFile();
    await loadAvgZones();

    // init map
    initMap();

    // initialize PiP rendering loop and button
    initPiP();

    // setup admin interactions
    setupAdminInteractions();

    // enable no-sleep on first gesture
    initNoSleep();

    // begin geolocation tracking
    startPositionWatcher();

    // initial marker refresh
    if (lastPosition) refreshRadarMarkers(lastPosition.lat, lastPosition.lon);

    pushPopup('RadarNav initialized', 'success', 1200);
  } catch (err) {
    console.error('boot error', err);
    pushPopup('Initialization error: ' + err.message, 'error', 3500);
  }
}

/* start the app on load */
window.addEventListener('load', () => {
  boot();
});

/* =========================
   Canvas loop for PiP: ensure it's running even if PiP not active so the video updates quickly
   ========================= */
function startCanvasLoop() {
  // RAF handles continuous updates inside initPiP()
  // This function kept for backward compatibility
}

/* =========================
   Expose some debugging functions to window for manual testing
   (allows calling from console)
   ========================= */
window.RadarNav = {
  reloadData: loadAllData,
  getRadars: () => radars,
  getAvgZones: () => avgZones,
  refreshMarkers: () => lastPosition && refreshRadarMarkers(lastPosition.lat, lastPosition.lon)
};

/* =========================
   End of file
   ========================= */

/* =========================
   Minor CSS helper (if index.html not provided)
   You likely have style.css already; this is optional fallback.
   ========================= */
/* If you need a minimal style injection (uncomment to use):
(function injectMinimalStyles() {
  const css = `
    .popup { transition: opacity 0.3s; padding:8px 12px; border-radius:8px; background:rgba(0,0,0,0.75); color:#fff; margin-top:8px; }
    .popup.info { background:rgba(0,0,0,0.75); }
    .popup.error { background:rgba(200,40,40,0.9); }
    .user-icon .car-arrow { width: 0; height:0; border-left:12px solid transparent; border-right:12px solid transparent; border-bottom:18px solid #00bfff; transform: rotate(0deg);}
  `;
  const s = document.createElement('style'); s.innerHTML = css; document.head.appendChild(s);
})();
*/
