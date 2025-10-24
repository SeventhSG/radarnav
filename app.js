// app.js - Fully optimized RadarNav for mobile

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
let currentPos = null;
let activeAvgZone = null;

const alertPopup = document.getElementById('alertPopup');
const alertText = document.getElementById('alertText');
const avgZoneBar = document.getElementById('avgZoneBar');
const avgSpeedVal = document.getElementById('avgSpeedVal');
const zoneLimitVal = document.getElementById('zoneLimitVal');
const progressFill = document.getElementById('progressFill');
const carMarker = document.getElementById('carMarker');
const speedDisplay = document.getElementById('speedDisplay');
const pipToggle = document.getElementById('pipToggle');
const chime = new Audio('assets/chime.mp3');

async function init() {
    await loadData();
    initMap();
    setupPiPButton();
    startGeolocation();
    startCanvasLoop();
}

async function loadData() {
    try {
        const res = await fetch('SCDB_SpeedCams.json');
        const text = await res.text();

        // SCDB JSON is not valid standard JSON, fix manually
        let jsonLines = text.match(/\{[^}]+\}/g);
        radars = jsonLines.map(line => {
            const cam = JSON.parse(line);
            return { lat: cam.lat, lon: cam.lon, flg: cam.flg, unt: cam.unt };
        });

        console.log(`Loaded ${radars.length} cameras`);
        const z = await fetch('avg_zones.json');
        avgZones = await z.json();
    } catch (err) {
        showError(`Failed to load SCDB: ${err}`);
        console.error(err);
    }
}

function initMap() {
    map = L.map('map', { zoomControl: true }).setView([0, 0], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    userMarker = L.circleMarker([0, 0], { radius: 10, color: '#00e5ff', fillColor: '#00a3b7', fillOpacity: 1 }).addTo(map);

    radars.forEach(r => {
        r.marker = L.circle([r.lat, r.lon], {
            radius: 12,
            color: r.flg === 1 ? '#ff4444' : '#ffcc00',
            weight: 2
        }).addTo(map);
        r.marker.bindPopup(`${r.unt === 'kmh' ? 'Speed Camera' : 'Unknown'} (${r.flg === 1 ? 'Fixed' : 'Average'})`);
    });

    avgZones.forEach(z => {
        z.line = L.polyline([[z.start.lat, z.start.lng], [z.end.lat, z.end.lng]], {
            color: '#88f', weight: 4, opacity: 0.7
        }).addTo(map);
    });
}

function startGeolocation() {
    if (!('geolocation' in navigator)) {
        showError('Geolocation not supported in this browser');
        return;
    }

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
        enableHighAccuracy: true,
        maximumAge: 500,
        timeout: 10000
    });
}

function onGeoError(err) {
    showError(`Geo error: ${err.message}`);
}

let lastAlertTime = 0;

function onPosition(p) {
    const lat = p.coords.latitude;
    const lng = p.coords.longitude;
    const speedMps = p.coords.speed;
    const kmh = speedMps == null ? lastSpeed : Math.round(speedMps * 3.6);
    lastSpeed = kmh;

    currentPos = { lat, lng, speedMps };

    map.setView([lat, lng], 13);
    userMarker.setLatLng([lat, lng]);
    speedDisplay.textContent = `${kmh} km/h`;

    updateVisibleRadars();
    detectNearbyRadars(lat, lng);
    detectAvgZones(lat, lng, kmh);
    drawPiP(kmh);
}

function distanceMeters(aLat, aLng, bLat, bLng) {
    const R = 6371000;
    const toRad = v => v * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const aa = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
    return R * c;
}

// Show only cameras within 10km radius
function updateVisibleRadars() {
    if (!currentPos) return;
    radars.forEach(r => {
        const d = distanceMeters(currentPos.lat, currentPos.lon, r.lat, r.lon);
        if (d <= 10000) r.marker.addTo(map);
        else r.marker.remove();
    });
}

function detectNearbyRadars(lat, lng) {
    const now = Date.now();
    radars.forEach(r => {
        const d = distanceMeters(lat, lng, r.lat, r.lon);
        if (d < 1000 && now - lastAlertTime > 5000) {
            showAlert(`Radar ahead! ${Math.round(d)} m`);
            lastAlertTime = now;
        }
    });
}

