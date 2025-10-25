/**
 * app.js - Enhanced RadarNav
 * Added features:
 * - Dark/Light mode toggle with persistent storage
 * - Improved iOS PiP with better fallback
 * - Auto-center functionality with visual indicator
 * - Better center button behavior
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
  AUTO_CENTER_ZOOM: 16,       // Zoom level when auto-centering
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
  topBar: $('top-bar'),
  themeToggle: $('theme-toggle'),
  autoCenterBtn: $('toggle-auto-center')
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
let autoCenterEnabled = true; // Auto-center by default
let currentTheme = 'dark'; // 'dark' or 'light'
let lightMapLayer, darkMapLayer;

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

/* ========== THEME MANAGEMENT ========== */
function initTheme() {
  // Load saved theme or default to dark
  currentTheme = localStorage.getItem('radarnav-theme') || 'dark';
  applyTheme(currentTheme);
  
  // Setup theme toggle
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
    // Switch to light map tiles
    if (map && lightMapLayer) {
      if (map.hasLayer(darkMapLayer)) {
        map.removeLayer(darkMapLayer);
      }
      lightMapLayer.addTo(map);
    }
  } else {
    document.body.classList.remove('light-mode');
    // Switch to dark map tiles
    if (map && darkMapLayer) {
      if (map.hasLayer(lightMapLayer)) {
        map.removeLayer(lightMapLayer);
      }
      darkMapLayer.addTo(map);
    }
  }
}

function updateThemeButton() {
  if (DOM.themeToggle) {
    DOM.themeToggle.textContent = currentTheme === 'dark' ? '🌙' : '☀️';
    DOM.themeToggle.title = `Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode`;
  }
}

/* ========== MAP INIT WITH THEME SUPPORT ========== */
function initMap() {
  map = L.map(DOM.map, { zoomControl: true }).setView([39.0, 35.0], 12);
  
  // Create both light and dark map layers
  lightMapLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { 
    attribution: '&copy; OpenStreetMap & CARTO' 
  });
  
  darkMapLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
    attribution: '&copy; OpenStreetMap & CARTO' 
  });
  
  // Apply initial theme
  applyTheme(currentTheme);

  const userHtml = '<div class="user-icon"><div class="car-arrow" style="transform: rotate(0deg)"></div></div>';
  const userIcon = L.divIcon({ className:'user-icon-wrapper', html: userHtml, iconSize: [44,44], iconAnchor: [22,22] });
  userMarker = L.marker([39.0,35.0], { icon: userIcon, interactive: false }).addTo(map);
  accuracyCircle = L.circle([39.0,35.0], { radius: 0, color:'var(--accent-color)', opacity:0.15 }).addTo(map);

  // avg zones drawn
  map._avgLayer = L.layerGroup().addTo(map);
  for (const z of avgZones) {
    try {
      z._line = L.polyline([[z.start.lat, z.start.lon],[z.end.lat, z.end.lon]], { color:'#6ea8fe', weight:4, opacity:0.45 }).addTo(map._avgLayer);
    } catch(e){}
  }

  map._radarLayer = L.layerGroup().addTo(map);
  
  // Auto-center on location when map is moved manually
  map.on('dragstart', () => {
    if (autoCenterEnabled) {
      setAutoCenter(false);
    }
  });
}

/* ========== AUTO-CENTER FUNCTIONALITY ========== */
function setAutoCenter(enabled) {
  autoCenterEnabled = enabled;
  
  if (DOM.autoCenterBtn) {
    DOM.autoCenterBtn.textContent = `Auto-center: ${enabled ? 'On' : 'Off'}`;
  }
  
  if (DOM.centerBtn) {
    if (enabled) {
      DOM.centerBtn.classList.add('auto-center-active');
      DOM.centerBtn.title = "Auto-centering enabled";
      // Immediately center if we have a position
      if (lastPos) {
        map.setView([lastPos.lat, lastPos.lon], CONFIG.AUTO_CENTER_ZOOM, { animate: true });
      }
    } else {
      DOM.centerBtn.classList.remove('auto-center-active');
      DOM.centerBtn.title = "Center on location";
    }
  }
}

function updateUserMarker(lat, lon, heading, accuracy) {
  if (!userMarker) return;
  userMarker.setLatLng([lat, lon]);
  const el = userMarker.getElement();
  if (el) {
    const arrow = el.querySelector('.car-arrow');
    if (arrow) arrow.style.transform = `rotate(${heading ?? 0}deg)`;
    // Update arrow color based on theme
    arrow.style.borderBottomColor = 'var(--accent-color)';
  }
  if (accuracyCircle && typeof accuracy === 'number') {
    accuracyCircle.setRadius(accuracy).setLatLng([lat, lon]);
    accuracyCircle.setStyle({ color: 'var(--accent-color)' });
  }
  
  // Auto-center if enabled
  if (autoCenterEnabled && lastPos) {
    map.setView([lastPos.lat, lastPos.lon], map.getZoom(), { animate: false });
  }
}

