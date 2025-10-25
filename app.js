/**
 * app.js - Fixed RadarNav
 * Fixed issues:
 * - Map loading properly
 * - GPS tracking working
 * - PiP functionality restored
 * - Center button working
 * - Theme switching without breaking functionality
 */

/* ========== CONFIG ========== */
const CONFIG = {
  ORS_API_KEY: '',
  CAMERA_VISIBLE_M: 10000,
  ALERT_DISTANCE_M: 1000,
  ALERT_THROTTLE_MS: 5000,
  GLOBAL_THROTTLE_MS: 2500,
  GEO_OPTIONS: { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 },
  PIP_FPS: 20,
  PIP_W: 360,
  PIP_H: 180,
  AHEAD_ANGLE: 65,
  MIN_MOVE_TO_REFRESH: 25,
  MAX_MARKERS: 1200,
  AUTO_CENTER_ZOOM: 16,
  DEBUG: true
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
  topBar: $('top-bar'),
  themeToggle: $('theme-toggle'),
  autoCenterBtn: $('toggle-auto-center')
};

/* ========== STATE ========== */
let map, userMarker, accuracyCircle;
let radars = [];
let avgZones = [];
let visibleMarkers = new Map();
let lastPos = null;
let lastMarkerRefreshPos = null;
let perCameraLastAlert = new Map();
let lastGlobalAlert = 0;
let lastSpeed = 0;
let pipStream = null;
let pipCtx = null;
let pipRAF = null;
let pipEnabled = false;
let noSleep = window.noSleep || null;
let adminTap = { count: 0, last: 0 };
let avgState = { active: null, samples: [], started: 0 };
let autoCenterEnabled = true;
let currentTheme = 'dark';

/* ========== AUDIO ASSETS ========== */
const AUDIO = {
  chime: tryCreateAudio('assets/chime.mp3'),
  beep: tryCreateAudio('assets/beep_beep.mp3'),
  cameraMsg: tryCreateAudio('assets/camera_ahead.mp3'),
  avgMsg: tryCreateAudio('assets/avg_zone_ahead.mp3')
};

function tryCreateAudio(path){
  try {
    const a = new Audio(path);
    a.preload = 'auto';
    return a;
  } catch(e) {
    console.warn('Audio not found:', path);
    return null;
  }
}

/* ========== THEME MANAGEMENT ========== */
function initTheme() {
  currentTheme = localStorage.getItem('radarnav-theme') || 'dark';
  applyTheme(currentTheme);
  
  if (DOM.themeToggle) {
    DOM.themeToggle.addEventListener('click', toggleTheme);
    updateThemeButton();
  }
}

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme);
  updateThemeButton();
  localStorage.setItem('radarnav-theme', currentTheme);
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.body.classList.add('light-mode');
  } else {
    document.body.classList.remove('light-mode');
  }
}

function updateThemeButton() {
  if (DOM.themeToggle) {
    DOM.themeToggle.textContent = currentTheme === 'dark' ? '🌙' : '☀️';
  }
}

/* ========== MAP INIT ========== */
function initMap() {
  console.log('Initializing map...');
  
  // Simple map initialization - no theme layers for now
  map = L.map(DOM.map, { zoomControl: true }).setView([39.0, 35.0], 12);
  
  // Use standard tile layer
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
    attribution: '&copy; OpenStreetMap & CARTO' 
  }).addTo(map);

  // User marker
  const userHtml = '<div class="user-icon"><div class="car-arrow" style="transform: rotate(0deg)"></div></div>';
  const userIcon = L.divIcon({ className:'user-icon-wrapper', html: userHtml, iconSize: [44,44], iconAnchor: [22,22] });
  userMarker = L.marker([39.0,35.0], { icon: userIcon, interactive: false }).addTo(map);
  accuracyCircle = L.circle([39.0,35.0], { radius: 0, color:'#00e5ff', opacity:0.15 }).addTo(map);

  // Layers for markers
  map._avgLayer = L.layerGroup().addTo(map);
  map._radarLayer = L.layerGroup().addTo(map);
  
  console.log('Map initialized successfully');
}

/* ========== AUTO-CENTER ========== */
function setAutoCenter(enabled) {
  autoCenterEnabled = enabled;
  
  if (DOM.autoCenterBtn) {
    DOM.autoCenterBtn.textContent = `Auto-center: ${enabled ? 'On' : 'Off'}`;
  }
  
  if (DOM.centerBtn) {
    if (enabled) {
      DOM.centerBtn.classList.add('auto-center-active');
      if (lastPos) {
        map.setView([lastPos.lat, lastPos.lon], CONFIG.AUTO_CENTER_ZOOM, { animate: true });
      }
    } else {
      DOM.centerBtn.classList.remove('auto-center-active');
    }
  }
}

