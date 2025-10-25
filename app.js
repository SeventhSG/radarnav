/**
 * app.js - Final RadarNav
 * - Leaflet map showing SCDB cameras within 10km
 * - Alerts 1km ahead (bearing-aware)
 * - Average speed zones with progress
 * - PiP (capture canvas) with iOS fallback overlay
 * - NoSleep support (NoSleep.js included in index.html)
 * - Beep-beep alert + voice MP3s
 * - Duck other same-page media during alerts (can't control system audio)
 * - Center button + admin triple-tap
 *
 * Place SCDB_SpeedCams.json, avg_zones.json, and assets/*.mp3 in same folder.
 * Set CONFIG.ORS_API_KEY to use OpenRouteService snapping (optional).
 */

/* ========== CONFIG ========== */
const CONFIG = {
  ORS_API_KEY: '', // set your OpenRouteService key to enable road snapping (optional)
  CAMERA_VISIBLE_M: 10000,    // 10 km marker visibility radius
  ALERT_DISTANCE_M: 1000,     // 1 km approach to alert
  ALERT_THROTTLE_MS: 5000,    // per-camera throttle
  GLOBAL_THROTTLE_MS: 2500,   // global throttle
  GEO_OPTIONS: { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 },
  PIP_FPS: 20,
  PIP_W: 360,
  PIP_H: 180,
  AHEAD_ANGLE: 65,            // degrees +/- allowed to be "ahead"
  MIN_MOVE_TO_REFRESH: 25,    // meters to refresh markers
  MAX_MARKERS: 1200,
  DEBUG: false
};

/* ========== ELEMENTS ========== */
const $ = id => document.getElementById(id);
const DOM = {
  map: $('map'),
  speedValue: $('speed-value'),
  speedUnit: $('speed-unit'),
  alertOverlay: $('alert-overlay'),
  alertText: $('alert-text'),
  avgZoneBar: $('avgZoneBar'),
  progressFill: $('progressFill'),
  zoneLimitVal: $('zoneLimitVal'),
  avgSpeedVal: $('avgSpeedVal'),
  pipCanvas: $('pipCanvas'),
  pipVideo: $('pipVideo'),
  pipToggle: $('toggle-pip'),
  centerBtn: $('center-btn'),
  adminPanel: $('admin-panel'),
  reloadBtn: $('reload-btn'),
  clearAlertsBtn: $('clear-alerts'),
  popupContainer: $('popup-container'),
  topBar: $('top-bar')
};

/* Ensure required elements exist */
if (!DOM.map) { throw new Error('index.html must include <div id="map"></div>'); }

/* ========== STATE ========== */
let map, userMarker, accuracyCircle;
let radars = [];
let avgZones = [];
let visibleMarkers = new Map(); // key = index -> Leaflet marker
let lastPos = null;             // {lat, lon, heading, speedKmh, ts}
let lastMarkerRefreshPos = null;
let perCameraLastAlert = new Map();
let lastGlobalAlert = 0;
let lastSpeed = 0;
let pipStream = null;
let pipCtx = null;
let pipRAF = null;
let pipEnabled = false;
let noSleep = (window.NoSleep) ? new NoSleep() : null;
let adminTap = { count: 0, last: 0 };
let avgState = { active: null, samples: [], started: 0 };

/* ========== AUDIO ASSETS ========== */
const AUDIO = {
  chime: tryCreateAudio('assets/chime.mp3'),
  beep: tryCreateAudio('assets/beep_beep.mp3'),
  cameraMsg: tryCreateAudio('assets/camera_ahead.mp3'),
  avgMsg: tryCreateAudio('assets/avg_zone_ahead.mp3')
};

// Helper: try to create audio but don't crash if missing
function tryCreateAudio(path){
  try {
    const a = new Audio(path);
    a.preload = 'auto';
    return a;
  } catch(e) {
    return null;
  }
}

/* Ducking: lower same-page media elements (audio/video) during alerts */
const duckState = { targets: [], originalVolumes: new Map(), isDucked: false };

function findSamePageMedia() {
  const audios = Array.from(document.querySelectorAll('audio, video'));
  // exclude our own alert/beep audio elements (those in AUDIO)
  const exclude = new Set(Object.values(AUDIO).filter(Boolean).map(x => x.src));
  return audios.filter(a => a && !exclude.has(a.currentSrc));
}

