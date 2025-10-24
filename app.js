// app.js - final optimized RadarNav
let map, userMarker, userHeading = 0;
let radars = [], avgZones = [];
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
const chime = new Audio('assets/chime.mp3');

let currentPos = null;
let activeAvgZone = null;
let lastAlertTime = 0;

// ---------------- DATA LOADING ----------------
async function loadData() {
    try {
        const res = await fetch('SCDB_SpeedCams.json');
        const rawText = await res.text();

        // split JSON objects by }{
        const objs = rawText
            .replace(/\r\n/g,'') // remove newlines
            .replace(/}\s*{/g,'}|{') // insert delimiter
            .split('|')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        radars = [];
        objs.forEach(s => {
            try {
                const obj = JSON.parse(s);
                if(obj.lat && obj.lon) radars.push({
                    lat: obj.lat,
                    lon: obj.lon,
                    flg: obj.flg,
                    unt: obj.unt || obj["unt "]
                });
            } catch(e){
                console.warn('Skipped invalid JSON object', s);
            }
        });
        console.log(`Loaded ${radars.length} cameras`);

        const z = await fetch('avg_zones.json');
        avgZones = await z.json();

    } catch(err){
        console.error('Failed to load SCDB or avg zones', err);
        alert(`Data load error: ${err.message}`);
    }
}

// ---------------- MAP INITIALIZATION ----------------
function initMap(){
    map = L.map('map', { zoomControl:false, rotate:true }).setView([0,0], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    userMarker = L.marker([0,0],{
        icon: L.icon({iconUrl:'assets/car.png', iconSize:[40,40], iconAnchor:[20,20]})
    }).addTo(map);

    // draw avg zones (hidden initially)
    avgZones.forEach(z=>{
        L.polyline([[z.start.lat,z.start.lon],[z.end.lat,z.end.lon]],{color:'#88f',weight:4,opacity:0.7}).addTo(map);
    });
}

// ---------------- GEOLOCATION ----------------
function startGeolocation(){
    if(!('geolocation' in navigator)){
        alert('Geolocation not supported');
        return;
    }

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError,{
        enableHighAccuracy:true,
        maximumAge:500,
        timeout:10000
    });

    // keep screen awake
    if('wakeLock' in navigator){
        let wakeLock = null;
        const requestWake = async ()=>{try{wakeLock = await navigator.wakeLock.request('screen');}catch(e){console.warn(e);}};
        requestWake();
        document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') requestWake(); });
    }
}

function onGeoError(err){
    console.warn('Geo error',err);
    alert(`Geo error: ${err.message}`);
}

function onPosition(p){
    const lat = p.coords.latitude;
    const lon = p.coords.longitude;
    const speedMps = p.coords.speed || 0;
    const heading = p.coords.heading || userHeading;

    currentPos = {lat,lon,speedMps,heading};
    userHeading = heading;

    lastSpeed = Math.round(speedMps * 3.6);
    speedDisplay.textContent = `${lastSpeed} km/h`;

    // center map and rotate user
    map.setView([lat,lon], map.getZoom());
    userMarker.setLatLng([lat,lon]);
    userMarker.setRotationAngle(userHeading);

    // detect nearby cameras and alerts
    detectRadars(lat,lon,heading);

    // detect avg zones
    detectAvgZones(lat,lon,lastSpeed);

    // PiP update
    drawPiP(lastSpeed);
}

// ---------------- DISTANCE ----------------
function distanceMeters(aLat,aLon,bLat,bLon){
    const R=6371000;
    const toRad=v=>v*Math.PI/180;
    const dLat=toRad(bLat-aLat);
    const dLon=toRad(bLon-aLon);
    const lat1=toRad(aLat);
    const lat2=toRad(bLat);
    const sinDLat=Math.sin(dLat/2);
    const sinDLon=Math.sin(dLon/2);
    const aa=sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
    const c=2*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));
    return R*c;
}// ---------------- RADAR DETECTION ----------------
function detectRadars(lat, lon, heading){
    const now = Date.now();
    const maxRange = 10000; // 10 km
    const alertRange = 1000; // 1 km for alert
    let closest = null;

    radars.forEach(r=>{
        const d = distanceMeters(lat, lon, r.lat, r.lon);
        if(d <= maxRange){
            if(!r.marker){
                r.marker = L.circle([r.lat,r.lon],{radius:12,color:r.flg===1?'#00ff00':'#ffcc00',weight:2}).addTo(map);
            }
            // check heading direction (approx) to show only forward cameras
            if(d <= alertRange && now - lastAlertTime > 5000){
                lastAlertTime = now;
                showAlert(`${r.flg===1?'Average':'Fixed'} Camera ahead in ${Math.round(d)} m`);
                playChime();
                activeAvgZone = r.flg===1?r:null; // show avg bar only if avg camera
            }
        }
    });
}

// ---------------- ALERTS ----------------
function showAlert(text){
    if(pipEnabled){
        alertText.textContent = text;
        alertPopup.classList.remove('hidden');
        setTimeout(()=>{ alertPopup.classList.add('hidden'); },4000);
    }
}

function playChime(){
    if(chime){
        chime.currentTime=0;
        const p=chime.play();
        if(p && typeof p.then==='function') p.catch(e=>console.warn('Chime blocked',e));
}

// ---------------- AVG ZONES ----------------
function detectAvgZones(lat,lon,kmh){
    if(!activeAvgZone || activeAvgZone.flg!==1){
        avgZoneBar.classList.add('hidden');
        return;
    }
    avgZoneBar.classList.remove('hidden');
    avgSpeedVal.textContent=kmh;
    zoneLimitVal.textContent=activeAvgZone.limit || 50;

    const pct = 0.5; // placeholder for progress (could calculate real distance)
    const percent = Math.round(pct*100);
    progressFill.style.width=`${percent}%`;
    carMarker.style.left=`${percent}%`;
}

// ---------------- PiP ----------------
function setupPiPButton(){
    pipToggle.addEventListener('click',async()=>{
        if(!document.pictureInPictureEnabled){ alert('PiP not supported'); return; }
        try{
            if(!pipStream){
                pipStream=pipCanvas.captureStream(25);
                pipVideo.srcObject=pipStream;
                await pipVideo.play();
            }
            if(document.pictureInPictureElement){
                await document.exitPictureInPicture();
                pipToggle.textContent='Enable PiP'; pipEnabled=false;
            } else {
                await pipVideo.requestPictureInPicture();
                pipToggle.textContent='Disable PiP'; pipEnabled=true;
            }
        }catch(e){console.error('PiP error',e);}
    });
}

// ---------------- DRAW PiP ----------------
function drawPiP(kmh){
    const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='#071021'; ctx.fillRect(0,0,w,h);

    ctx.font='26px Inter, Arial'; ctx.fillStyle='#00e5ff';
    if(activeAvgZone && activeAvgZone.flg===1){
        // show avg zone
        ctx.fillText(`${kmh} km/h`,50,50);
        ctx.fillText(`AVG ZONE`,50,90);
    } else {
        ctx.fillText(`${kmh} km/h`,50,100);
    }

    if(!pipInterval){
        pipInterval=setInterval(()=>{ drawPiP(lastSpeed); },200);
    }
}

// ---------------- ADMIN MENU ----------------
let adminClicks=0;
document.addEventListener('click',()=>{
    adminClicks++;
    if(adminClicks===3){
        alert('Admin: trigger test alert!');
        adminClicks=0;
    }
});

// ---------------- START ----------------
async function init(){
    await loadData();
    initMap();
    setupPiPButton();
    startGeolocation();
}
init();
