// app.js - RadarNav Mobile Full

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

const chime = new Audio('assets/chime.mp3');

let currentPos = null;
let activeAvgZone = null;
let avgZoneData = {};

// Initialize app
async function init() {
    await loadData();
    initMap();
    setupPiPButton();
    startGeolocation();
    startCanvasLoop();
}

// Load SCDB JSON and avg zones
async function loadData() {
    try {
        const res = await fetch('SCDB_SpeedCams.json');
        let text = await res.text();

        // SCDB is not strict JSON, split by lines and parse manually
        let lines = text.split(/\r?\n/).filter(l => l.trim().startsWith('{') && l.includes('lat'));
        radars = lines.map(l => {
            let cam = JSON.parse(l);
            return { lat: cam.lat, lon: cam.lon, flg: cam.flg, unt: cam.unt };
        });
        console.log(`Loaded ${radars.length} cameras`);

        const z = await fetch('avg_zones.json');
        avgZones = await z.json();
    } catch(err) {
        console.error('Failed to load SCDB or avg zones', err);
        showAlert('Failed to load SCDB: '+err.message);
    }
}

// Initialize Leaflet map
function initMap() {
    map = L.map('map', { zoomControl: true }).setView([39.9334,32.8597], 10); // default to Ankara
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    userMarker = L.circleMarker([0,0], { radius:8, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);

    // show radars on map (all for now, will filter by distance later)
    radars.forEach(r => {
        let color = r.flg === 2 ? '#ff0000' : '#ffcc00'; // red for avg, yellow for fixed
        r.marker = L.circle([r.lat,r.lon], { radius: 12, color: color, weight:2 }).addTo(map);
    });

    avgZones.forEach(z => {
        z.line = L.polyline([[z.start.lat,z.start.lng],[z.end.lat,z.end.lng]], { color:'#88f', weight:4, opacity:0.7 }).addTo(map);
    });
}

// Start continuous geolocation
function startGeolocation(){
    if (!('geolocation' in navigator)){
        showAlert('Geolocation not supported');
        return;
    }
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
        enableHighAccuracy: true,
        maximumAge: 500,
        timeout: 10000
    });
}

function onGeoError(err){
    console.warn('Geo error', err);
    showAlert('GPS Error: '+err.message);
}

let lastAlertTime = 0;