function duckOtherMedia() {
  if (duckState.isDucked) return;
  const targets = findSamePageMedia();
  duckState.targets = targets;
  duckState.originalVolumes.clear();
  targets.forEach(t => {
    try {
      duckState.originalVolumes.set(t, t.volume ?? 1);
      // reduce volume by 60% (or to 0.2) for clarity
      t.volume = Math.max(0.05, (t.volume ?? 1) * 0.25);
      // optionally pause if you want: t.pause();
    } catch(e) {}
  });
  duckState.isDucked = true;
}

function restoreOtherMedia() {
  if (!duckState.isDucked) return;
  duckState.targets.forEach(t => {
    try {
      const orig = duckState.originalVolumes.get(t);
      if (orig != null) t.volume = orig;
    } catch(e) {}
  });
  duckState.targets = [];
  duckState.originalVolumes.clear();
  duckState.isDucked = false;
}

/* play alert audio with ducking + volume boost */
async function playAlertWithDuck(audioEl, volumeBoost = 1.5) {
  try {
    if (!audioEl) return;
    duckOtherMedia();
    // store original
    const orig = audioEl.volume ?? 1;
    // boost (cap at 1)
    audioEl.volume = Math.min(1, orig * volumeBoost);
    // ensure playing
    await audioEl.play().catch(() => {});
    // when ends, restore media and audio volume
    const endedHandler = () => {
      try {
        audioEl.volume = orig;
      } catch(e) {}
      restoreOtherMedia();
      audioEl.removeEventListener('ended', endedHandler);
      audioEl.removeEventListener('pause', endedHandler);
    };
    audioEl.addEventListener('ended', endedHandler);
    audioEl.addEventListener('pause', endedHandler);
  } catch(e) {
    console.warn('playAlert error', e);
  }
}

/* ========== UTILITIES ========== */
function log(...a){ if (CONFIG.DEBUG) console.log(...a); }
function now(){ return Date.now(); }
const toRad = v => v * Math.PI/180;
const toDeg = v => v * 180/Math.PI;

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinDLat = Math.sin(dLat/2);
  const sinDLon = Math.sin(dLon/2);
  const aa = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R * c;
}

function bearing(aLat,aLon,bLat,bLon){
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  return (toDeg(Math.atan2(y,x)) + 360) % 360;
}

function angleDiff(a,b){
  let d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d;
}

/* ========== DATA LOADING ========== */
async function loadSCDB(path='SCDB_SpeedCams.json') {
  try {
    const res = await fetch(path);
    const text = await res.text();
    // try direct parse
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        radars = parsed;
      } else if (parsed && Array.isArray(parsed.cameras)) {
        radars = parsed.cameras;
      } else {
        radars = [];
      }
    } catch(e) {
      // fallback: split by '}{' or newlines
      const parts = text.replace(/\r\n/g,'\n').replace(/\}\s*\{/g,'}|{').split('|');
      const arr = [];
      for (const p of parts) {
        const s = p.trim();
        if (!s) continue;
        try { arr.push(JSON.parse(s)); } catch(err) {
          const m = s.match(/\{[\s\S]*\}/);
          if (m) {
            try { arr.push(JSON.parse(m[0])); } catch(e2) {}
          }
        }
      }
      radars = arr;
    }
    // normalize
    radars = radars.map(it => {
      const lat = parseFloat(it.lat ?? it.latitude ?? it.LAT ?? it.Lat);
      const lon = parseFloat(it.lon ?? it.lng ?? it.longitude ?? it.LON ?? it.Long ?? it.Longitude);
      const flg = it.flg != null ? parseInt(it.flg) : (it.type != null ? parseInt(it.type) : 2);
      const unt = (it.unt ?? it.unit ?? it['unt '] ?? 'kmh').toString().trim();
      return { lat, lon, flg, unt, raw: it };
    }).filter(it => Number.isFinite(it.lat) && Number.isFinite(it.lon));
    log('SCDB loaded', radars.length);
  } catch (err) {
    console.error('loadSCDB error', err);
    pushToast('Failed to load SCDB_SpeedCams.json', 'error');
    radars = [];
  }
}