/* ========== IMPROVED PiP FOR iOS ========== */
function initPiP() {
  // ensure canvas sized
  DOM.pipCanvas.width = CONFIG.PIP_W;
  DOM.pipCanvas.height = CONFIG.PIP_H;
  pipCtx = DOM.pipCanvas.getContext('2d');

  // wire toggle
  if (DOM.pipToggle) {
    DOM.pipToggle.addEventListener('click', async () => {
      if (pipFallbackEl) {
        // If fallback is already shown, remove it
        pipFallbackRemove();
        pipEnabled = false;
        DOM.pipToggle.textContent = 'Enable PiP';
      } else if ('pictureInPictureEnabled' in document && typeof DOM.pipVideo.requestPictureInPicture === 'function') {
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

/* Improved iOS PiP Fallback */
let pipFallbackEl = null;
function pipFallbackShow() {
  if (pipFallbackEl) return; // already visible
  
  pipFallbackEl = document.createElement('div');
  pipFallbackEl.id = 'pip-fallback';
  pipFallbackEl.innerHTML = `
    <button id="pip-fallback-close" title="Close PiP">×</button>
    <div id="pip-fallback-speed">0 km/h</div>
  `;
  document.body.appendChild(pipFallbackEl);
  
  // Add close functionality
  const closeBtn = $('#pip-fallback-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', pipFallbackRemove);
  }
  
  // Make draggable on desktop
  makeElementDraggable(pipFallbackEl);
  
  pipEnabled = true;
  if (DOM.pipToggle) {
    DOM.pipToggle.textContent = 'Disable PiP';
  }
}

function pipFallbackRemove() {
  if (pipFallbackEl) {
    pipFallbackEl.remove();
    pipFallbackEl = null;
  }
  pipEnabled = false;
  if (DOM.pipToggle) {
    DOM.pipToggle.textContent = 'Enable PiP';
  }
}

// Simple drag functionality for PiP fallback
function makeElementDraggable(el) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  
  el.onmousedown = dragMouseDown;
  el.ontouchstart = dragTouchStart;
  
  function dragMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }
  
  function dragTouchStart(e) {
    const touch = e.touches[0];
    pos3 = touch.clientX;
    pos4 = touch.clientY;
    document.ontouchend = closeDragElement;
    document.ontouchmove = elementDragTouch;
  }
  
  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    el.style.top = (el.offsetTop - pos2) + "px";
    el.style.left = (el.offsetLeft - pos1) + "px";
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  
  function elementDragTouch(e) {
    const touch = e.touches[0];
    pos1 = pos3 - touch.clientX;
    pos2 = pos4 - touch.clientY;
    pos3 = touch.clientX;
    pos4 = touch.clientY;
    el.style.top = (el.offsetTop - pos2) + "px";
    el.style.left = (el.offsetLeft - pos1) + "px";
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  
  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    document.ontouchend = null;
    document.ontouchmove = null;
  }
}

/* ========== ENHANCED CONTROLS ========== */
function initControls() {
  // center button - now toggles auto-center
  if (DOM.centerBtn) {
    DOM.centerBtn.addEventListener('click', () => {
      if (lastPos && map) {
        if (autoCenterEnabled) {
          // If already auto-centering, just do a one-time center
          map.setView([lastPos.lat, lastPos.lon], CONFIG.AUTO_CENTER_ZOOM, { animate: true });
        } else {
          // Enable auto-center
          setAutoCenter(true);
        }
      }
    });
  }

  // auto-center admin button
  if (DOM.autoCenterBtn) {
    DOM.autoCenterBtn.addEventListener('click', () => {
      setAutoCenter(!autoCenterEnabled);
      pushToast(`Auto-center ${autoCenterEnabled ? 'enabled' : 'disabled'}`, 'success');
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

// [Keep all other existing functions from your original app.js...]
// The rest of your existing functions (loadSCDB, loadAvgZones, refreshMarkers, 
// snapNearestORS, detectApproachingCameras, fireCameraAlert, findAvgZoneForPosition,
// avgStateEnter, avgStateExit, showCenteredAlert, renderPip, startTracking, etc.)
// remain exactly the same as in your original app.js

/* ========== BOOTSTRAP ========== */
async function boot() {
  try {
    initTheme(); // Initialize theme first
    await loadSCDB();
    await loadAvgZones();
    initMap();
    initPiP();
    initControls();
    startTracking();
    
    // Enable auto-center by default
    setAutoCenter(true);
    
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