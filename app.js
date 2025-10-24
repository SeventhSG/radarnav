// app.js - RadarNav Mobile v2
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

const alertPopup = document.getElementById('alertPopup');
const alertText = document.getElementById('alertText');
const avgZoneBar = document.getElementById('avgZoneBar');
const avgSpeedVal = document.getElementById('avgSpeedVal');
const zoneLimitVal = document.getElementById('zoneLimitVal');
const progressFill = document.getElementById('progressFill');
const carMarker = document.getElementById('carMarker');
const speedDisplay = document.getElementById('speedDisplay');
const pipToggle = document.getElementById('pipToggle');

// Chime alert
const chime = new Audio('assets/chime.mp3');

let currentPos = null;
let activeAvgZone = null;

// Load SCDB and avg zones
async function loadData() {
    try {
        const res = await fetch('SCDB_SpeedCams.json');
        const data = await res.json();
        radars = data.map(cam => ({
            lat: cam.lat,
            lon: cam.lon,
            flg: cam.flg,
            unt: cam.unt,
            type: cam.flg===2 ? 'fixed' : 'avg' // example type
        }));
        console.log(`Loaded ${radars.length} cameras`);

        const z = await fetch('avg_zones.json');
        avgZones = await z.json();
    } catch(err) {
        console.error('Failed to load SCDB', err);
        showAlert('Failed to load SCDB data!');
    }
}

// Initialize map
function initMap() {
    map = L.map('map', { zoomControl: true }).setView([0,0], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    userMarker = L.circleMarker([0,0], { radius: 8, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity: 1 }).addTo(map);
}

// Start geolocation
function startGeolocation() {
    if (!('geolocation' in navigator)) {
        alert('Geolocation not supported');
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
    showAlert('Unable to get location!');
}

// Compute distance in meters
function distanceMeters(aLat, aLng, bLat, bLng){
    const R = 6371000;
    const toRad = v => v * Math.PI/180;
    const dLat = toRad(bLat-aLat);
    const dLon = toRad(bLng-aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}
let lastAlertTime = 0;
const CAMERA_SHOW_RADIUS = 10000; // 10 km
const ALERT_RADIUS = 1000; // 1 km

function onPosition(p){
    const lat = p.coords.latitude;
    const lng = p.coords.longitude;
    const speedMps = p.coords.speed;
    const timestamp = p.timestamp;

    currentPos = { lat, lng, speedMps, timestamp };

    // Center map on first fix or update marker
    if (!userMarker) initMap();
    map.setView([lat, lng], 13);
    userMarker.setLatLng([lat, lng]);

    let kmh = speedMps == null ? lastSpeed : Math.round(speedMps*3.6);
    lastSpeed = kmh;
    speedDisplay.textContent = `${kmh} km/h`;

    // Filter and show cameras within 10 km
    showNearbyCameras(lat, lng);

    // Alert only when approaching 1 km on your road/direction
    detectApproachingCameras(lat, lng, kmh);

    // PiP: show speed only until approaching a camera
    drawPiP(kmh, approachingCamera = isApproachingCamera(lat,lng));
}

// Show markers only for nearby cameras
function showNearbyCameras(lat, lng){
    map.eachLayer(l => { if(l.options && l.options.cameraMarker) map.removeLayer(l); });

    radars.forEach(r => {
        const d = distanceMeters(lat, lng, r.lat, r.lon);
        if(d <= CAMERA_SHOW_RADIUS){
            const marker = L.circleMarker([r.lat, r.lon], {
                radius: 8,
                color: r.type==='avg' ? '#88f' : '#ffcc00',
                fillOpacity: 0.7
            });
            marker.addTo(map);
            marker.options.cameraMarker = true;
        }
    });
}

// Detect if camera is approaching
function detectApproachingCameras(lat, lng, kmh){
    const now = Date.now();
    radars.forEach(r => {
        const d = distanceMeters(lat, lng, r.lat, r.lon);
        if(d <= ALERT_RADIUS && now - lastAlertTime > 5000){
            if(isOnSameRoad(lat, lng, r.lat, r.lon)){
                showAlert(`${r.type==='avg' ? 'Average' : 'Fixed'} Radar ahead — ${Math.round(d)} m`);
                lastAlertTime = now;
            }
        }
    });
}

// Dummy directional check (replace with real road/direction logic)
function isOnSameRoad(lat1, lng1, lat2, lng2){
    // Simple approximation: camera roughly in front of movement
    // Could be enhanced with heading if available
    return true; // for now, assume always on the road
}

// PiP frame rendering
function drawPiP(kmh, approachingCamera = false){
    const ctx = pipCtx;
    const w = pipCanvas.width;
    const h = pipCanvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#071021';
    ctx.fillRect(0,0,w,h);

    if(approachingCamera){
        // Show alert frame with speed
        roundRect(ctx, 10,10,w-20,h-20,18,'#122033');
        ctx.font='22px Inter, Arial';
        ctx.fillStyle='#ffd7d7';
        ctx.fillText('🚨 Approaching Camera', 28,58);
        ctx.font='26px Inter, Arial';
        ctx.fillStyle='#00e5ff';
        ctx.fillText(`${kmh} km/h`, 50, 100);
    } else {
        // Show just speed
        roundRect(ctx, 20,50,w-40,h-100,14,'#0b2a33');
        ctx.font='26px Inter, Arial';
        ctx.fillStyle='#00e5ff';
        ctx.fillText(`${kmh} km/h`, 50,100);
    }
}

// Rounded rectangle helper
function roundRect(ctx,x,y,width,height,radius,fillStyle){
    ctx.beginPath();
    ctx.moveTo(x+radius,y);
    ctx.lineTo(x+width-radius,y);
    ctx.quadraticCurveTo(x+width,y,x+width,y+radius);
    ctx.lineTo(x+width,y+height-radius);
    ctx.quadraticCurveTo(x+width,y+height,x+width-radius,y+height);
    ctx.lineTo(x+radius,y+height);
    ctx.quadraticCurveTo(x,y+height,x,y+height-radius);
    ctx.lineTo(x,y+radius);
    ctx.quadraticCurveTo(x,y,x+radius,y);
    ctx.closePath();
    ctx.fillStyle=fillStyle;
    ctx.fill();
}

// PiP setup
function setupPiPButton(){
    pipToggle.addEventListener('click', async () => {
        if(!document.pictureInPictureEnabled){
            alert('PiP not supported');
            return;
        }
        try {
            if(!pipStream){
                pipStream = pipCanvas.captureStream(25);
                pipVideo.srcObject = pipStream;
                await pipVideo.play();
            }
            if(document.pictureInPictureElement){
                await document.exitPictureInPicture();
                pipToggle.textContent='Enable PiP';
                pipEnabled=false;
            } else {
                await pipVideo.requestPictureInPicture();
                pipToggle.textContent='Disable PiP';
                pipEnabled=true;
            }
        } catch(e){ console.error('PiP error', e); }
    });
    document.addEventListener('leavepictureinpicture',()=>{pipEnabled=false; pipToggle.textContent='Enable PiP';});
    document.addEventListener('enterpictureinpicture',()=>{pipEnabled=true; pipToggle.textContent='Disable PiP';});
}

// Start everything
async function init(){
    await loadData();
    initMap();
    setupPiPButton();
    startGeolocation();
    setInterval(()=>{ drawPiP(lastSpeed, isApproachingCamera(currentPos?.lat,currentPos?.lng)); }, 300);
}

init();