async function loadAvgZones(path='avg_zones.json') {
  try {
    const res = await fetch(path);
    const j = await res.json();
    let arr = [];
    if (Array.isArray(j)) arr = j;
    else if (j && Array.isArray(j.zones)) arr = j.zones;
    avgZones = arr.map((z, i) => {
      const sLat = z.start?.lat ?? z.start?.latitude ?? z.start?.LAT;
      const sLon = z.start?.lon ?? z.start?.lng ?? z.start?.longitude ?? z.start?.LON;
      const eLat = z.end?.lat ?? z.end?.latitude ?? z.end?.LAT;
      const eLon = z.end?.lon ?? z.end?.lng ?? z.end?.longitude ?? z.end?.LON;
      const limit = z.limit ?? z.speed ?? 50;
      return { start: { lat: parseFloat(sLat), lon: parseFloat(sLon) }, end: { lat: parseFloat(eLat), lon: parseFloat(eLon) }, limit, id: z.id ?? `zone_${i}` };
    }).filter(z => Number.isFinite(z.start.lat) && Number.isFinite(z.end.lat));
    log('avgZones loaded', avgZones.length);
  } catch(err) {
    console.warn('avg_zones error', err);
    avgZones = [];
  }
}

/* ========== MAP INIT ========== */
function initMap() {
  map = L.map(DOM.map, { zoomControl: true }).setView([39.0, 35.0], 12);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap & CARTO' }).addTo(map);

  const userHtml = '<div class="user-icon"><div class="car-arrow" style="transform: rotate(0deg)"></div></div>';
  const userIcon = L.divIcon({ className:'user-icon-wrapper', html: userHtml, iconSize: [44,44], iconAnchor: [22,22] });
  userMarker = L.marker([39.0,35.0], { icon: userIcon, interactive: false }).addTo(map);
  accuracyCircle = L.circle([39.0,35.0], { radius: 0, color:'#00e5ff', opacity:0.15 }).addTo(map);

  // avg zones drawn
  map._avgLayer = L.layerGroup().addTo(map);
  for (const z of avgZones) {
    try {
      z._line = L.polyline([[z.start.lat, z.start.lon],[z.end.lat, z.end.lon]], { color:'#6ea8fe', weight:4, opacity:0.45 }).addTo(map._avgLayer);
    } catch(e){}
  }

  map._radarLayer = L.layerGroup().addTo(map);
}

/* ========== MARKERS ========== */
function refreshMarkers(centerLat, centerLon) {
  const layer = map._radarLayer;
  if (!layer) return;

  // safety cap
  let count = 0;
  for (let i = 0; i < radars.length; i++) {
    if (count >= CONFIG.MAX_MARKERS) break;
    const r = radars[i];
    if (!r) continue;
    const d = haversine(centerLat, centerLon, r.lat, r.lon);
    if (d <= CONFIG.CAMERA_VISIBLE_M) {
      count++;
      if (!visibleMarkers.has(i)) {
        const color = r.flg === 1 ? '#00c853' : '#ffb300';
        const marker = L.circleMarker([r.lat, r.lon], { radius: 8, fillColor: color, color:'#000', weight:1, fillOpacity:0.95 }).addTo(layer);
        marker.bindPopup(`${r.flg===1?'Average speed camera':'Fixed camera'}`);
        visibleMarkers.set(i, marker);
      } else {
        const m = visibleMarkers.get(i);
        if (!layer.hasLayer(m)) layer.addLayer(m);
      }
    } else {
      if (visibleMarkers.has(i)) {
        const m = visibleMarkers.get(i);
        if (layer.hasLayer(m)) layer.removeLayer(m);
      }
    }
  }
}

/* ========== ROAD SNAP (ORS nearest) ========== */
async function snapNearestORS(lat, lon) {
  if (!CONFIG.ORS_API_KEY) return { lat, lon, snapped:false };
  try {
    const url = `https://api.openrouteservice.org/v2/nearest/driving-car?api_key=${encodeURIComponent(CONFIG.ORS_API_KEY)}&geometry_format=geojson&coords=${lon},${lat}`;
    const res = await fetch(url);
    if (!res.ok) return { lat, lon, snapped:false };
    const json = await res.json();
    if (json && json.features && json.features[0] && json.features[0].geometry && json.features[0].geometry.coordinates) {
      const c = json.features[0].geometry.coordinates;
      return { lat: c[1], lon: c[0], snapped: true };
    }
    return { lat, lon, snapped:false };
  } catch(e) {
    log('ORS error', e);
    return { lat, lon, snapped:false };
  }
}

