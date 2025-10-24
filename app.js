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

// chime alert
const chime = new Audio('assets/chime.mp3'); 

let currentPos = null;
let activeAvgZone = null;
let visibleRadars = [];

async function init() {
    await loadData();
    initMap();
    setupPiPButton();
    startGeolocation();
    startCanvasLoop();
}

// Load SCDB and average zones
async function loadData(){
    try{
        const res = await fetch('SCDB_SpeedCams.json');
        const data = await res.text();

        // Fix SCDB formatting: split multiple JSON objects
        const cams = data.split(/\r?\n/).filter(l=>l.trim().startsWith("{lat"));
        radars = cams.map(line => JSON.parse(line));
        console.log(`Loaded ${radars.length} cameras`);

        const z = await fetch('avg_zones.json');
        avgZones = await z.json();
    } catch(err){
        showError(`Failed to load SCDB or avg zones: ${err}`);
    }
}

// Display errors on screen
function showError(msg){
    const errorDiv = document.getElementById('errorDiv');
    if(errorDiv){
        errorDiv.textContent = msg;
        errorDiv.classList.remove('hidden');
    }
    console.error(msg);
}

// Initialize Leaflet map
function initMap(){
    map = L.map('map', { zoomControl:false }).setView([39.0,35.0], 6); // default Turkey center
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution:'&copy; OpenStreetMap contributors'
    }).addTo(map);

    userMarker = L.circleMarker([0,0], { radius:8, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);
}

// Start GPS tracking
function startGeolocation(){
    if(!('geolocation' in navigator)){ alert('Geolocation not supported'); return; }
    watchId = navigator.geolocation.watchPosition(onPosition,onGeoError,{
        enableHighAccuracy:true,
        maximumAge:500,
        timeout:10000
    });
}

function onGeoError(err){ showError(`Geo error: ${err.message}`); }

