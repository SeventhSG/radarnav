let map, userMarker, radars = [], avgZones = [];
let userLat = 0, userLon = 0, userSpeed = 0, userHeading = 0;
let alertActive = false, pipActive = false;
let noSleep = new NoSleep();

const alertPopup = document.getElementById("alertPopup");
const alertText = document.getElementById("alertText");
const errorBox = document.getElementById("errorBox");
const pipCanvas = document.getElementById("pipCanvas");
const pipVideo = document.getElementById("pipVideo");
const ctx = pipCanvas.getContext("2d");

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
  setTimeout(() => errorBox.classList.add("hidden"), 4000);
}

async function loadData() {
  try {
    const res = await fetch("SCDB_SpeedCams.json");
    const text = await res.text();

    // Normalize bad JSON format (SCDB style)
    const jsonObjects = text
      .split("}")
      .filter(l => l.includes("lat"))
      .map(l => JSON.parse(l.replace("{", "{").trim() + "}"));

    radars = jsonObjects.map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,
      unt: cam.unt
    }));

    console.log(`Loaded ${radars.length} radars`);
  } catch (err) {
    console.error("Radar load failed:", err);
    showError("❌ Failed to load radar data");
  }
}

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: false
  }).setView([0, 0], 15);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(map);
}

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateUserMarker(lat, lon) {
  if (!userMarker) {
    userMarker = L.marker([lat, lon], {
      icon: L.icon({
        iconUrl: "car-icon.png",
        iconSize: [50, 50],
        iconAnchor: [25, 25]
      })
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lon]);
  }

  // Keep car centered and rotate map like Google Maps
  map.setView([lat, lon]);
  const rotation = 360 - userHeading; // rotate map opposite to heading
  const mapContainer = document.querySelector("#map .leaflet-pane.leaflet-map-pane");
  if (mapContainer) mapContainer.style.transform = `rotate(${rotation}deg)`;
}

function updateVisibleRadars() {
  map.eachLayer(layer => {
    if (layer.options && layer.options.icon && layer !== userMarker) {
      map.removeLayer(layer);
    }
  });

  radars.forEach(radar => {
    const dist = distance(userLat, userLon, radar.lat, radar.lon);
    if (dist <= 10) {
      const marker = L.circleMarker([radar.lat, radar.lon], {
        radius: 6,
        color: radar.flg === 2 ? "red" : "orange",
        fillColor: radar.flg === 2 ? "red" : "orange",
        fillOpacity: 0.8
      }).addTo(map);
    }
  });
}