/* ========== DATA LOADING ========== */
async function loadSCDB(path='SCDB_SpeedCams.json') {
  try {
    const res = await fetch(path);
    const text = await res.text();
    let parsed;
    
    try {
      parsed = JSON.parse(text);
    } catch(e) {
      const parts = text.replace(/\r\n/g,'\n').replace(/\}\s*\{/g,'}|{').split('|');
      parsed = [];
      for (const p of parts) {
        const s = p.trim();
        if (!s) continue;
        try { parsed.push(JSON.parse(s)); } catch(err) {
          const m = s.match(/\{[\s\S]*\}/);
          if (m) try { parsed.push(JSON.parse(m[0])); } catch(e2) {}
        }
      }
    }
    
    if (Array.isArray(parsed)) {
      radars = parsed;
    } else if (parsed && Array.isArray(parsed.cameras)) {
      radars = parsed.cameras;
    } else {
      radars = [];
    }
    
    radars = radars.map(it => {
      const lat = parseFloat(it.lat ?? it.latitude ?? it.LAT ?? it.Lat);
      const lon = parseFloat(it.lon ?? it.lng ?? it.longitude ?? it.LON ?? it.Long ?? it.Longitude);
      const flg = it.flg != null ? parseInt(it.flg) : (it.type != null ? parseInt(it.type) : 2);
      const unt = (it.unt ?? it.unit ?? it['unt '] ?? 'kmh').toString().trim();
      return { lat, lon, flg, unt, raw: it };
    }).filter(it => Number.isFinite(it.lat) && Number.isFinite(it.lon));
    
    console.log('SCDB loaded:', radars.length);
  } catch (err) {
    console.error('loadSCDB error:', err);
    pushToast('Failed to load camera data', 'error');
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
      return { 
        start: { lat: parseFloat(sLat), lon: parseFloat(sLon) }, 
        end: { lat: parseFloat(eLat), lon: parseFloat(eLon) }, 
        limit, 
        id: z.id ?? `zone_${i}` 
      };
    }).filter(z => Number.isFinite(z.start.lat) && Number.isFinite(z.end.lat));
    
    console.log('Avg zones loaded:', avgZones.length);
  } catch(err) {
    console.warn('Avg zones error:', err);
    avgZones = [];
  }
}

/* ========== MARKERS ========== */
function refreshMarkers(centerLat, centerLon) {
  const layer = map._radarLayer;
  if (!layer) return;

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
        const marker = L.circleMarker([r.lat, r.lon], { 
          radius: 8, 
          fillColor: color, 
          color:'#000', 
          weight:1, 
          fillOpacity:0.95 
        }).addTo(layer);
        marker.bindPopup(`${r.flg===1?'Average speed camera':'Fixed camera'}`);
        visibleMarkers.set(i, marker);
      }
    } else {
      if (visibleMarkers.has(i)) {
        const m = visibleMarkers.get(i);
        if (layer.hasLayer(m)) layer.removeLayer(m);
        visibleMarkers.delete(i);
      }
    }
  }
}

/* ========== UTILITIES ========== */
function log(...a){ if (CONFIG.DEBUG) console.log(...a); }
function now(){ return Date.now(); }
const toRad = v => v * Math.PI/180;
const toDeg = v => v * 180/Math.PI;
const clamp = (num, min, max) => Math.min(Math.max(num, min), max);

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
  let d = Math.abs(a - b) % 360; 
  if (d > 180) d = 360 - d; 
  return d;
}

/* ========== GPS TRACKING ========== */
function startTracking() {
  if (!navigator.geolocation) {
    pushToast('Geolocation not supported', 'error');
    return;
  }

  navigator.geolocation.watchPosition(
    position => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      const accuracy = position.coords.accuracy;
      const gpsSpeed = position.coords.speed;
      let heading = position.coords.heading;
      
      // Calculate speed
      const speedKmh = (gpsSpeed && !isNaN(gpsSpeed)) ? Math.round(gpsSpeed * 3.6) : lastSpeed;
      lastSpeed = speedKmh;
      
      // Calculate heading if not provided
      if (heading == null && lastPos) {
        heading = bearing(lastPos.lat, lastPos.lon, lat, lon);
      }
      
      lastPos = { lat, lon, heading, speedKmh, ts: now() };
      
      // Update UI
      updateSpeedDisplay(speedKmh);
      updateUserMarker(lat, lon, heading, accuracy);
      
      // Refresh markers if moved enough
      const needRefresh = !lastMarkerRefreshPos || 
                         haversine(lastMarkerRefreshPos.lat, lastMarkerRefreshPos.lon, lat, lon) >= CONFIG.MIN_MOVE_TO_REFRESH;
      if (needRefresh) {
        refreshMarkers(lat, lon);
        lastMarkerRefreshPos = { lat, lon };
      }
      
      // Check for cameras
      detectApproachingCameras(lat, lon, heading || 0);
      
      // Check for average zones
      checkAverageZones(lat, lon, speedKmh);
      
      // Update PiP
      renderPip(speedKmh);
      
    },
    error => {
      console.error('GPS error:', error);
      pushToast('GPS error: ' + error.message, 'error');
    },
    CONFIG.GEO_OPTIONS
  );
}

