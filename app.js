/**
 * app.js - RadarNav with Admin Button in Top Bar
 * Changes:
 * - Removed 5-tap admin panel completely
 * - Fixed admin button functionality
 * - Simplified admin panel toggle
 */

/* ========== CONFIG ========== */
const CONFIG = {
  ORS_API_KEY: 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImE0YzczYmZlMzA5NzRkOTc4OWI4OGU3YTcyNzY4MjdjIiwiaCI6Im11cm11cjY0In0=',
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
  REPORT_VISIBLE_M: 10000,
  REPORT_ALERT_DISTANCE: 800,
  VERIFICATION_DISTANCE: 300,
  REPORT_EXPIRY_HOURS: 12,
  REPORT_EXTENSION_HOURS: 1,
  MAX_NEGATIVE_VERIFICATIONS: 3,
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
  adminToggle: $('admin-toggle'),
  reloadBtn: $('reload-btn'),
  clearAlertsBtn: $('clear-alerts'),
  popupContainer: $('popup-container'),
  topBar: $('top-bar'),
  themeToggle: $('theme-toggle'),
  autoCenterBtn: $('toggle-auto-center'),
  reportButton: $('report-button'),
  reportMenu: $('report-menu'),
  verificationModal: $('verification-modal'),
  verificationText: $('verification-text'),
  clearReportsBtn: $('clear-reports'),
  // Sound test buttons
  testChime: $('test-chime'),
  testBeep: $('test-beep'),
  testCamera: $('test-camera'),
  testAvg: $('test-avg'),
  testPolice: $('test-police'),
  testConstruction: $('test-construction')
};

/* ========== STATE ========== */
let map, userMarker, accuracyCircle;
let radars = [];
let avgZones = [];
let reports = [];
let visibleMarkers = new Map();
let visibleReportMarkers = new Map();
let lastPos = null;
let lastMarkerRefreshPos = null;
let perCameraLastAlert = new Map();
let perReportLastAlert = new Map();
let lastGlobalAlert = 0;
let lastSpeed = 0;
let pipStream = null;
let pipCtx = null;
let pipRAF = null;
let pipEnabled = false;
let noSleep = window.noSleep || null;
let avgState = { active: null, samples: [], started: 0 };
let autoCenterEnabled = true;
let currentTheme = 'dark';
let currentVerificationReport = null;
let adminPanelVisible = false;

