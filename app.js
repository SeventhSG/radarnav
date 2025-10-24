// app.js
import NoSleep from './nosleep.js';
const noSleep = new NoSleep();
noSleep.enable();

// --- Global variables ---
let map, userMarker;
let radars = [], avgZones = [];
let watchId = null;
let lastSpeed = 0;
let currentHeading = 0;
let currentPos = null;
let pipEnabled = false;
let pipVideo = document.getElementById('pipVideo');
let pipCanvas = document.getElementById('pipCanvas');
let pipCtx = pipCanvas.getContext('2d');
let pipStream = null;
let pipInterval = null;
let activeAvgZone = null;
let alertCooldown = 0;

// UI elements
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

// --- Initialization ---
async function init() {
    await loadData();
    initMap();
    setupPiP();
    setupAdminMenu();
    startGeolocation();
    startCanvasLoop();
}

// --- Load SCDB data ---
async function loadData() {
    try {
        const res = await fetch('SCDB_SpeedCams.json');
        const text = await res.text();

        // Parse line-by-line JSON
        radars = [];
        text.split(/\r?\n/).forEach(line => {
            try {
                const obj = JSON.parse(line);
                if (obj.lat && obj.lon) radars.push(obj);
            } catch(e){ /* ignore invalid lines */ }
        });
        console.log(`Loaded ${radars.length} cameras`);

        const z = await fetch('avg_zones.json');
        avgZones = await z.json();
        console.log(`Loaded ${avgZones.length} average speed zones`);
    } catch(err) {
        showError(`Data load error: ${err}`);
        console.error(err);
    }
}

// --- Initialize Leaflet map ---
function initMap() {
    map = L.map('map', { zoomControl: true }).setView([0,0], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution:'&copy; OpenStreetMap contributors'
    }).addTo(map);

    userMarker = L.marker([0,0], {icon: L.divIcon({className:'user-marker'})}).addTo(map);
}

// --- Geolocation ---
function startGeolocation() {
    if(!('geolocation' in navigator)) {
        showError('Geolocation not supported');
        return;
    }

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
        enableHighAccuracy:true,
        maximumAge:500,
        timeout:10000
    });
}

function onGeoError(err) {
    showError(`Geo error: ${err.message}`);
}

function onPosition(p) {
    const lat = p.coords.latitude;
    const lng = p.coords.longitude;
    const speedMps = p.coords.speed;
    const heading = p.coords.heading;

    currentPos = { lat, lng, speedMps, heading };
    lastSpeed = speedMps ? Math.round(speedMps*3.6) : lastSpeed;
    currentHeading = heading || currentHeading;

    speedDisplay.textContent = `${lastSpeed} km/h`;

    map.setView([lat, lng], map.getZoom(), {animate:true});

    if(userMarker) {
        userMarker.setLatLng([lat,lng]);
        userMarker.setRotationAngle(currentHeading || 0);
    }

    updateRadars();
    updateAvgZones();
    drawPiP(lastSpeed);
}

// --- PiP setup ---
function setupPiP() {
    pipToggle.addEventListener('click', async () => {
        if(!document.pictureInPictureEnabled){
            alert('PiP not supported');
            return;
        }

        try {
            if(!pipStream) {
                pipStream = pipCanvas.captureStream(25);
                pipVideo.srcObject = pipStream;
                await pipVideo.play();
            }

            if(document.pictureInPictureElement){
                await document.exitPictureInPicture();
                pipToggle.textContent = 'Enable PiP';
                pipEnabled=false;
            } else {
                await pipVideo.requestPictureInPicture();
                pipToggle.textContent='Disable PiP';
                pipEnabled=true;
            }
        } catch(err){
            showError(`PiP error: ${err}`);
        }
    });
}

// --- Display errors on screen ---
function showError(msg){
    alertText.textContent = msg;
    alertPopup.classList.add('show');
    setTimeout(()=>alertPopup.classList.remove('show'),5000);
}
// --- Distance helper (meters) ---
function distanceMeters(lat1, lon1, lat2, lon2){
    const R = 6371000;
    const toRad = v => v*Math.PI/180;
    const dLat = toRad(lat2-lat1);
    const dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R*c;
}