/* ========== ALERT DETECTION ========== */
function detectApproachingCameras(lat, lon, heading) {
  const nowTs = now();
  if (nowTs - lastGlobalAlert < CONFIG.GLOBAL_THROTTLE_MS) {
    // still allow detection but avoid spamming
  }
  for (let i=0; i<radars.length; i++) {
    const r = radars[i];
    if (!r) continue;
    const dist = haversine(lat, lon, r.lat, r.lon);
    if (dist > CONFIG.ALERT_DISTANCE_M) continue;

    // bearing check
    const brg = bearing(lat, lon, r.lat, r.lon);
    const diff = angleDiff(brg, heading ?? brg);
    if (diff > CONFIG.AHEAD_ANGLE) continue;

    // throttle per camera
    const key = `${r.lat},${r.lon}`;
    const last = perCameraLastAlert.get(key) || 0;
    if (now() - last < CONFIG.ALERT_THROTTLE_MS) continue;

    perCameraLastAlert.set(key, now());
    lastGlobalAlert = now();
    fireCameraAlert(r, Math.round(dist));
    break;
  }
}

function fireCameraAlert(camera, distM) {
  const label = camera.flg === 1 ? 'Average speed zone' : 'Speed camera';
  const message = `${label} ahead — ${distM} m`;
  showCenteredAlert(message);

  // play beep-beep then optional voice
  (async () => {
    if (AUDIO.beep) await playAlertWithDuck(AUDIO.beep, 1.5);
    // short delay then play voice if available
    if (camera.flg === 1 && AUDIO.avgMsg) {
      setTimeout(()=>playAlertWithDuck(AUDIO.avgMsg, 1.2), 300);
    } else if (AUDIO.cameraMsg) {
      setTimeout(()=>playAlertWithDuck(AUDIO.cameraMsg, 1.2), 300);
    }
  })();
}

/* ========== AVG ZONE HANDLING ========== */
function findAvgZoneForPosition(lat, lon) {
  for (const z of avgZones) {
    const total = haversine(z.start.lat, z.start.lon, z.end.lat, z.end.lon);
    const dStart = haversine(z.start.lat, z.start.lon, lat, lon);
    const dEnd = haversine(z.end.lat, z.end.lon, lat, lon);
    const gap = Math.abs((dStart + dEnd) - total);
    if (gap < 60 && dStart <= total + 30) {
      const pct = clamp(dStart / total, 0, 1);
      return { z, pct, total, dStart };
    }
  }
  return null;
}

function avgStateEnter(zone) {
  avgState.active = zone;
  avgState.samples = [];
  avgState.started = now();
  if (DOM.avgZoneBar) DOM.avgZoneBar.classList.remove('hidden');
  if (DOM.zoneLimitVal) DOM.zoneLimitVal.textContent = zone.limit || '';
}

function avgStateExit() {
  if (!avgState.active) return;
  const samples = avgState.samples;
  const avg = samples.length ? Math.round(samples.reduce((a,b)=>a+b,0)/samples.length) : 0;
  showCenteredAlert(`Average zone finished — avg ${avg} km/h (limit ${avgState.active.limit})`, 4200);
  avgState.active = null; avgState.samples = [];
  if (DOM.avgZoneBar) DOM.avgZoneBar.classList.add('hidden');
}

function avgStateUpdate(kmh, pct) {
  if (!avgState.active) return;
  avgState.samples.push(kmh);
  if (avgState.samples.length > 80) avgState.samples.shift();
  if (DOM.progressFill) DOM.progressFill.style.width = `${Math.round(pct*100)}%`;
  if (DOM.avgSpeedVal) DOM.avgSpeedVal.textContent = `${Math.round(kmh)}`;
}