/* ========== AUDIO ASSETS ========== */
const AUDIO = {
  chime: tryCreateAudio('assets/chime.mp3'),
  beep: tryCreateAudio('assets/beep_beep.mp3'),
  cameraMsg: tryCreateAudio('assets/camera_ahead.mp3'),
  avgMsg: tryCreateAudio('assets/avg_zone_ahead.mp3'),
  police: tryCreateAudio('assets/police.mp3'),
  construction: tryCreateAudio('assets/construction.mp3')
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

/* ========== SOUND TESTING ========== */
function initSoundTesting() {
  // Test Chime
  if (DOM.testChime) {
    DOM.testChime.addEventListener('click', () => {
      if (AUDIO.chime) {
        AUDIO.chime.play().catch(e => console.warn('Chime play failed:', e));
        pushToast('Playing chime sound', 'success', 1000);
      } else {
        pushToast('Chime audio not found', 'error');
      }
    });
  }

  // Test Beep
  if (DOM.testBeep) {
    DOM.testBeep.addEventListener('click', () => {
      if (AUDIO.beep) {
        AUDIO.beep.play().catch(e => console.warn('Beep play failed:', e));
        pushToast('Playing beep sound', 'success', 1000);
      } else {
        pushToast('Beep audio not found', 'error');
      }
    });
  }

  // Test Camera Alert
  if (DOM.testCamera) {
    DOM.testCamera.addEventListener('click', () => {
      if (AUDIO.cameraMsg) {
        AUDIO.cameraMsg.play().catch(e => console.warn('Camera alert play failed:', e));
        pushToast('Playing camera alert', 'success', 1000);
      } else {
        pushToast('Camera alert audio not found', 'error');
      }
    });
  }

  // Test Average Zone
  if (DOM.testAvg) {
    DOM.testAvg.addEventListener('click', () => {
      if (AUDIO.avgMsg) {
        AUDIO.avgMsg.play().catch(e => console.warn('Avg zone play failed:', e));
        pushToast('Playing average zone alert', 'success', 1000);
      } else {
        pushToast('Average zone audio not found', 'error');
      }
    });
  }

  // Test Police
  if (DOM.testPolice) {
    DOM.testPolice.addEventListener('click', () => {
      if (AUDIO.police) {
        AUDIO.police.play().catch(e => console.warn('Police play failed:', e));
        pushToast('Playing police alert', 'success', 1000);
      } else {
        pushToast('Police audio not found', 'error');
      }
    });
  }

  // Test Construction
  if (DOM.testConstruction) {
    DOM.testConstruction.addEventListener('click', () => {
      if (AUDIO.construction) {
        AUDIO.construction.play().catch(e => console.warn('Construction play failed:', e));
        pushToast('Playing construction alert', 'success', 1000);
      } else {
        pushToast('Construction audio not found', 'error');
      }
    });
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
  
  map = L.map(DOM.map, { zoomControl: true }).setView([39.0, 35.0], 12);
  
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
    attribution: '&copy; OpenStreetMap & CARTO' 
  }).addTo(map);

  const userHtml = '<div class="user-icon"><div class="car-arrow" style="transform: rotate(0deg)"></div></div>';
  const userIcon = L.divIcon({ className:'user-icon-wrapper', html: userHtml, iconSize: [44,44], iconAnchor: [22,22] });
  userMarker = L.marker([39.0,35.0], { icon: userIcon, interactive: false }).addTo(map);
  accuracyCircle = L.circle([39.0,35.0], { radius: 0, color:'#00e5ff', opacity:0.15 }).addTo(map);

  map._avgLayer = L.layerGroup().addTo(map);
  map._radarLayer = L.layerGroup().addTo(map);
  map._reportLayer = L.layerGroup().addTo(map);
  
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

/* ========== ADMIN PANEL ========== */
function initAdminPanel() {
  // Admin toggle button
  if (DOM.adminToggle) {
    DOM.adminToggle.addEventListener('click', toggleAdminPanel);
  }
  
  // Close admin panel when clicking outside
  document.addEventListener('click', (e) => {
    if (adminPanelVisible && 
        DOM.adminPanel && 
        !DOM.adminPanel.contains(e.target) && 
        !DOM.adminToggle.contains(e.target)) {
      hideAdminPanel();
    }
  });
}

function toggleAdminPanel() {
  if (adminPanelVisible) {
    hideAdminPanel();
  } else {
    showAdminPanel();
  }
}

function showAdminPanel() {
  if (DOM.adminPanel) {
    DOM.adminPanel.classList.add('visible');
    adminPanelVisible = true;
    pushToast('Admin panel opened', 'success');
  }
}

function hideAdminPanel() {
  if (DOM.adminPanel) {
    DOM.adminPanel.classList.remove('visible');
    adminPanelVisible = false;
    pushToast('Admin panel closed', 'info');
  }
}

/* ========== REPORT SYSTEM ========== */
function initReportSystem() {
  // Load reports from localStorage
  loadReports();
  
  // Report button click
  if (DOM.reportButton) {
    DOM.reportButton.addEventListener('click', toggleReportMenu);
  }
  
  // Report options
  document.querySelectorAll('.report-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const type = e.currentTarget.dataset.type;
      createReport(type);
      hideReportMenu();
    });
  });
  
  // Verification buttons
  document.querySelectorAll('.verification-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const isConfirmed = e.currentTarget.classList.contains('yes');
      handleVerification(isConfirmed);
    });
  });
  
  // Close report menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!DOM.reportMenu.contains(e.target) && !DOM.reportButton.contains(e.target)) {
      hideReportMenu();
    }
  });
  
  // Start report cleanup interval
  setInterval(cleanupExpiredReports, 60000); // Check every minute
}

function toggleReportMenu() {
  if (DOM.reportMenu.classList.contains('visible')) {
    hideReportMenu();
  } else {
    showReportMenu();
  }
}