// --- AVG ZONES ---
function detectAvgZones(lat, lng, kmh) {
    let found = null;
    for (let z of avgZones) {
        const total = distanceMeters(z.start.lat, z.start.lng, z.end.lat, z.end.lng);
        const distToStart = distanceMeters(z.start.lat, z.start.lng, lat, lng);
        const distToEnd = distanceMeters(z.end.lat, z.end.lng, lat, lng);
        const gap = Math.abs((distToStart + distToEnd) - total);
        if (gap < 60 && distToStart <= total + 30) {
            found = { zone: z, total, distToStart };
            break;
        }
    }
    if (found && distanceMeters(currentPos.lat, currentPos.lon, found.zone.start.lat, found.zone.start.lng) < 1000) {
        const pct = Math.min(1, Math.max(0, found.distToStart / found.total));
        showAvgZone(found.zone, pct, kmh);
        activeAvgZone = found.zone;
    } else {
        hideAvgZone();
        activeAvgZone = null;
    }
}

function showAvgZone(zone, pct, kmh) {
    avgZoneBar.classList.remove('hidden');
    avgSpeedVal.textContent = kmh;
    zoneLimitVal.textContent = zone.limit;
    const percent = Math.round(pct * 100);
    progressFill.style.width = `${percent}%`;
    carMarker.style.left = `${percent}%`;

    const over = kmh - zone.limit;
    let fillBg;
    if (over <= 0) fillBg = 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
    else {
        const r = Math.min(255, Math.round((over / zone.limit) * 255 * 1.4));
        const g = Math.max(0, 200 - Math.round((over / zone.limit) * 200));
        fillBg = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
    }
    progressFill.style.background = fillBg;
}

function hideAvgZone() {
    avgZoneBar.classList.add('hidden');
}

// --- ALERT & ERROR ---
function showAlert(text) {
    alertText.textContent = text;
    alertPopup.classList.remove('hidden');
    if (chime) {
        chime.currentTime = 0;
        const playPromise = chime.play();
        if (playPromise && typeof playPromise.then === 'function') playPromise.catch(e => console.warn('Chime play prevented:', e));
    }
    setTimeout(() => alertPopup.classList.add('hidden'), 4000);
}

function showError(text) {
    alertPopup.textContent = text;
    alertPopup.classList.remove('hidden');
}

// --- PiP ---
function setupPiPButton() {
    pipToggle.addEventListener('click', async () => {
        if (!document.pictureInPictureEnabled) {
            alert('PiP not supported');
            return;
        }
        try {
            if (!pipStream) {
                pipStream = pipCanvas.captureStream(25);
                pipVideo.srcObject = pipStream;
                await pipVideo.play();
            }
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                pipToggle.textContent = 'Enable PiP';
                pipEnabled = false;
            } else {
                await pipVideo.requestPictureInPicture();
                pipToggle.textContent = 'Disable PiP';
                pipEnabled = true;
            }
        } catch (err) { console.error('PiP error', err); }
    });
    document.addEventListener('leavepictureinpicture', () => { pipEnabled = false; pipToggle.textContent = 'Enable PiP'; });
    document.addEventListener('enterpictureinpicture', () => { pipEnabled = true; pipToggle.textContent = 'Disable PiP'; });
}

function drawPiP(kmh = 0) {
    if (!currentPos) return;
    renderPipFrame(kmh);
    if (!pipInterval) pipInterval = setInterval(() => renderPipFrame(lastSpeed || 0), 200);
}

function startCanvasLoop() {
    setInterval(() => renderPipFrame(lastSpeed || 0), 300);
}

function renderPipFrame(kmh) {
    const ctx = pipCtx, w = pipCanvas.width, h = pipCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#071021'; ctx.fillRect(0, 0, w, h);

    if (pipEnabled && activeAvgZone) {
        // draw speed tile in PiP
        roundRect(ctx, 20, 50, w - 40, h - 100, 14, '#0b2a33');
        ctx.font = '26px Inter, Arial'; ctx.fillStyle = '#00e5ff';
        ctx.fillText(`${kmh} km/h`, 50, 100);
    }
}

function roundRect(ctx, x, y, width, height, radius, fillStyle) {
    ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius); ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y); ctx.closePath();
    ctx.fillStyle = fillStyle; ctx.fill();
}

// --- INIT ---
init();