// Haversine distance in meters
function distanceMeters(aLat,aLng,bLat,bLng){
    const R = 6371000;
    const toRad = v => v * Math.PI/180;
    const dLat = toRad(bLat-aLat);
    const dLon = toRad(bLng-aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const sinDLat = Math.sin(dLat/2);
    const sinDLon = Math.sin(dLon/2);
    const aa = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
    return R*c;
}

// Position updates
function onPosition(p){
    const lat = p.coords.latitude;
    const lng = p.coords.longitude;
    const speedMps = p.coords.speed;
    const kmh = speedMps==null ? lastSpeed : Math.round(speedMps*3.6);
    lastSpeed = kmh;

    currentPos = {lat,lng,speed:kmh};
    userMarker.setLatLng([lat,lng]);
    map.setView([lat,lng], map.getZoom());

    speedDisplay.textContent = kmh;

    updateRadarMarkers();
    detectRadars(lat,lng);
    detectAvgZones(lat,lng,kmh);
    drawPiP(kmh);
}

// Update radar visibility to 100km radius
function updateRadarMarkers(){
    if(!currentPos) return;
    radars.forEach(r=>{
        const d = distanceMeters(currentPos.lat,currentPos.lon,r.lat,r.lon);
        if(r.marker){
            if(d<=100000){ r.marker.addTo(map); }
            else { map.removeLayer(r.marker); }
        }
    });
}
// Detect nearby radars (<1 km) and show alerts
function detectRadars(lat,lng){
    const now = Date.now();
    radars.forEach(r=>{
        const d = distanceMeters(lat,lng,r.lat,r.lon);
        if(d<1000 && now - lastAlertTime>5000){ // alert only within 1 km
            const type = r.flg===2 ? 'Average' : 'Fixed';
            showAlert(`${type} Radar ahead — ${Math.round(d)} m`, r.flg===2);
            lastAlertTime = now;
        }
    });
}

// Show alert popup
function showAlert(text, showAvg=false){
    alertText.textContent = text;
    alertPopup.classList.remove('hidden');
    if(showAvg){
        avgZoneBar.classList.remove('hidden');
        avgSpeedVal.textContent = lastSpeed;
        zoneLimitVal.textContent = '???'; // optionally use zone limit
        progressFill.style.width = '50%'; // placeholder
        carMarker.style.left = '50%';
    } else {
        avgZoneBar.classList.add('hidden');
    }

    if(chime){
        chime.currentTime=0;
        const playPromise = chime.play();
        if(playPromise && typeof playPromise.then==='function'){
            playPromise.catch(e=>console.warn('Chime prevented:',e));
        }
    }

    clearTimeout(alertPopup._timeout);
    alertPopup._timeout = setTimeout(()=>{
        alertPopup.classList.add('hidden');
        avgZoneBar.classList.add('hidden');
    },4000);
}

// Detect average zones (optional, for avg cameras)
function detectAvgZones(lat,lng,kmh){
    if(!activeAvgZone) return; // simplified, handled via SCDB avg
}

// PiP functionality (speed only until approaching camera)
function setupPiPButton(){
    pipToggle.addEventListener('click', async ()=>{
        if(!document.pictureInPictureEnabled){
            showAlert('PiP not supported');
            return;
        }
        try{
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
        } catch(err){ console.error('PiP error',err);}
    });

    document.addEventListener('leavepictureinpicture',()=>{pipEnabled=false;pipToggle.textContent='Enable PiP';});
    document.addEventListener('enterpictureinpicture',()=>{pipEnabled=true;pipToggle.textContent='Disable PiP';});
}

// Draw PiP frame
function drawPiP(kmh=0){
    // check if any radar within 1 km, else show only speed
    let showFull=false;
    if(currentPos){
        showFull = radars.some(r=>distanceMeters(currentPos.lat,currentPos.lon,r.lat,r.lon)<1000);
    }

    renderPipFrame(kmh,showFull);

    if(!pipInterval){
        pipInterval=setInterval(()=>{ renderPipFrame(lastSpeed,lastAlertTime>0); },200);
    }
}

// Render PiP frame
function renderPipFrame(kmh, showFull=false){
    const ctx = pipCtx, w=pipCanvas.width, h=pipCanvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='#071021';
    ctx.fillRect(0,0,w,h);

    if(showFull && !alertPopup.classList.contains('hidden')){
        roundRect(ctx,10,10,w-20,h-20,18,'#122033');
        ctx.font='22px Inter,Arial'; ctx.fillStyle='#ffd7d7';
        ctx.fillText('🚨',28,58);
        ctx.font='18px Inter,Arial'; ctx.fillStyle='#ffffff';
        wrapText(ctx, alertText.textContent||'Alert',70,48,w-100,22);
    } else {
        roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
        ctx.font='26px Inter,Arial'; ctx.fillStyle='#00e5ff';
        ctx.fillText(`${kmh} km/h`,50,100);
    }
}

// Rounded rect helper
function roundRect(ctx,x,y,width,height,radius,fillStyle){
    ctx.beginPath();
    ctx.moveTo(x+radius,y); ctx.lineTo(x+width-radius,y);
    ctx.quadraticCurveTo(x+width,y,x+width,y+radius);
    ctx.lineTo(x+width,y+height-radius);
    ctx.quadraticCurveTo(x+width,y+height,x+width-radius,y+height);
    ctx.lineTo(x+radius,y+height);
    ctx.quadraticCurveTo(x,y+height,x,y+height-radius);
    ctx.lineTo(x,y+radius); ctx.quadraticCurveTo(x,y,x+radius,y);
    ctx.closePath();
    ctx.fillStyle=fillStyle; ctx.fill();
}

// Wrap text helper
function wrapText(ctx,text,x,y,maxWidth,lineHeight){
    const words = text.split(' '); let line='';
    for(let n=0;n<words.length;n++){
        const testLine=line+words[n]+' ';
        const metrics=ctx.measureText(testLine);
        if(metrics.width>maxWidth && n>0){ctx.fillText(line,x,y); line=words[n]+' '; y+=lineHeight;} 
        else { line=testLine; }
    }
    ctx.fillText(line,x,y);
}

// Keep canvas updated
function startCanvasLoop(){
    setInterval(()=>{ renderPipFrame(lastSpeed,lastAlertTime>0); },300);
}

// Admin menu (3 taps)
let adminTapCount=0, adminTimeout=null;
document.addEventListener('click',()=>{
    adminTapCount++;
    if(adminTapCount>=3){
        document.getElementById('adminMenu').classList.toggle('hidden');
        adminTapCount=0;
    }
    clearTimeout(adminTimeout);
    adminTimeout=setTimeout(()=>{adminTapCount=0;},1000);
});

// Prevent screen sleep
if('wakeLock' in navigator){
    let wakeLock=null;
    async function requestWakeLock(){
        try{ wakeLock = await navigator.wakeLock.request('screen'); }
        catch(e){ console.warn('WakeLock failed',e); }
    }
    requestWakeLock();
    document.addEventListener('visibilitychange', ()=>{if(!wakeLock) requestWakeLock();});
}

init();