function showReportMenu() {
  DOM.reportMenu.classList.add('visible');
}

function hideReportMenu() {
  DOM.reportMenu.classList.remove('visible');
}

function createReport(type) {
  if (!lastPos) {
    pushToast('Wait for GPS location', 'error');
    return;
  }
  
  const report = {
    id: generateId(),
    type: type,
    lat: lastPos.lat,
    lon: lastPos.lon,
    createdAt: Date.now(),
    expiresAt: Date.now() + (CONFIG.REPORT_EXPIRY_HOURS * 60 * 60 * 1000),
    verifiedAt: Date.now(),
    positiveVerifications: 1,
    negativeVerifications: 0,
    verifiedBy: [generateUserHash()]
  };
  
  reports.push(report);
  saveReports();
  refreshReportMarkers();
  
  pushToast(`${type === 'police' ? 'Police' : 'Construction'} reported`, 'success');
}

function generateId() {
  return 'report_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateUserHash() {
  // Simple user identifier (not perfect but works for demo)
  return 'user_' + Math.random().toString(36).substr(2, 6);
}

function loadReports() {
  try {
    const saved = localStorage.getItem('radarnav-reports');
    if (saved) {
      reports = JSON.parse(saved);
      
      // Filter out expired reports
      const now = Date.now();
      reports = reports.filter(report => report.expiresAt > now);
      
      refreshReportMarkers();
    }
  } catch (e) {
    console.warn('Failed to load reports:', e);
    reports = [];
  }
}

function saveReports() {
  try {
    localStorage.setItem('radarnav-reports', JSON.stringify(reports));
  } catch (e) {
    console.warn('Failed to save reports:', e);
  }
}

