// app.js - RadarNav mobile optimized prototype
// Dependencies: Google Maps JS API, nosleep.js

let map, userMarker;
let radars = [], avgZones = [];
let watchId = null;
let lastSpeed = 0;
let currentPos = null;
let activeAvgZone = null;
let avgZoneData = {};
let pipEnabled = false;
let pipCanvas = document.getElementById('pipCanvas');
let pipCtx = pipCanvas.getContext('2d');
let pipInterval = null;
let alertPopup = document.getElementById('alertPopup');
let speedText = document.getElementById('speedText');
let adminMenu = document.getElementById('adminMenu');

// Enable NoSleep to prevent screen from turning off
let noSleep = new NoSleep();
document.addEventListener('click', () => { noSleep.enable(); }, { once: true });

// Audio alert
const chime = new Audio('assets/chime.mp3');

// Load SCDB and avg zones
async function loadData() {
    try {
        const res = await fetch('SCDB_SpeedCams.json');
        const text = await res.text();

        // Fix JSON: multiple objects separated by newlines -> wrap into array
        const fixedJson = '[' + text.replace(/\}\s*\{/g, '},{') + ']';
        const data = JSON.parse(fixedJson);
        radars = data.filter(cam => cam.lat && cam.lon).map(cam => ({
            lat: cam.lat,
            lon: cam.lon,
            flg: cam.flg,
            unt: cam.unt || 'kmh'
        }));
        console.log(`Loaded ${radars.length} cameras`);

        const z = await fetch('avg_zones.json');
        avgZones = await z.json();
    } catch (err) {
        console.error('Failed to load SCDB or avg zones', err);
        showAlert(`Failed to load data: ${err}`);
    }
}

// Initialize map
function initMap() {
    map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: 0, lng: 0 },
        zoom: 15,
        mapTypeId: 'roadmap',
        rotateControl: true,
        streetViewControl: false,
        fullscreenControl: false,
        mapTypeControl: false
    });

    userMarker = new google.maps.Marker({
        position: { lat: 0, lng: 0 },
        map: map,
        icon: {
            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 6,
            fillColor: '#00e5ff',
            fillOpacity: 1,
            strokeColor: '#00a3b7',
            strokeWeight: 2,
            rotation: 0
        }
    });
}

// Start GPS tracking
function startGeolocation() {
    if (!('geolocation' in navigator)) {
        alert('Geolocation not supported in this browser');
        return;
    }

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
        enableHighAccuracy: true,
        maximumAge: 500,
        timeout: 10000
    });
}

function onGeoError(err) {
    console.warn('Geo error', err);
    showAlert(`Geo error: ${err.message || err}`);
}

// Haversine distance
function distanceMeters(aLat, aLng, bLat, bLng) {
    const R = 6371000;
    const toRad = v => v * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Handle new GPS position
function onPosition(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const speedMps = pos.coords.speed;
    const heading = pos.coords.heading || 0;
    const kmh = speedMps != null ? Math.round(speedMps * 3.6) : lastSpeed;
    lastSpeed = kmh;

    currentPos = { lat, lng, kmh, heading };
    speedText.textContent = `${kmh} km/h`;

    // Center map on user
    map.setCenter({ lat, lng });
    userMarker.setPosition({ lat, lng });
    userMarker.setIcon({
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 6,
        fillColor: '#00e5ff',
        fillOpacity: 1,
        strokeColor: '#00a3b7',
        strokeWeight: 2,
        rotation: heading
    });

    // Filter radars in 10km range
    const nearbyRadars = radars.filter(r => distanceMeters(lat, lng, r.lat, r.lon) <= 10000);
    renderMarkers(nearbyRadars);

    // Alert for radars within 500m in front
    detectRadars(nearbyRadars, lat, lng, heading);

    // Update PiP
    drawPiP(kmh);
}

// Render markers
let radarMarkers = [];
function renderMarkers(cameras) {
    radarMarkers.forEach(m => m.setMap(null));
    radarMarkers = cameras.map(cam => {
        return new google.maps.Marker({
            position: { lat: cam.lat, lng: cam.lon },
            map: map,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: cam.flg === 1 ? 4 : 6,
                fillColor: cam.flg === 1 ? '#ff0' : '#f00',
                fillOpacity: 0.8,
                strokeColor: '#000',
                strokeWeight: 1
            }
        });
    });
}

// Alert popup
let lastAlertTime = 0;
function detectRadars(cameras, lat, lng, heading) {
    const now = Date.now();
    cameras.forEach(cam => {
        const d = distanceMeters(lat, lng, cam.lat, cam.lon);
        if (d <= 500 && now - lastAlertTime > 5000) {
            const angleToCam = Math.atan2(cam.lon - lng, cam.lat - lat) * 180 / Math.PI;
            const deltaAngle = Math.abs(angleToCam - heading);
            if (deltaAngle < 60) { // roughly in front
                showAlert(`${cam.flg===2?'Radar':'Camera'} ahead ${Math.round(d)} m`);
                lastAlertTime = now;
            }
        }
    });
}