function updateSpeedDisplay(kmh) {
  if (DOM.speedValue) DOM.speedValue.textContent = kmh;
}

function updateUserMarker(lat, lon, heading, accuracy) {
  if (!userMarker) return;
  
  userMarker.setLatLng([lat, lon]);
  const el = userMarker.getElement();
  if (el) {
    const arrow = el.querySelector('.car-arrow');
    if (arrow) arrow.style.transform = `rotate(${heading || 0}deg)`;
  }
  
  if (accuracyCircle && accuracy) {
    accuracyCircle.setRadius(accuracy).setLatLng([lat, lon]);
  }
  
  // Auto-center if enabled
  if (autoCenterEnabled && lastPos) {
    map.setView([lastPos.lat, lastPos.lon], map.getZoom(), { animate: false });
  }
}

/* ========== CAMERA DETECTION ========== */
function detectApproachingCameras(lat, lon, heading) {
  const nowTs = now();
  if (nowTs - lastGlobalAlert < CONFIG.GLOBAL_THROTTLE_MS) return;
  
  for (let i = 0; i < radars.length; i++) {
    const r = radars[i];
    const dist = haversine(lat, lon, r.lat, r.lon);
    if (dist > CONFIG.ALERT_DISTANCE_M) continue;
    
    const brg = bearing(lat, lon, r.lat, r.lon);
    const diff = angleDiff(brg, heading);
    if (diff > CONFIG.AHEAD_ANGLE) continue;
    
    const key = `${r.lat},${r.lon}`;
    const lastAlert = perCameraLastAlert.get(key) || 0;
    if (now() - lastAlert < CONFIG.ALERT_THROTTLE_MS) continue;
    
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

  if (AUDIO.beep) {
    AUDIO.beep.play().catch(e => console.warn('Audio play failed:', e));
  }
}

/* ========== AVERAGE ZONES ========== */
function checkAverageZones(lat, lon, speedKmh) {
  const zone = findAvgZoneForPosition(lat, lon);
  
  if (zone) {
    if (!avgState.active || avgState.active.id !== zone.z.id) {
      avgStateEnter(zone.z);
    }
    avgStateUpdate(speedKmh, zone.pct);
  } else if (avgState.active) {
    avgStateExit();
  }
}

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
  DOM.avgZoneBar.classList.remove('hidden');
  DOM.zoneLimitVal.textContent = zone.limit + ' km/h';
}

function avgStateExit() {
  if (!avgState.active) return;
  
  const avg = avgState.samples.length ? 
    Math.round(avgState.samples.reduce((a,b) => a + b, 0) / avgState.samples.length) : 0;
  
  showCenteredAlert(`Average zone finished — avg ${avg} km/h (limit ${avgState.active.limit})`, 4200);
  
  avgState.active = null;
  avgState.samples = [];
  DOM.avgZoneBar.classList.add('hidden');
}

function avgStateUpdate(kmh, pct) {
  if (!avgState.active) return;
  
  avgState.samples.push(kmh);
  if (avgState.samples.length > 80) avgState.samples.shift();
  
  DOM.progressFill.style.width = `${Math.round(pct * 100)}%`;
  DOM.avgSpeedVal.textContent = `${Math.round(kmh)} km/h`;
}

/* ========== PiP FUNCTIONALITY ========== */
function initPiP() {
  DOM.pipCanvas.width = CONFIG.PIP_W;
  DOM.pipCanvas.height = CONFIG.PIP_H;
  pipCtx = DOM.pipCanvas.getContext('2d');

  if (DOM.pipToggle) {
    DOM.pipToggle.addEventListener('click', togglePiP);
  }

  function loop() { 
    renderPip(lastSpeed); 
    pipRAF = requestAnimationFrame(loop); 
  }
  
  if (!pipRAF) loop();
}

function togglePiP() {
  if (pipFallbackEl) {
    pipFallbackRemove();
  } else if (document.pictureInPictureEnabled) {
    // Standard PiP
    if (!pipStream) {
      pipStream = DOM.pipCanvas.captureStream(CONFIG.PIP_FPS);
      DOM.pipVideo.srcObject = pipStream;
    }
    
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else {
      DOM.pipVideo.requestPictureInPicture().catch(err => {
        console.warn('PiP failed, using fallback:', err);
        pipFallbackShow();
      });
    }
  } else {
    // Fallback for iOS and other browsers
    pipFallbackShow();
  }
}