function drawPiP() {
  ctx.clearRect(0, 0, pipCanvas.width, pipCanvas.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);

  ctx.fillStyle = "#0f0";
  ctx.font = "bold 40px Arial";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(userSpeed)} km/h`, 100, 60);

  if (alertActive) {
    ctx.fillStyle = "#ff0000";
    ctx.font = "bold 20px Arial";
    ctx.fillText("⚠️ Radar ahead!", 100, 100);
  }
}
// -------------------- Chunk 2 --------------------
// Final behaviors: GPS watch, heading, alerts, admin, PiP loop, NoSleep

// Config (small tweaks)
const ALERT_THROTTLE_MS = 5000;
const AHEAD_ANGLE = 50; // degrees, ± window to be considered "ahead"

// DOM elements assumed present from index.html
const adminMenuEl = document.getElementById('adminMenu');
const testRadarBtn = document.getElementById('testRadar');
const testAvgBtn = document.getElementById('testAvgZone');
const testClearBtn = document.getElementById('testClear');

// Ensure map transform origin is center so rotation looks right
function ensureMapRotationSetup() {
  const container = map && map.getContainer();
  if (!container) return;
  container.style.transformOrigin = '50% 50%';
  // Also set pointer events to map pane (avoid rotated overlay oddness)
  container.style.willChange = 'transform';
}
ensureMapRotationSetup();

// helper: show large centered alert (on main screen) vs pip
function showCenteredAlert(text) {
  if (!alertPopup || !alertText) return;
  // If PiP is active and document.pictureInPictureElement -> show inside PiP instead
  const pipShown = !!document.pictureInPictureElement;
  if (pipShown) {
    // put same text but ensure pip will draw it (alertActive used)
    alertText.textContent = text;
    alertActive = true;
    // hide main centered alert if visible
    alertPopup.classList.add('hidden');
    // pip will display alert frame because alertActive true
  } else {
    alertText.textContent = text;
    alertPopup.classList.remove('hidden');
    alertActive = true;
    // hide after 4s and clear flag
    setTimeout(() => { alertPopup.classList.add('hidden'); alertActive = false; }, 4000);
  }
}

// is radar roughly ahead of heading
function isAheadOfUser(rLat, rLon, heading) {
  if (heading == null || isNaN(heading)) {
    // fallback: if we have lastPos derive heading; otherwise permissive
    if (lastPos && lastPos.lat != null) {
      const derived = deriveHeading(lastPos, { lat: userLat, lon: userLon });
      if (derived != null) heading = derived;
      else return true;
    } else return true;
  }
  const br = bearingDeg(userLat, userLon, rLat, rLon);
  const diff = angleDiffAbs(br, heading);
  return diff <= AHEAD_ANGLE;
}

// find nearest radar that's within CAMERA_RADIUS_KM, ahead, return {r, dKm}
function findNearestAheadRadar(limitKm = CAMERA_RADIUS_KM) {
  let nearest = null;
  let min = Infinity;
  for (const r of radars) {
    if (!r || r.lat == null) continue;
    const d = distance(userLat, userLon, r.lat, r.lon);
    if (d > limitKm) continue;
    if (!isAheadOfUser(r.lat, r.lon, userHeading)) continue;
    if (d < min) { min = d; nearest = { r, dKm: d }; }
  }
  return nearest;
}

// main approaching check (throttled by ALERT_THROTTLE_MS)
let lastAlertTs = 0;
function checkApproachAndAlert() {
  const now = Date.now();
  if (now - lastAlertTs < ALERT_THROTTLE_MS) return;
  const nearest = findNearestAheadRadar();
  if (!nearest) return;
  if (nearest.dKm <= ALERT_RADIUS_KM) {
    // optional: check road alignment using avgZones projection heuristic if avgZones exist
    let onRoad = true;
    if (avgZones && avgZones.length) {
      onRoad = false;
      for (const z of avgZones) {
        if (!z || !z.start || !z.end) continue;
        const total = distance(z.start.lat, z.start.lng, z.end.lat, z.end.lng) * 1000;
        const d1 = distance(z.start.lat, z.start.lng, nearest.r.lat, nearest.r.lon) * 1000;
        const d2 = distance(nearest.r.lat, nearest.r.lon, z.end.lat, z.end.lng) * 1000;
        const gap = Math.abs((d1 + d2) - total);
        if (gap < 60) { onRoad = true; break; }
      }
    }
    if (onRoad) {
      lastAlertTs = now;
      showCenteredAlert(`${nearest.r.flg === 2 ? 'Average' : 'Fixed'} camera ahead — ${Math.round(nearest.dKm * 1000)} m`);
    }
  }
}

// update visible markers (uses pool from chunk1)
function refreshNearbyMarkers() {
  updateNearbyMarkers(userLat, userLon); // uses pool / activeMarkers implemented in chunk1
}

// when position updates (called by watchPosition)
function onPositionUpdate(p) {
  if (!p || !p.coords) return;
  const lat = p.coords.latitude;
  const lon = p.coords.longitude;
  const speedMps = p.coords.speed;
  const heading = (p.coords.heading != null && !isNaN(p.coords.heading)) ? p.coords.heading : null;

  // derive heading if missing and we have lastPos
  if (heading == null && lastPos && lastPos.lat != null) {
    userHeading = deriveHeading(lastPos, { lat, lon });
  } else if (heading != null) {
    userHeading = heading;
  }

  // update lastPos
  lastPos = { lat: userLat, lon: userLon, t: Date.now() };

  // set user lat/lon/speed
  userLat = lat; userLon = lon;
  userSpeed = (speedMps != null && !isNaN(speedMps)) ? Math.round(speedMps * 3.6) : userSpeed;

  // update map center and rotation (google maps style)
  if (map) {
    // center map smoothly and rotate container
    const view = map.getSize();
    // set center to user's lat/lon
    map.setView([userLat, userLon], map.getZoom(), { animate: false });
    // rotate entire map container opposite to heading so heading appears "up"
    if (userHeading != null && !isNaN(userHeading)) {
      const rotation = 360 - userHeading;
      const cont = map.getContainer();
      if (cont) cont.style.transform = `rotate(${rotation}deg)`;
      // rotate UI overlays back so they remain upright
      // overlays (alertPopup, adminMenu, avgZoneBar, pipCanvas) must be counter-rotated
      const rotateBack = `rotate(${userHeading}deg)`;
      [alertPopup, adminMenuEl, avgZoneBar, pipCanvas].forEach(el=>{
        if (!el) return;
        el.style.transform = rotateBack;
      });
    } else {
      const cont = map.getContainer();
      if (cont) cont.style.transform = '';
      [alertPopup, adminMenuEl, avgZoneBar, pipCanvas].forEach(el=>{ if(el) el.style.transform = ''; });
    }
  }

  // keep user marker centered (we'll draw a textured icon anchored to screen center)
  // If you prefer a moving icon on the map, update marker position instead.
  updateUserMarker(userLat, userLon);

  // minimal immediate updates
  renderPipFrame(userSpeed, false); // speed-only; pip frame will show alert if alertActive set

  // throttle heavier operations
  visualUpdateThrottled();
}

// throttle heavy stuff
const visualUpdateThrottled = throttle(() => {
  refreshNearbyMarkers();
  detectAndShowAvgZone();
  checkApproachAndAlert();
}, 700);

// Start GPS watch
function startGPSWatch() {
  if (!('geolocation' in navigator)) { showError('Geolocation not available'); return; }
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPositionUpdate, (e)=>{
    console.warn('geo error', e);
    showError('GPS error: '+(e && e.message ? e.message : e));
  }, { enableHighAccuracy: true, maximumAge: 300, timeout: 10000 });
}

// Admin triple-tap: toggle admin menu
(function adminSetup(){
  let taps = 0, t = null;
  document.addEventListener('click', ()=> {
    taps++;
    if (taps === 3) {
      if (adminMenuEl) adminMenuEl.classList.toggle('collapsed');
      taps = 0; clearTimeout(t);
      return;
    }
    clearTimeout(t);
    t = setTimeout(()=> { taps = 0; }, 800);
  });

  if (testRadarBtn) testRadarBtn.addEventListener('click', ()=> showCenteredAlert('Test Fixed Radar — 500 m'));
  if (testAvgBtn) testAvgBtn.addEventListener('click', ()=> showCenteredAlert('Test Average Zone — 800 m'));
  if (testClearBtn) testClearBtn.addEventListener('click', ()=> { alertPopup.classList.add('hidden'); hideAvgZone(); });
})();

// PiP auto-behavior: when PiP active, show alerts inside pip instead of big centered overlay
async function initPiPHandlers() {
  if (!pipToggle || !pipCanvas || !pipVideo) return;
  pipToggle.addEventListener('click', async () => {
    if (!document.pictureInPictureEnabled) { showError('PiP not supported'); return; }
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
    } catch (err) {
      console.error('PiP err', err);
      showError('PiP error');
    }
  });

  document.addEventListener('enterpictureinpicture', ()=> {
    // when PiP enters, if an alert is pending show inside pip (alertActive controls pip drawing)
    // hide main centered alert
    alertPopup.classList.add('hidden');
  });
  document.addEventListener('leavepictureinpicture', ()=> {
    // when PiP closes, ensure main alert can show again
  });
}

// NoSleep enable on first gesture
if (noSleep) {
  document.addEventListener('click', ()=> {
    try { noSleep.enable(); } catch(e) { /* ignore */ }
  }, { once: true });
}

// start pip canvas loop to keep it updating
let pipRAF = null;
function startPipLoop() {
  if (!pipCanvas || !pipCtx) return;
  if (pipRAF) return;
  function loop() {
    const approaching = isApproachingCameraFast(); // quick check (no allocations)
    renderPipFrame(userSpeed || 0, approaching && !!document.pictureInPictureElement);
    pipRAF = requestAnimationFrame(loop);
  }
  loop();
}

function isApproachingCameraFast() {
  // quick check: find any radar within alert radius and ahead
  for (const r of radars) {
    if (!r || r.lat==null) continue;
    const d = distance(userLat, userLon, r.lat, r.lon);
    if (d <= ALERT_RADIUS_KM && isAheadOfUser(r.lat, r.lon, userHeading)) return true;
  }
  return false;
}

// expose quick reload function for admin
async function reloadData() {
  await loadData();
  refreshNearbyMarkers();
  showError('Data reloaded', 1500);
}

// start everything (to call from your HTML or after this file loads)
async function startAppFinal() {
  initMap();          // from chunk1
  await loadData();   // from chunk1
  ensureMapRotationSetup();
  initPiPHandlers();
  startPipLoop();
  startGPSWatch();
  // small initial draw
  renderPipFrame(0, false);
}

// auto-start
startAppFinal();