// --- Update radars ---
function updateRadars(){
    if(!currentPos) return;
    const {lat,lng,heading} = currentPos;

    // Filter radars within 10km
    const nearby = radars.filter(r=>{
        const d = distanceMeters(lat,lng,r.lat,r.lon);
        return d<=10000;
    });

    // Remove old markers
    if(map.radarMarkers) map.radarMarkers.forEach(m=>map.removeLayer(m));
    map.radarMarkers=[];

    nearby.forEach(r=>{
        const marker = L.circle([r.lat,r.lon],{
            radius:50,
            color:r.flg===1?'#00ff00':'#ff0000',
            weight:2,
            opacity:0.7
        }).addTo(map);
        map.radarMarkers.push(marker);

        // Alert if within 1km ahead
        const d = distanceMeters(lat,lng,r.lat,r.lon);
        if(d<1000 && Date.now()-alertCooldown>5000){
            showRadarAlert(r,d);
            alertCooldown = Date.now();
        }
    });
}

// --- Show radar alert ---
function showRadarAlert(radar,d){
    const distanceText = `${Math.round(d)} m`;
    alertText.textContent = `🚨 Radar ahead! ${distanceText}`;
    alertPopup.classList.add('show');

    if(chime){
        chime.currentTime=0;
        const p=chime.play();
        if(p && typeof p.then==='function') p.catch(()=>{});
    }

    // Auto-hide after 4s
    setTimeout(()=>alertPopup.classList.remove('show'),4000);
}

// --- Update average speed zones ---
function updateAvgZones(){
    if(!currentPos) return;
    const {lat,lng,speedMps} = currentPos;
    const kmh = speedMps ? Math.round(speedMps*3.6) : lastSpeed;

    let active=null;
    avgZones.forEach(z=>{
        const total = distanceMeters(z.start.lat,z.start.lon,z.end.lat,z.end.lon);
        const distToStart = distanceMeters(z.start.lat,z.start.lon,lat,lng);
        const distToEnd = distanceMeters(z.end.lat,z.end.lon,lat,lng);
        const gap = Math.abs(distToStart+distToEnd-total);
        if(gap<60 && distToStart<=total+30) active={z,total,distToStart};
    });

    if(active){
        activeAvgZone=active.z;
        const pct=Math.min(1,Math.max(0,active.distToStart/active.total));
        showAvgZone(active.z,pct,kmh);
    }else{
        hideAvgZone();
        activeAvgZone=null;
    }
}

// --- Show average speed progress ---
function showAvgZone(zone,pct,kmh){
    avgZoneBar.style.display='flex';
    avgSpeedVal.textContent=kmh;
    zoneLimitVal.textContent=zone.limit;

    const percent=Math.round(pct*100);
    progressFill.style.width=`${percent}%`;
    carMarker.style.left=`${percent}%`;

    const over=kmh-zone.limit;
    let fillBg;
    if(over<=0) fillBg='linear-gradient(90deg,rgba(0,229,255,0.2),rgba(0,229,255,0.6))';
    else {
        const r=Math.min(255,Math.round((over/zone.limit)*255*1.4));
        const g=Math.max(0,200-Math.round((over/zone.limit)*200));
        fillBg=`linear-gradient(90deg,rgba(${r},${g},60,0.25),rgba(${r},${g},60,0.7))`;
    }
    progressFill.style.background=fillBg;
}

function hideAvgZone(){
    avgZoneBar.style.display='none';
}

// --- PiP rendering ---
function drawPiP(kmh=0){
    const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='#071021';
    ctx.fillRect(0,0,w,h);

    // Show speed only until near radar
    let showAlertCard=false;
    if(activeAvgZone || (radars.some(r=>{
        if(!currentPos) return false;
        const d=distanceMeters(currentPos.lat,currentPos.lng,r.lat,r.lon);
        return d<1000;
    }))) showAlertCard=true;

    if(showAlertCard){
        roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
        ctx.font='26px Inter, Arial';
        ctx.fillStyle='#00e5ff';
        ctx.fillText(`${kmh} km/h`,50,100);
    }
}

// --- Rounded rect helper ---
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

// --- Canvas loop ---
function startCanvasLoop(){
    setInterval(()=>drawPiP(lastSpeed),300);
}

// --- Admin triple-tap menu ---
function setupAdminMenu(){
    let tapCount=0,lastTap=0;
    document.body.addEventListener('touchend',e=>{
        const now=Date.now();
        if(now-lastTap<500) tapCount++;
        else tapCount=1;
        lastTap=now;

        if(tapCount>=3){
            showAdminMenu();
            tapCount=0;
        }
    });
}

function showAdminMenu(){
    const msg=prompt('Admin Menu:\n1. Test Radar Alert\n2. Test Avg Speed Alert\n3. Test PiP Speed');
    if(!msg) return;
    switch(msg){
        case '1':
            showRadarAlert({lat:0,lon:0,label:'Test Radar'},500);
            break;
        case '2':
            showAvgZone({limit:50},{pct:0.5},60);
            break;
        case '3':
            drawPiP(80);
            break;
    }
}

// --- Start ---
init();