let pipFallbackEl = null;
function pipFallbackShow() {
  if (pipFallbackEl) return;
  
  pipFallbackEl = document.createElement('div');
  pipFallbackEl.id = 'pip-fallback';
  pipFallbackEl.innerHTML = `
    <button id="pip-fallback-close">×</button>
    <div id="pip-fallback-speed">${lastSpeed} km/h</div>
  `;
  document.body.appendChild(pipFallbackEl);
  
  $('#pip-fallback-close').addEventListener('click', pipFallbackRemove);
  pipEnabled = true;
  DOM.pipToggle.textContent = 'Disable PiP';
}

function pipFallbackRemove() {
  if (pipFallbackEl) {
    pipFallbackEl.remove();
    pipFallbackEl = null;
  }
  pipEnabled = false;
  DOM.pipToggle.textContent = 'Enable PiP';
}

function renderPip(kmh) {
  if (!DOM.pipCanvas || !pipCtx) return;
  
  const ctx = pipCtx;
  const w = DOM.pipCanvas.width, h = DOM.pipCanvas.height;
  
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = currentTheme === 'light' ? '#f5f7fa' : '#071021';
  ctx.fillRect(0, 0, w, h);
  
  // Draw speed display
  ctx.fillStyle = currentTheme === 'light' ? '#007acc' : '#00e5ff';
  ctx.font = 'bold 28px Inter, Arial';
  ctx.textAlign = 'center';
  ctx.fillText(`${kmh} km/h`, w/2, h/2 + 10);
  
  // Update fallback if active
  if (pipFallbackEl) {
    const speedEl = $('#pip-fallback-speed');
    if (speedEl) speedEl.textContent = `${kmh} km/h`;
  }
}

/* ========== UI CONTROLS ========== */
function initControls() {
  // Center button
  if (DOM.centerBtn) {
    DOM.centerBtn.addEventListener('click', () => {
      if (lastPos) {
        map.setView([lastPos.lat, lastPos.lon], CONFIG.AUTO_CENTER_ZOOM, { animate: true });
        setAutoCenter(true);
      }
    });
  }

  // Auto-center toggle
  if (DOM.autoCenterBtn) {
    DOM.autoCenterBtn.addEventListener('click', () => {
      setAutoCenter(!autoCenterEnabled);
    });
  }

  // Admin triple-tap
  document.body.addEventListener('touchend', (e) => {
    const t = now();
    if (t - adminTap.last < 600) adminTap.count++; 
    else adminTap.count = 1;
    
    adminTap.last = t;
    if (adminTap.count >= 3) {
      adminTap.count = 0;
      DOM.adminPanel.classList.toggle('collapsed');
      pushToast('Admin panel toggled');
    }
  });

  // Admin buttons
  if (DOM.reloadBtn) {
    DOM.reloadBtn.addEventListener('click', async () => {
      await loadSCDB();
      await loadAvgZones();
      if (lastPos) refreshMarkers(lastPos.lat, lastPos.lon);
      pushToast('Data reloaded', 'success');
    });
  }

  if (DOM.clearAlertsBtn) {
    DOM.clearAlertsBtn.addEventListener('click', () => {
      DOM.alertOverlay.classList.add('hidden');
      pushToast('Alerts cleared', 'success');
    });
  }
}

/* ========== UI HELPERS ========== */
function showCenteredAlert(text, duration = 3500) {
  if (DOM.alertText && DOM.alertOverlay) {
    DOM.alertText.textContent = text;
    DOM.alertOverlay.classList.remove('hidden');
    DOM.alertOverlay.style.opacity = '1';
    
    setTimeout(() => {
      DOM.alertOverlay.style.opacity = '0';
      setTimeout(() => {
        DOM.alertOverlay.classList.add('hidden');
      }, 300);
    }, duration);
  }
}

function pushToast(msg, type = 'info', ttl = 2500) {
  if (!DOM.popupContainer) return;
  
  const el = document.createElement('div');
  el.className = `popup ${type}`;
  el.textContent = msg;
  DOM.popupContainer.appendChild(el);
  
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, ttl);
}

/* ========== INITIALIZATION ========== */
async function boot() {
  try {
    console.log('Starting RadarNav...');
    
    initTheme();
    await loadSCDB();
    await loadAvgZones();
    initMap();
    initPiP();
    initControls();
    startTracking();
    
    // Enable auto-center by default
    setAutoCenter(true);
    
    // NoSleep
    if (noSleep) {
      document.addEventListener('touchstart', () => {
        noSleep.enable();
      }, { once: true });
    }
    
    pushToast('RadarNav ready!', 'success', 2000);
    console.log('RadarNav started successfully');
    
  } catch (err) {
    console.error('Boot error:', err);
    pushToast('Startup failed: ' + err.message, 'error', 5000);
  }
}

// Start the app
window.addEventListener('load', boot);