// Show alert in center
function showAlert(msg) {
    alertPopup.textContent = msg;
    alertPopup.style.display = 'block';
    if (chime) { chime.currentTime = 0; chime.play().catch(()=>{}); }
    setTimeout(()=>{ alertPopup.style.display='none'; }, 3000);
}

// PiP draw
function drawPiP(kmh) {
    const ctx = pipCtx;
    const w = pipCanvas.width, h = pipCanvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#00e5ff';
    ctx.font = '24px Arial';
    ctx.fillText(`${kmh} km/h`, 20, 50);
}

// Admin menu
document.getElementById('testRadar').addEventListener('click', ()=>showAlert('Test Radar!'));
document.getElementById('testAvg').addEventListener('click', ()=>showAlert('Test Avg Speed!'));
document.getElementById('testAlert').addEventListener('click', ()=>showAlert('Test Alert!'));

// Initialization
async function init() {
    await loadData();
    initMap();
    startGeolocation();
}
init();
// Chunk 2 – Avg zones, PiP updates, mobile optimizations

// Track active avg zone
let activeAvgMarker = null;
let avgProgress = 0;

// Detect average speed zones
function detectAvgZones(lat, lng, kmh) {
    let found = null;
    for (let z of avgZones) {
        const start = z.start, end = z.end;
        const total = distanceMeters(start.lat, start.lng, end.lat, end.lng);
        const distToStart = distanceMeters(start.lat, start.lng, lat, lng);
        const distToEnd = distanceMeters(end.lat, end.lng, lat, lng);
        const gap = Math.abs((distToStart + distToEnd) - total);

        if (gap < 60 && distToStart <= total + 30) {
            found = { zone: z, total, distToStart };
            break;
        }
    }

    if (found) {
        const z = found.zone;
        avgProgress = Math.min(1, Math.max(0, found.distToStart / found.total));
        showAvgZone(z, avgProgress, kmh);
        activeAvgZone = z;
    } else {
        hideAvgZone();
        activeAvgZone = null;
    }
}

// Show average zone bar only during alert
function showAvgZone(zone, pct, kmh) {
    if (!alertPopup.style.display || alertPopup.style.display === 'none') return;
    const avgZoneBar = document.getElementById('avgZoneBar');
    const avgSpeedVal = document.getElementById('avgSpeedVal');
    const zoneLimitVal = document.getElementById('zoneLimitVal');
    const progressFill = document.getElementById('progressFill');
    const carMarker = document.getElementById('carMarker');

    avgZoneBar.style.display = 'block';
    avgSpeedVal.textContent = kmh;
    zoneLimitVal.textContent = zone.limit;

    const percent = Math.round(pct * 100);
    progressFill.style.width = `${percent}%`;
    carMarker.style.left = `${percent}%`;

    const over = kmh - zone.limit;
    let fillBg;
    if (over <= 0) {
        fillBg = 'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
    } else {
        const r = Math.min(255, Math.round((over / zone.limit) * 255 * 1.4));
        const g = Math.max(0, 200 - Math.round((over / zone.limit) * 200));
        fillBg = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
    }
    progressFill.style.background = fillBg;
}

// Hide average speed bar
function hideAvgZone() {
    const avgZoneBar = document.getElementById('avgZoneBar');
    avgZoneBar.style.display = 'none';
}

// PiP optimized drawing using requestAnimationFrame
function drawPiP(kmh = 0) {
    const ctx = pipCtx;
    const w = pipCanvas.width;
    const h = pipCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);

    // Draw alert in PiP if exists
    if (alertPopup.style.display !== 'none') {
        ctx.fillStyle = '#ffd7d7';
        ctx.font = '20px Arial';
        wrapText(ctx, alertPopup.textContent || 'Alert', 10, 30, w - 20, 22);
    } else {
        ctx.fillStyle = '#00e5ff';
        ctx.font = '24px Arial';
        ctx.fillText(`${kmh} km/h`, 20, 50);
    }

    if (!pipInterval) {
        function loop() {
            drawPiP(lastSpeed);
            requestAnimationFrame(loop);
        }
        pipInterval = true;
        loop();
    }
}

// Wrap text helper for PiP
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

// Admin menu toggle
document.getElementById('adminToggle').addEventListener('click', () => {
    const menu = document.getElementById('adminMenu');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
});

// PiP button for mobile
document.getElementById('pipToggle').addEventListener('click', async () => {
    if (!document.pictureInPictureEnabled) return alert('PiP not supported');
    try {
        const pipVideo = document.getElementById('pipVideo');
        if (!pipVideo.srcObject) pipVideo.srcObject = pipCanvas.captureStream(25);
        await pipVideo.play();

        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else {
            await pipVideo.requestPictureInPicture();
        }
    } catch (err) { console.error('PiP error', err); }
});

// Prevent mobile sleep continuously
setInterval(() => { noSleep.enable(); }, 30000);