/* ========== UI helpers ========== */
function showCenteredAlert(text, duration=3500) {
  if (DOM.alertText && DOM.alertOverlay) {
    DOM.alertText.textContent = text;
    DOM.alertOverlay.classList.remove('hidden');
    DOM.alertOverlay.style.opacity = '1';
    setTimeout(()=> {
      DOM.alertOverlay.style.opacity = '0';
      DOM.alertOverlay.classList.add('hidden');
    }, duration);
  } else pushToast(text, 'info');
}

function pushToast(msg='ok', type='info', ttl=2500) {
  if (!DOM.popupContainer) return;
  const el = document.createElement('div');
  el.className = `popup ${type}`;
  el.textContent = msg;
  DOM.popupContainer.appendChild(el);
  setTimeout(()=> { el.style.opacity='0'; setTimeout(()=>el.remove(), 300); }, ttl);
}

/* ========== PiP (with iOS fallback overlay) ========== */
function initPiP() {
  // ensure canvas sized
  DOM.pipCanvas.width = CONFIG.PIP_W;
  DOM.pipCanvas.height = CONFIG.PIP_H;
  pipCtx = DOM.pipCanvas.getContext('2d');

  // wire toggle
  if (DOM.pipToggle) {
    DOM.pipToggle.addEventListener('click', async () => {
      // If PiP supported and allowed, try it. If it fails (iOS limitations), show fallback overlay element
      if ('pictureInPictureEnabled' in document && typeof DOM.pipVideo.requestPictureInPicture === 'function') {
        try {
          if (!pipStream) {
            pipStream = DOM.pipCanvas.captureStream(CONFIG.PIP_FPS);
            DOM.pipVideo.srcObject = pipStream;
            await DOM.pipVideo.play().catch(()=>{});
          }
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            pipEnabled = false;
            DOM.pipToggle.textContent = 'Enable PiP';
          } else {
            await DOM.pipVideo.requestPictureInPicture();
            pipEnabled = true;
            DOM.pipToggle.textContent = 'Disable PiP';
          }
        } catch (err) {
          // iOS Safari / iOS26 may throw; fallback to in-page overlay
          console.warn('PiP failed:', err);
          pipFallbackShow();
        }
      } else {
        // no PiP API; show fallback in-page overlay
        pipFallbackShow();
      }
    });
  }

  // keep canvas updated with RAF
  function loop(){ renderPip(lastSpeed); pipRAF = requestAnimationFrame(loop); }
  if (!pipRAF) loop();
}

/* Fallback: simple in-page overlay that mimics PiP look */
let pipFallbackEl = null;
function pipFallbackShow() {
  if (pipFallbackEl) return; // already visible
  pipFallbackEl = document.createElement('div');
  pipFallbackEl.style.position = 'fixed';
  pipFallbackEl.style.right = '10px';
  pipFallbackEl.style.bottom = '140px';
  pipFallbackEl.style.width = '220px';
  pipFallbackEl.style.height = '120px';
  pipFallbackEl.style.background = 'rgba(10,18,28,0.95)';
  pipFallbackEl.style.border = '1px solid rgba(255,255,255,0.06)';
  pipFallbackEl.style.borderRadius = '12px';
  pipFallbackEl.style.zIndex = '2000';
  pipFallbackEl.style.padding = '8px';
  pipFallbackEl.style.boxShadow = '0 12px 28px rgba(0,0,0,0.6)';
  pipFallbackEl.id = 'pip-fallback';
  pipFallbackEl.innerHTML = `<div id="pip-fallback-speed" style="font-size:26px;color:#00e5ff;text-align:center;margin-top:18px">0 km/h</div>`;
  document.body.appendChild(pipFallbackEl);
  // hide after 20s if not dismissed (unless PiP got enabled)
  setTimeout(()=> { if (pipFallbackEl && !pipEnabled){ pipFallbackEl.remove(); pipFallbackEl = null; } }, 20000);
}