// Haversine distance in meters
function distanceMeters(aLat,aLng,bLat,bLng){
    const R=6371000,toRad=v=>v*Math.PI/180;
    const dLat = toRad(bLat-aLat), dLon=toRad(bLng-aLng);
    const lat1 = toRad(aLat), lat2=toRad(bLat);
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// PiP setup
function setupPiPButton(){
    pipToggle.addEventListener('click', async ()=>{
        if(!document.pictureInPictureEnabled){ alert('PiP not supported'); return; }
        try{
            if(!pipStream){
                pipStream = pipCanvas.captureStream(25);
                pipVideo.srcObject = pipStream;
                await pipVideo.play();
            }
            if(document.pictureInPictureElement){
                await document.exitPictureInPicture();
                pipToggle.textContent='Enable PiP'; pipEnabled=false;
            }else{
                await pipVideo.requestPictureInPicture();
                pipToggle.textContent='Disable PiP'; pipEnabled=true;
            }
        }catch(err){ showError(`PiP error: ${err}`);}
    });
    document.addEventListener('leavepictureinpicture',()=>{ pipEnabled=false; pipToggle.textContent='Enable PiP'; });
    document.addEventListener('enterpictureinpicture',()=>{ pipEnabled=true; pipToggle.textContent='Disable PiP'; });
}

// Update canvas
function startCanvasLoop(){
    setInterval(()=>{ renderPipFrame(lastSpeed||0); }, 300);
}
function onPosition(p){
    const lat = p.coords.latitude;
    const lng = p.coords.longitude;
    const speedMps = p.coords.speed;
    const kmh = speedMps == null ? lastSpeed : Math.round(speedMps * 3.6);
    lastSpeed = kmh;

    currentPos = {lat,lng,speedMps,kmh};

    map.setView([lat,lng], map.getZoom());
    userMarker.setLatLng([lat,lng]);

    // Filter radars within 100 km
    visibleRadars = radars.filter(r => distanceMeters(lat,lng,r.lat,r.lon)<=100000);

    updateRadarMarkers();
    detectApproachingRadar(lat,lng);
    detectAvgZones(lat,lng,kmh);
    drawPiP(kmh);
}

// Draw radar markers dynamically
let radarMarkers = [];
function updateRadarMarkers(){
    // clear previous markers
    radarMarkers.forEach(m=>map.removeLayer(m));
    radarMarkers=[];

    visibleRadars.forEach(r=>{
        const marker = L.circle([r.lat,r.lon],{
            radius:200, // 200m radius visible marker
            color:r.flg==2?'#ff6600':'#00ff66', // different for fixed vs average
            weight:2
        }).addTo(map);
        radarMarkers.push(marker);
    });
}

// Detect approaching radars (<1 km)
let lastRadarAlertTime=0;
function detectApproachingRadar(lat,lng){
    const now = Date.now();
    visibleRadars.forEach(r=>{
        const d = distanceMeters(lat,lng,r.lat,r.lon);
        if(d<=1000 && now-lastRadarAlertTime>5000){ // 1 km alert, 5s throttle
            showAlert(`${r.flg==2?'Radar':'Average Camera'} ahead — ${Math.round(d)} m`);
            lastRadarAlertTime=now;
        }
    });
}

// Show alert popup
function showAlert(text){
    alertText.textContent=text;
    alertPopup.classList.remove('hidden');

    // play chime
    if(chime){
        chime.currentTime=0;
        const playPromise = chime.play();
        if(playPromise && typeof playPromise.then==='function'){
            playPromise.catch(e=>console.warn('Chime play prevented:',e));
        }
    }

    // hide after 4s
    clearTimeout(alertPopup._timeout);
    alertPopup._timeout=setTimeout(()=>{ alertPopup.classList.add('hidden'); },4000);
}

// Average speed zone detection
function detectAvgZones(lat,lng,kmh){
    let active=null;
    for(let z of avgZones){
        const total=distanceMeters(z.start.lat,z.start.lng,z.end.lat,z.end.lng);
        const distToStart=distanceMeters(z.start.lat,z.start.lng,lat,lng);
        const distToEnd=distanceMeters(z.end.lat,z.end.lng,lat,lng);
        if(Math.abs(distToStart+distToEnd-total)<60 && distToStart<=total+30){
            active={zone:z,total,distToStart}; break;
        }
    }

    if(active && active.zone.flg==1){ // show progress only for average speed cameras
        const pct=Math.min(1,Math.max(0,active.distToStart/active.total));
        showAvgZone(active.zone,pct,kmh);
        activeAvgZone=active.zone;
    }else{
        hideAvgZone();
        activeAvgZone=null;
    }
}

function showAvgZone(zone,pct,kmh){
    avgZoneBar.classList.remove('hidden');
    avgSpeedVal.textContent=kmh;
    zoneLimitVal.textContent=zone.limit;

    const percent=Math.round(pct*100);
    progressFill.style.width=`${percent}%`;
    carMarker.style.left=`${percent}%`;

    // color ramp
    const over=kmh-zone.limit;
    let fillBg;
    if(over<=0){ fillBg='linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))'; }
    else{
        const r=Math.min(255,Math.round((over/zone.limit)*255*1.4));
        const g=Math.max(0,200-Math.round((over/zone.limit)*200));
        fillBg=`linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
    }
    progressFill.style.background=fillBg;
}

function hideAvgZone(){ avgZoneBar.classList.add('hidden'); }

// PiP: show only speed until <1 km from radar, else show alert
function drawPiP(kmh){
    const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='#071021'; ctx.fillRect(0,0,w,h);

    let radarNearby = visibleRadars.some(r=>distanceMeters(currentPos.lat,currentPos.lng,r.lat,r.lon)<1000);

    if(radarNearby && !alertPopup.classList.contains('hidden')){
        // show alert in PiP
        roundRect(ctx, 10,10,w-20,h-20,18,'#122033');
        ctx.font='22px Inter, Arial'; ctx.fillStyle='#ffd7d7';
        ctx.fillText('🚨',28,58);
        ctx.font='18px Inter, Arial'; ctx.fillStyle='#ffffff';
        wrapText(ctx,alertText.textContent||'Alert',70,48,w-100,22);
    }else{
        // show speed only
        roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
        ctx.font='26px Inter, Arial'; ctx.fillStyle='#00e5ff';
        ctx.fillText(`${kmh} km/h`,50,100);
    }

    if(!pipInterval){
        pipInterval=setInterval(()=>{ drawPiP(lastSpeed||0); },200);
    }
}

// small helper: rounded rect
function roundRect(ctx,x,y,width,height,radius,fillStyle){
    ctx.beginPath();
    ctx.moveTo(x+radius,y); ctx.lineTo(x+width-radius,y);
    ctx.quadraticCurveTo(x+width,y,x+width,y+radius);
    ctx.lineTo(x+width,y+height-radius);
    ctx.quadraticCurveTo(x+width,y+height,x+width-radius,y+height);
    ctx.lineTo(x+radius,y+height);
    ctx.quadraticCurveTo(x,y+height,x,y+height-radius);
    ctx.lineTo(x,y+radius);
    ctx.quadraticCurveTo(x,y,x+radius,y);
    ctx.closePath(); ctx.fillStyle=fillStyle; ctx.fill();
}

// wrapText helper
function wrapText(ctx,text,x,y,maxWidth,lineHeight){
    const words=text.split(' '); let line='';
    for(let n=0;n<words.length;n++){
        const testLine=line+words[n]+' ';
        const metrics=ctx.measureText(testLine);
        const testWidth=metrics.width;
        if(testWidth>maxWidth && n>0){ ctx.fillText(line,x,y); line=words[n]+' '; y+=lineHeight; }
        else{ line=testLine; }
    }
    ctx.fillText(line,x,y);
}

init();
