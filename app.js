let map, userMarker, radars = [], avgZones = [];
let userLat = 0, userLon = 0, userSpeed = 0, userHeading = 0;
let alertActive = false, pipActive = false;
let noSleep = new NoSleep();

const alertPopup = document.getElementById("alertPopup");
const alertText = document.getElementById("alertText");
const errorBox = document.getElementById("errorBox");
const pipCanvas = document.getElementById("pipCanvas");
const pipVideo = document.getElementById("pipVideo");
const pipToggle = document.getElementById("pipToggle");
const ctx = pipCanvas.getContext("2d");

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
  setTimeout(() => errorBox.classList.add("hidden"), 4000);
}

async function loadData() {
  try {
    const res = await fetch("SCDB_SpeedCams.json");
    const data = await res.json();
    radars = data.map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,
      unt: cam.unt
    }));
    console.log(`Loaded ${radars.length} cameras`);
  } catch (err) {
    console.error(err);
    showError("Failed to load radar data.");
  }

  try {
    const z = await fetch("avg_zones.json");
    avgZones = await z.json();
  } catch {
    console.warn("No avg_zones.json found — skipping.");
  }
}

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: false
  }).setView([0, 0], 14);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(map);
}

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateSpeedDisplay() {
  ctx.clearRect(0, 0, pipCanvas.width, pipCanvas.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
  ctx.fillStyle = "#0f0";
  ctx.font = "bold 40px Arial";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(userSpeed)} km/h`, 100, 70);
}

function updateUserMarker(lat, lon) {
  if (!userMarker) {
    userMarker = L.marker([lat, lon], {
      icon: L.icon({
        iconUrl: "car-icon.png",
        iconSize: [40, 40],
        iconAnchor: [20, 20]
      })
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lon]);
  }
  map.setView([lat, lon]);
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
        fillColor: "red",
        fillOpacity: 0.9
      }).addTo(map);
    }
  });
}

function handleRadarAlerts() {
  let nearest = null, minDist = Infinity;
  radars.forEach(radar => {
    const dist = distance(userLat, userLon, radar.lat, radar.lon);
    if (dist < minDist) {
      minDist = dist;
      nearest = radar;
    }
  });

  if (nearest && minDist <= 1 && !alertActive) {
    alertActive = true;
    alertText.textContent = `⚠️ Radar ahead in ${Math.round(minDist * 1000)} m!`;
    alertPopup.classList.remove("hidden");
    setTimeout(() => {
      alertPopup.classList.add("hidden");
      alertActive = false;
    }, 4000);
  }
}

function startPiP() {
  if (pipActive) return;
  const stream = pipCanvas.captureStream(30);
  pipVideo.srcObject = stream;
  pipVideo.play();
  pipVideo.requestPictureInPicture().then(() => {
    pipActive = true;
  }).catch(err => {
    console.error("PiP failed:", err);
    showError("PiP not supported.");
  });
}

function enableNoSleep() {
  document.addEventListener("click", () => {
    noSleep.enable();
  }, { once: true });
}

async function init() {
  initMap();
  await loadData();
  enableNoSleep();

  if (!navigator.geolocation) {
    showError("Geolocation not supported.");
    return;
  }

  navigator.geolocation.watchPosition(pos => {
    userLat = pos.coords.latitude;
    userLon = pos.coords.longitude;
    userSpeed = pos.coords.speed ? pos.coords.speed * 3.6 : 0;
    updateUserMarker(userLat, userLon);
    updateVisibleRadars();
    handleRadarAlerts();
    updateSpeedDisplay();
  }, err => {
    showError("Location error: " + err.message);
  }, { enableHighAccuracy: true, maximumAge: 1000 });
}

pipToggle.addEventListener("click", startPiP);
init();
/***********************
 * app.js - CHUNK 2
 ***********************/

/* ---------- Helpers ---------- */

// compute bearing from (lat1,lon1) to (lat2,lon2) in degrees 0..360
function getBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// shortest absolute difference between bearings (0..180)
function bearingDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

// throttle helper: run fn at most every wait ms
function throttle(fn, wait) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn.apply(this, args);
    }
  };
}

// debounce helper
function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

/* ---------- Marker pool / performance ---------- */

const markerPool = [];
const activeMarkers = new Map(); // radarIndex -> marker

function getMarkerFromPool() {
  if (markerPool.length) return markerPool.pop();
  return L.circleMarker([0,0], { radius: 6, weight: 2, fillOpacity: 0.9 });
}

function releaseMarker(marker) {
  try {
    map.removeLayer(marker);
  } catch (e) {}
  markerPool.push(marker);
}

/* ---------- Heading-aware filtering & approaching logic ---------- */

// returns true if radar is "ahead" within +/- allowedDeg of heading
function isAheadOfUser(radar, heading, allowedDeg = 50) {
  if (heading == null || isNaN(heading)) return true; // if no heading, be permissive
  const brng = getBearing(userLat, userLon, radar.lat, radar.lon);
  const diff = bearingDiff(brng, heading);
  return diff <= allowedDeg;
}

// Called (throttled) whenever location updates; decides marker display and alerts
const onPositionThrottled = throttle(function () {
  if (!map || !currentPos) return;

  // 1) update visible markers within 10km
  const maxKm = 10;
  const visible = [];
  for (let i = 0; i < radars.length; i++) {
    const r = radars[i];
    const dKm = distance(userLat, userLon, r.lat, r.lon); // in km
    if (dKm <= maxKm) visible.push({ r, idx: i, dKm });
  }

  // limit number of markers for performance (keep nearest 250)
  visible.sort((a, b) => a.dKm - b.dKm);
  const toShow = visible.slice(0, 250);

  // release markers that are no longer in toShow
  const keepSet = new Set(toShow.map(x => x.idx));
  for (let [idx, marker] of activeMarkers.entries()) {
    if (!keepSet.has(idx)) {
      activeMarkers.delete(idx);
      releaseMarker(marker);
    }
  }

  // add/update markers for toShow
  toShow.forEach(({ r, idx }) => {
    let marker = activeMarkers.get(idx);
    if (!marker) {
      marker = getMarkerFromPool();
      marker.setStyle({
        color: r.flg === 2 ? '#ff3333' : '#ffcc00',
        fillColor: r.flg === 2 ? '#ff6666' : '#ffd966',
        radius: 7
      });
      marker.options.cameraMarker = true;
      marker.addTo(map);
      activeMarkers.set(idx, marker);
    }
    marker.setLatLng([r.lat, r.lon]);
  });

  // 2) detect nearest approaching radar (within 1km AND ahead of heading)
  const alertRadiusKm = 1.0; // 1 km
  let nearest = null;
  for (let v of toShow) {
    const r = v.r;
    const dKm = v.dKm;
    if (dKm <= alertRadiusKm) {
      // check heading/direction: only alert if radar is ahead of movement
      const heading = currentPos && currentPos.heading != null ? currentPos.heading : null;
      if (isAheadOfUser(r, heading, 50)) {
        if (!nearest || dKm < nearest.dKm) nearest = { r, dKm, idx: v.idx };
      }
    }
  }

  // throttle alerts: only allow once per 5s
  const now = Date.now();
  if (nearest && (!onPositionThrottled._lastAlert || now - onPositionThrottled._lastAlert > 5000)) {
    // show alert in UI
    showApproachingAlert(nearest.r, Math.round(nearest.dKm * 1000));
    onPositionThrottled._lastAlert = now;
  }

  // 3) update avg-zone progress only if inside avg zone and approaching
  updateAvgZoneIfAny();

}, 600); // run at most ~ once every 600ms for smoother performance

/* ---------- Alert / Avg-zone UI ---------- */

function showApproachingAlert(radar, distMeters) {
  // radar: object, distMeters: integer
  alertText.textContent = `${radar.flg === 2 ? 'Average' : 'Fixed'} camera ahead — ${distMeters} m`;
  alertPopup.classList.remove('hidden');

  // chime
  if (chime) {
    try { chime.currentTime = 0; chime.play().catch(()=>{}); } catch(e){}
  }

  // hide after 4s
  clearTimeout(showApproachingAlert._hideTO);
  showApproachingAlert._hideTO = setTimeout(() => {
    alertPopup.classList.add('hidden');
  }, 4000);
}

function updateAvgZoneIfAny() {
  if (!currentPos) { hideAvgZone(); return; }

  // find avg zone where user projects onto segment and is within 60m gap
  for (let z of avgZones || []) {
    if (!z || !z.start || !z.end) continue;
    const total = distance(z.start.lat, z.start.lng, z.end.lat, z.end.lng) * 1000; // km->m
    const dStart = distance(z.start.lat, z.start.lng, userLat, userLon) * 1000;
    const dEnd = distance(z.end.lat, z.end.lng, userLat, userLon) * 1000;
    const gap = Math.abs(dStart + dEnd - total);
    if (gap < 60 && dStart <= total + 30) {
      // inside zone - show progress
      const pct = Math.min(1, Math.max(0, dStart / total));
      // show only if zone is average type (assume zone.limit exists)
      if (z.limit != null) {
        showAvgZone(z, pct, Math.round(userSpeed));
        return;
      }
    }
  }
  hideAvgZone();
}

function showAvgZone(zone, pct, kmh) {
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit || '?';

  const percent = Math.round(pct * 100);
  progressFill.style.width = `${percent}%`;
  carMarker.style.left = `${percent}%`;

  // color ramp
  const over = kmh - (zone.limit || 0);
  if (over <= 0) {
    progressFill.style.background = 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
  } else {
    const r = Math.min(255, Math.round((over / (zone.limit || 1)) * 255 * 1.4));
    const g = Math.max(0, 200 - Math.round((over / (zone.limit || 1)) * 200));
    progressFill.style.background = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
  }
}

function hideAvgZone() {
  avgZoneBar.classList.add('hidden');
}

/* ---------- PiP logic update (show speed only until approaching) ---------- */

function isApproachingCamera(lat, lon) {
  if (!radars || !radars.length) return false;
  const alertRadiusKm = 1.0;
  for (let r of radars) {
    const dKm = distance(userLat, userLon, r.lat, r.lon);
    if (dKm <= alertRadiusKm) {
      // require it to be roughly ahead too
      const heading = currentPos && currentPos.heading != null ? currentPos.heading : null;
      if (isAheadOfUser(r, heading, 50)) return true;
    }
  }
  return false;
}

// render PiP canvas: speed only or speed + alert depending on approaching
function renderPip(kmh) {
  const ctx = pipCtx;
  const w = pipCanvas.width, h = pipCanvas.height;
  ctx.clearRect(0, 0, w, h);
  // background
  ctx.fillStyle = '#071021';
  ctx.fillRect(0, 0, w, h);

  const approaching = isApproachingCamera(userLat, userLon);

  if (approaching && !alertPopup.classList.contains('hidden')) {
    // show alert + speed
    roundRect(ctx, 10, 10, w - 20, h - 20, 12, '#122033');
    ctx.font = '18px Arial';
    ctx.fillStyle = '#ffd7d7';
    ctx.fillText('🚨', 28, 40);
    ctx.font = '14px Arial';
    wrapText(ctx, alertText.textContent || 'Alert', 70, 28, w - 100, 18);
    ctx.font = '26px Arial';
    ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${Math.round(kmh)} km/h`, w / 2, h - 30);
  } else {
    // show speed only
    roundRect(ctx, 20, 30, w - 40, h - 60, 10, '#0b2a33');
    ctx.font = '32px Arial';
    ctx.fillStyle = '#00e5ff';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(kmh)} km/h`, w / 2, h / 2 + 8);
    ctx.textAlign = 'start';
  }
}

// continuously update pip canvas at reasonable frequency
let pipRAF = null;
function startPipLoop() {
  if (pipRAF) return;
  function loop() {
    renderPip(userSpeed || 0);
    pipRAF = requestAnimationFrame(loop);
  }
  loop();
}

/* ---------- Admin menu: triple-tap to open ---------- */

let tapCount = 0, tapTimer = null;
document.addEventListener('touchend', () => {
  tapCount += 1;
  if (tapCount === 3) {
    document.getElementById('adminMenu').classList.toggle('collapsed');
    tapCount = 0;
    clearTimeout(tapTimer);
  } else {
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { tapCount = 0; }, 800);
  }
});

// Admin buttons behavior (must exist in DOM)
const btnRadar = document.getElementById('testRadar');
const btnAvgZone = document.getElementById('testAvgZone');
const btnClear = document.getElementById('testClear');

if (btnRadar) btnRadar.addEventListener('click', () => showApproachingAlert({ flg: 1 }, 500));
if (btnAvgZone) btnAvgZone.addEventListener('click', () => showApproachingAlert({ flg: 2 }, 800));
if (btnClear) btnClear.addEventListener('click', () => {
  alertPopup.classList.add('hidden');
  hideAvgZone();
});

/* ---------- Hook into position updates ---------- */

// Replace previous raw onPosition actions with this consolidated handler.
// If chunk1 was using navigator.watchPosition to update currentPos & userLat/userLon,
// ensure it now calls onGPSUpdate(lat, lon, speed, heading)

function onGPSUpdate(lat, lon, speed, heading) {
  userLat = lat; userLon = lon;
  userSpeed = (speed != null) ? (speed * 3.6) : userSpeed; // keep previous if null
  if (heading != null) currentPos = currentPos || {};
  currentPos = Object.assign(currentPos || {}, { lat: userLat, lon: userLon, heading });
  // Throttled update handles markers + alerts + avg-zone
  onPositionThrottled();
}

// If your watchPosition currently calls code inline, change to call onGPSUpdate.
// Example usage from chunk1's geolocation handler:
// navigator.geolocation.watchPosition(p => {
//    onGPSUpdate(p.coords.latitude, p.coords.longitude, p.coords.speed, p.coords.heading);
// }, ...);

/* ---------- Startup tweaks ---------- */

// start pip canvas loop (updates only UI; heavy work is throttled)
startPipLoop();

// ensure map, data, geolocation were initialized in chunk1's init()
// If your chunk1's init didn't call loadData/initMap/startGeolocation, ensure those are run before using this chunk.

console.log('Chunk 2 loaded: heading-aware alerts, 10km markers, avg-zone UI, admin menu.');