/* render to canvas for PiP (or fallback) */
function renderPip(kmh) {
  const c = DOM.pipCanvas;
  if (!c || !pipCtx) return;
  const ctx = pipCtx;
  const w = c.width, h = c.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#071021';
  ctx.fillRect(0,0,w,h);

  // if alert overlay visible, draw alert style
  const alertVisible = DOM.alertOverlay && !DOM.alertOverlay.classList.contains('hidden') && DOM.alertOverlay.style.opacity !== '0';
  if (alertVisible) {
    roundRect(ctx, 10, 10, w-20, h-20, 12, '#122033');
    ctx.font = '20px Inter, Arial';
    ctx.fillStyle = '#ffd7d7';
    ctx.fillText('🚨', 26, 46);
    ctx.font = '14px Inter, Arial';
    ctx.fillStyle = '#fff';
    const txt = DOM.alertText ? DOM.alertText.textContent : 'Alert';
    wrapText(ctx, txt, 70, 40, w-90, 18);
  } else {
    roundRect(ctx, 18, 36, w-36, h-72, 12, '#0b2a33');
    ctx.font = '28px Inter, Arial';
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${kmh} km/h`, 34, 96);
  }

  // update fallback overlay if present
  if (pipFallbackEl) {
    const el = document.getElementById('pip-fallback-speed');
    if (el) el.textContent = `${kmh} km/h`;
  }
}

/* helpers: canvas rounded rect & wrap */
function roundRect(ctx,x,y,w,h,r,fill){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
function wrapText(ctx,text,x,y,maxW,lineH){
  const words = text.split(' ');
  let line = '';
  for (let n=0;n<words.length;n++){
    const test = line + words[n] + ' ';
    const metrics = ctx.measureText(test);
    if (metrics.width > maxW && n>0){
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineH;
    } else line = test;
  }
  ctx.fillText(line, x, y);
}

/* ========== GPS & Main Loop ========== */
function startTracking() {
  if (!navigator.geolocation) {
    pushToast('Geolocation unsupported', 'error');
    return;
  }

  // Use watchPosition
  navigator.geolocation.watchPosition(async pos => {
    try {
      let lat = pos.coords.latitude, lon = pos.coords.longitude;
      const acc = pos.coords.accuracy;
      const gpsSpeed = pos.coords.speed; // m/s or null
      let heading = pos.coords.heading;
      const speedKmh = (typeof gpsSpeed === 'number' && !isNaN(gpsSpeed)) ? Math.round(gpsSpeed * 3.6) : lastSpeed;
      lastSpeed = speedKmh;

      // optionally snap to road if ORS key present and moved enough
      const moved = !lastPos ? Infinity : haversine(lastPos.lat, lastPos.lon, lat, lon);
      if (CONFIG.ORS_API_KEY && (moved > 8 || !lastPos)) {
        const s = await snapNearestORS(lat, lon).catch(()=>({lat,lon,snapped:false}));
        if (s && s.snapped) { lat = s.lat; lon = s.lon; }
      }

      // compute heading fallback if GPS heading not present
      if (heading == null && lastPos) {
        heading = bearing(lastPos.lat, lastPos.lon, lat, lon);
      }

      // update lastPos
      lastPos = { lat, lon, heading, speedKmh, ts: now() };

      // update UI & marker
      updateSpeedDisplay(speedKmh);
      updateUserMarker(lat, lon, heading, acc);

      // markers refresh when moved enough
      const lastRef = lastMarkerRefreshPos;
      const needRefresh = !lastRef || haversine(lastRef.lat, lastRef.lon, lat, lon) >= CONFIG.MIN_MOVE_TO_REFRESH;
      if (needRefresh) {
        refreshMarkers(lat, lon);
        lastMarkerRefreshPos = { lat, lon };
      }

      // detect cameras ahead
      detectApproachingCameras(lat, lon, heading ?? 0);

      // detect avg zone
      const found = findAvgZoneForPosition(lat, lon);
      if (found) {
        if (!avgState.active || avgState.active.id !== found.z.id) avgStateEnter(found.z);
        avgStateUpdate(speedKmh, found.pct);
      } else {
        if (avgState.active) avgStateExit();
      }

      // update pip canvas (whether or not PiP active)
      renderPip(speedKmh);

    } catch (err) {
      console.error('GPS watch error', err);
    }
  }, err => {
    console.warn('geolocation error', err);
    pushToast('GPS error: ' + (err.message || err.code), 'error');
  }, CONFIG.GEO_OPTIONS);
}

/* wrappers for avg state update/exit reused above */
function avgStateUpdate(kmh, pct) {
  avgState.samples.push(kmh);
  if (avgState.samples.length > 80) avgState.samples.shift();
  if (DOM.progressFill) DOM.progressFill.style.width = `${Math.round(pct*100)}%`;
  if (DOM.avgSpeedVal) DOM.avgSpeedVal.textContent = `${Math.round(kmh)}`;
}
function avgStateExit() { avgStateExit_impl(); }
function avgStateExit_impl() {
  if (!avgState.active) return;
  const avg = avgState.samples.length ? Math.round(avgState.samples.reduce((a,b)=>a+b,0)/avgState.samples.length) : 0;
  showCenteredAlert(`Average zone finished — avg ${avg} km/h (limit ${avgState.active.limit})`, 4200);
  avgState.active = null; avgState.samples = []; avgState.started = 0;
  if (DOM.avgZoneBar) DOM.avgZoneBar.classList.add('hidden');
}

/* ========== UI helpers ========== */
function updateSpeedDisplay(kmh) {
  if (DOM.speedValue) DOM.speedValue.textContent = `${kmh}`;
}
function updateUserMarker(lat, lon, heading, accuracy) {
  if (!userMarker) return;
  userMarker.setLatLng([lat, lon]);
  const el = userMarker.getElement();
  if (el) {
    const arrow = el.querySelector('.car-arrow');
    if (arrow) arrow.style.transform = `rotate(${heading ?? 0}deg)`;
  }
  if (accuracyCircle && typeof accuracy === 'number') accuracyCircle.setRadius(accuracy).setLatLng([lat, lon]);
}

/* ========== ADMIN & CONTROLS ========== */
function initControls() {
  // center button
  if (DOM.centerBtn) {
    DOM.centerBtn.addEventListener('click', () => {
      if (lastPos && map) {
        map.setView([lastPos.lat, lastPos.lon], map.getZoom(), { animate: true });
      }
    });
  }

  // admin triple-tap
  document.body.addEventListener('touchend', (e) => {
    const t = now();
    if (t - adminTap.last < 600) adminTap.count++; else adminTap.count = 1;
    adminTap.last = t;
    if (adminTap.count >= 3) {
      adminTap.count = 0;
      const panel = DOM.adminPanel || document.getElementById('admin-panel');
      if (panel) panel.classList.toggle('collapsed');
      pushToast('Admin toggled');
    }
  });

  if (DOM.reloadBtn) {
    DOM.reloadBtn.addEventListener('click', async ()=> {
      pushToast('Reloading data...', 'info');
      await loadSCDB(); await loadAvgZones();
      if (lastPos) refreshMarkers(lastPos.lat, lastPos.lon);
      pushToast('Reloaded', 'success');
    });
  }
  if (DOM.clearAlertsBtn) {
    DOM.clearAlertsBtn.addEventListener('click', ()=> {
      if (DOM.alertOverlay) DOM.alertOverlay.classList.add('hidden');
      pushToast('Alerts cleared', 'success');
    });
  }
}

/* push small toast */
function pushToast(msg, type='info', ttl=2500) {
  if (!DOM.popupContainer) return;
  const el = document.createElement('div');
  el.className = `popup ${type}`;
  el.textContent = msg;
  DOM.popupContainer.appendChild(el);
  setTimeout(()=> { el.style.opacity='0'; setTimeout(()=>el.remove(),400); }, ttl);
}

/* ========== BOOTSTRAP ========== */
async function boot() {
  try {
    await loadSCDB();
    await loadAvgZones();
    initMap();
    initPiP();
    initControls();
    startTracking();
    // enable NoSleep after first user gesture (handled by included NoSleep.js)
    if (window.NoSleep) {
      const ns = new NoSleep();
      const enableOnce = ()=>{ try{ ns.enable(); }catch(e){}; document.removeEventListener('touchstart', enableOnce); };
      document.addEventListener('touchstart', enableOnce, { once: true });
    }
    pushToast('RadarNav ready', 'success', 1200);
  } catch(err) {
    console.error('boot error', err);
    pushToast('Initialization error', 'error', 4000);
  }
}

/* start on load */
window.addEventListener('load', boot);