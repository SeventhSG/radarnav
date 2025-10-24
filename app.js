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

let radarMarkers = [];
let activeAvgZone = null;
let currentPos = null;

// --- Load SCDB JSON ---
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    let rawText = await res.text();
    // Fix SCDB JSON if multiple objects concatenated
    rawText = rawText.replace(/}\s*{/g,'},{');
    const data = JSON.parse(`[${rawText}]`);
    radars = data.map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,   // 1=fixed, 2=average
      unt: cam.unt
    }));
    console.log(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch (err) {
    console.error('Failed to load SCDB', err);
    showAlert(`Failed to load SCDB: ${err}`);
  }
}

// --- Initialize Leaflet Map ---
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([39.0, 35.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0,0], { radius: 8, color: '#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);
}

// --- Geolocation ---
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

function onGeoError(err) { console.warn('Geo error', err); }

function onPosition(p) {
  const lat = p.coords.latitude;
  const lng = p.coords.longitude;
  const speedMps = p.coords.speed;
  const kmh = speedMps == null ? lastSpeed : Math.round(speedMps * 3.6);
  lastSpeed = kmh;
  speedDisplay.textContent = `${kmh} km/h`;

  currentPos = { lat, lng };
  map.setView([lat, lng], map.getZoom());
  userMarker.setLatLng([lat, lng]);

  updateRadarMarkers();
  detectRadars(lat, lng);
  detectAvgZones(lat, lng, kmh);
  drawPiP(kmh);

  // prevent mobile screen from sleeping
  if (window.AndroidKeepAwake) window.AndroidKeepAwake();
}

// --- Distance helper ---
function distanceMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = v => v * Math.PI/180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLng - aLng);
  const lat1 = toRad(aLat), lat2 = toRad(bLat);
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- Update radar markers only within 100km ---
function updateRadarMarkers() {
  if (!currentPos) return;
  // Remove old markers
  radarMarkers.forEach(m => map.removeLayer(m));
  radarMarkers = [];

  radars.forEach(r => {
    const d = distanceMeters(currentPos.lat, currentPos.lon, r.lat, r.lon)/1000; // km
    if (d <= 100) {
      const color = r.flg===1 ? '#ffcc00':'#88f'; // fixed=yellow, avg=blue
      const m = L.circle([r.lat, r.lon], { radius: 200, color, weight: 2 }).addTo(map);
      radarMarkers.push(m);
    }
  });
}

// --- Detect radars ahead ---
let lastAlertTime = 0;
function detectRadars(lat, lng) {
  const now = Date.now();
  radars.forEach(r => {
    const d = distanceMeters(lat, lng, r.lat, r.lon);
    if (d<500 && now - lastAlertTime>5000) {
      showAlert(`${r.flg===2?'Average':'Fixed'} Radar — ${Math.round(d)} m`);
      lastAlertTime = now;
    }
  });
}

// --- Avg zone detection (only show bar for average-speed zones) ---
function detectAvgZones(lat, lng, kmh) {
  let found = null;
  for (let z of avgZones) {
    const total = distanceMeters(z.start.lat,z.start.lng,z.end.lat,z.end.lng);
    const distToStart = distanceMeters(z.start.lat,z.start.lng,lat,lng);
    const distToEnd = distanceMeters(z.end.lat,z.end.lng,lat,lng);
    const gap = Math.abs((distToStart+distToEnd)-total);
    if (gap<60 && distToStart<=total+30) { found = {zone:z,total,distToStart}; break; }
  }

  if (found) {
    activeAvgZone = found.zone;
    const pct = Math.min(1, Math.max(0, found.distToStart/found.total));
    showAvgZone(activeAvgZone, pct, kmh);
  } else {
    hideAvgZone();
    activeAvgZone = null;
  }
}

function showAvgZone(zone, pct, kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit;
  const percent = Math.round(pct*100);
  progressFill.style.width = `${percent}%`;
  carMarker.style.left = `${percent}%`;

  const over = kmh - zone.limit;
  let fillBg;
  if (over<=0) fillBg='linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
  else {
    const r = Math.min(255, Math.round((over/zone.limit)*255*1.4));
    const g = Math.max(0, 200-Math.round((over/zone.limit)*200));
    fillBg = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
  }
  progressFill.style.background = fillBg;
}

function hideAvgZone(){ avgZoneBar.classList.add('hidden'); }

// --- Alerts ---
function showAlert(text){
  alertText.textContent = text;
  alertPopup.classList.remove('hidden');

  if(chime){ chime.currentTime=0; chime.play().catch(()=>{}); }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout = setTimeout(()=>alertPopup.classList.add('hidden'),4000);
}

// --- PiP ---
function setupPiPButton(){
  pipToggle.addEventListener('click', async ()=>{
    if (!document.pictureInPictureEnabled) { alert('PiP not supported'); return; }
    try {
      if (!pipStream){ pipStream = pipCanvas.captureStream(25); pipVideo.srcObject=pipStream; await pipVideo.play(); }
      if(document.pictureInPictureElement){ await document.exitPictureInPicture(); pipToggle.textContent='Enable PiP'; pipEnabled=false; }
      else { await pipVideo.requestPictureInPicture(); pipToggle.textContent='Disable PiP'; pipEnabled=true; }
    } catch(err){ console.error('PiP error', err);}
  });
}

function drawPiP(kmh=0){ renderPipFrame(kmh); if(!pipInterval){ pipInterval=setInterval(()=>renderPipFrame(lastSpeed||0),200); }}
function startCanvasLoop(){ setInterval(()=>renderPipFrame(lastSpeed||0),300); }
function renderPipFrame(kmh){
  const ctx = pipCtx, w=pipCanvas.width, h=pipCanvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#071021'; ctx.fillRect(0,0,w,h);

  if(!alertPopup.classList.contains('hidden')) {
    roundRect(ctx,10,10,w-20,h-20,18,'#122033');
    ctx.font='22px Arial'; ctx.fillStyle='#ffd7d7'; ctx.fillText('🚨',28,58);
    ctx.font='18px Arial'; ctx.fillStyle='#fff';
    wrapText(ctx, alertText.textContent||'Alert',70,48,w-100,22);
  } else if(activeAvgZone){
    roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
    ctx.font='26px Arial'; ctx.fillStyle='#00e5ff'; ctx.fillText(`${kmh} km/h`,50,100);
  }
}

function roundRect(ctx,x,y,w,h,radius,fillStyle){ctx.beginPath();ctx.moveTo(x+radius,y);ctx.lineTo(x+w-radius,y);ctx.quadraticCurveTo(x+w,y,x+w,y+radius);ctx.lineTo(x+w,y+h-radius);ctx.quadraticCurveTo(x+w,y+h,x+w-radius,y+h);ctx.lineTo(x+radius,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-radius);ctx.lineTo(x,y+radius);ctx.quadraticCurveTo(x,y,x+radius,y);ctx.closePath();ctx.fillStyle=fillStyle;ctx.fill();}
function wrapText(ctx,text,x,y,maxWidth,lineHeight){const words=text.split(' ');let line='';for(let n=0;n<words.length;n++){const testLine=line+words[n]+' ';const metrics=ctx.measureText(testLine);const testWidth=metrics.width;if(testWidth>maxWidth&&n>0){ctx.fillText(line,x,y);line=words[n]+' ';y+=lineHeight;}else{line=testLine;}}ctx.fillText(line,x,y);}

// --- Start ---
(async function(){ await loadData(); initMap(); setupPiPButton(); startGeolocation(); startCanvasLoop(); })();