function refreshReportMarkers() {
  const layer = map._reportLayer;
  if (!layer) return;
  
  // Clear existing markers
  visibleReportMarkers.forEach(marker => layer.removeLayer(marker));
  visibleReportMarkers.clear();
  
  if (!lastPos) return;
  
  reports.forEach(report => {
    const distance = haversine(lastPos.lat, lastPos.lon, report.lat, report.lon);
    if (distance <= CONFIG.REPORT_VISIBLE_M) {
      const color = report.type === 'police' ? '#4dabf7' : '#ffa94d';
      const icon = report.type === 'police' ? '🚓' : '🚧';
      
      const marker = L.circleMarker([report.lat, report.lon], {
        radius: 10,
        fillColor: color,
        color: '#fff',
        weight: 2,
        fillOpacity: 0.8
      }).addTo(layer);
      
      marker.bindPopup(`
        <div style="text-align:center;padding:8px;">
          <div style="font-size:20px;margin-bottom:4px;">${icon}</div>
          <strong>${report.type === 'police' ? 'Police Check' : 'Road Construction'}</strong><br>
          <small>Reported ${formatTimeAgo(report.createdAt)}</small><br>
          <small>Verified: ${report.positiveVerifications} times</small>
        </div>
      `);
      
      visibleReportMarkers.set(report.id, marker);
    }
  });
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function detectApproachingReports(lat, lon, heading) {
  const nowTs = now();
  
  reports.forEach(report => {
    // Skip if recently alerted for this report
    const lastAlert = perReportLastAlert.get(report.id) || 0;
    if (nowTs - lastAlert < CONFIG.ALERT_THROTTLE_MS) return;
    
    const distance = haversine(lat, lon, report.lat, report.lon);
    if (distance > CONFIG.REPORT_ALERT_DISTANCE) return;
    
    // Check if report is ahead of us
    const brg = bearing(lat, lon, report.lat, report.lon);
    const diff = angleDiff(brg, heading);
    if (diff > CONFIG.AHEAD_ANGLE) return;
    
    perReportLastAlert.set(report.id, nowTs);
    fireReportAlert(report, Math.round(distance));
  });
}

function fireReportAlert(report, distM) {
  const label = report.type === 'police' ? 'Police reported' : 'Construction reported';
  const message = `${label} — ${distM} m`;
  showCenteredAlert(message);

  // Play chime then specific audio
  if (AUDIO.chime) {
    AUDIO.chime.play().then(() => {
      setTimeout(() => {
        const audio = report.type === 'police' ? AUDIO.police : AUDIO.construction;
        if (audio) audio.play().catch(console.warn);
      }, 500);
    }).catch(console.warn);
  }
}

function checkReportVerification(lat, lon) {
  if (currentVerificationReport) return; // Already showing a verification
  
  reports.forEach(report => {
    const distance = haversine(lat, lon, report.lat, report.lon);
    if (distance <= CONFIG.VERIFICATION_DISTANCE) {
      // Check if user already verified this report
      const userHash = generateUserHash();
      if (!report.verifiedBy.includes(userHash)) {
        showVerificationModal(report);
        return;
      }
    }
  });
}

function showVerificationModal(report) {
  currentVerificationReport = report;
  DOM.verificationText.textContent = `Is the ${report.type === 'police' ? 'police check' : 'road construction'} still present?`;
  DOM.verificationModal.classList.add('visible');
}

function hideVerificationModal() {
  DOM.verificationModal.classList.remove('visible');
  currentVerificationReport = null;
}

function handleVerification(isConfirmed) {
  if (!currentVerificationReport) return;
  
  const report = currentVerificationReport;
  const userHash = generateUserHash();
  
  if (isConfirmed) {
    // Extend report lifetime
    report.expiresAt = Date.now() + (CONFIG.REPORT_EXTENSION_HOURS * 60 * 60 * 1000);
    report.positiveVerifications++;
    report.verifiedAt = Date.now();
    pushToast('Report confirmed - extended by 1 hour', 'success');
  } else {
    report.negativeVerifications++;
    pushToast('Report marked as gone', 'error');
    
    // Remove if too many negative verifications
    if (report.negativeVerifications >= CONFIG.MAX_NEGATIVE_VERIFICATIONS) {
      removeReport(report.id);
      pushToast('Report removed - multiple users confirmed it\'s gone', 'info');
      hideVerificationModal();
      return;
    }
  }
  
  // Mark user as having verified this report
  if (!report.verifiedBy.includes(userHash)) {
    report.verifiedBy.push(userHash);
  }
  
  saveReports();
  refreshReportMarkers();
  hideVerificationModal();
}

function removeReport(reportId) {
  reports = reports.filter(r => r.id !== reportId);
  
  // Remove from map
  const marker = visibleReportMarkers.get(reportId);
  if (marker) {
    map._reportLayer.removeLayer(marker);
    visibleReportMarkers.delete(reportId);
  }
  
  saveReports();
}

function cleanupExpiredReports() {
  const now = Date.now();
  const expiredCount = reports.filter(report => report.expiresAt <= now).length;
  
  if (expiredCount > 0) {
    reports = reports.filter(report => report.expiresAt > now);
    saveReports();
    refreshReportMarkers();
    console.log(`Cleaned up ${expiredCount} expired reports`);
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
        refreshReportMarkers();
        lastMarkerRefreshPos = { lat, lon };
      }
      
      // Check for cameras
      detectApproachingCameras(lat, lon, heading || 0);
      
      // Check for reports
      detectApproachingReports(lat, lon, heading || 0);
      
      // Check for report verification
      checkReportVerification(lat, lon);
      
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
  DOM.avgZoneBar.classList.add('visible');
  DOM.zoneLimitVal.textContent = zone.limit + ' km/h';
}

function avgStateExit() {
  if (!avgState.active) return;
  
  const avg = avgState.samples.length ? 
    Math.round(avgState.samples.reduce((a,b) => a + b, 0) / avgState.samples.length) : 0;
  
  showCenteredAlert(`Average zone finished — avg ${avg} km/h (limit ${avgState.active.limit})`, 4200);
  
  avgState.active = null;
  avgState.samples = [];
  DOM.avgZoneBar.classList.remove('visible');
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

  // Clear reports button
  if (DOM.clearReportsBtn) {
    DOM.clearReportsBtn.addEventListener('click', () => {
      reports = [];
      saveReports();
      refreshReportMarkers();
      pushToast('All reports cleared', 'success');
    });
  }

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

  // Initialize sound testing
  initSoundTesting();
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
    initAdminPanel();
    initReportSystem();
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