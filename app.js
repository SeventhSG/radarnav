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

const adminToggle = document.getElementById('adminToggle');
const adminContent = document.getElementById('adminContent');
const testRadarBtn = document.getElementById('testRadarBtn');
const testAvgBtn = document.getElementById('testAvgBtn');
const testAlertBtn = document.getElementById('testAlertBtn');

const chime = new Audio('assets/chime.mp3');

// Store Leaflet layers for cameras
let radarMarkers = [];

async function init() {
  await loadData();
  initMap();
  setupPiPButton();
  setupAdminMenu();
  startGeolocation();
  startCanvasLoop();
}

async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const data = await res.text();

    // SCDB uses multiple JSON objects in a single file, fix it
    const fixedData = "[" + data.replace(/\}\s*\{/g, "},{").replace(/^\s*\{/, "{").replace(/\}\s*$/, "}") + "]";
    const cameras = JSON.parse(fixedData);

    radars = cameras.map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,  // 1=fixed, 2=average
      unt: cam.unt || "kmh"
    }));

    console.log(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch (err) {
    console.error('Failed to load SCDB or avg zones', err);
    showAlert("Failed to load SCDB: " + err.message);
  }
}

function initMap() {
  // Center Turkey if geolocation not ready
  map = L.map('map', { zoomControl: true }).setView([39.0, 35.0], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0,0], { radius:10, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);

  renderRadars();
  renderAvgZones();
}

// Only show radars within 100 km of user
function renderRadars() {
  radarMarkers.forEach(m => map.removeLayer(m));
  radarMarkers = [];

  if (!userMarker || !userMarker.getLatLng) return;

  const userPos = userMarker.getLatLng();
  radars.forEach(r => {
    const d = distanceMeters(userPos.lat, userPos.lng, r.lat, r.lon);
    if (d <= 100000) { // 100 km
      const color = r.flg === 1 ? 'red' : 'orange'; // fixed=red, average=orange
      const marker = L.circle([r.lat, r.lon], { radius: 200, color, weight: 2, fillOpacity:0.3 })
        .addTo(map)
        .bindPopup(`${r.flg===1?'Fixed':'Average'} Radar: ${r.unt}`);
      radarMarkers.push(marker);
    }
  });
}

function renderAvgZones() {
  avgZones.forEach(z => {
    L.polyline([[z.start.lat, z.start.lng],[z.end.lat, z.end.lng]], { color:'#88f', weight:4, opacity:0.7 }).addTo(map);
  });
}

function startGeolocation(){
  if (!('geolocation' in navigator)){
    showAlert("Geolocation not supported");
    return;
  }

  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 500,
    timeout: 10000
  });
}

function onGeoError(err){ showAlert("Geo error: " + err.message); }

let currentPos = null;
let activeAvgZone = null;

function onPosition(p){
  const lat = p.coords.latitude;
  const lng = p.coords.longitude;
  const speedMps = p.coords.speed;
  const timestamp = p.timestamp;

  currentPos = { lat, lng, speedMps, timestamp };
  map.setView([lat, lng], map.getZoom());
  userMarker.setLatLng([lat, lng]);

  let kmh = speedMps == null ? lastSpeed : Math.round(speedMps*3.6);
  lastSpeed = kmh;
  speedDisplay.textContent = `${kmh} km/h`;

  detectRadars(lat, lng);
  detectAvgZones(lat, lng, kmh);
  renderRadars(); // update only cameras within 100 km
  drawPiP(kmh);
}

function distanceMeters(aLat, aLng, bLat, bLng){
  const R=6371000;
  const toRad = v => v*Math.PI/180;
  const dLat = toRad(bLat-aLat);
  const dLon = toRad(bLng-aLng);
  const lat1 = toRad(aLat), lat2 = toRad(bLat);
  const aa = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
}

let lastAlertTime = 0;
function detectRadars(lat,lng){
  const now = Date.now();
  radars.forEach(r=>{
    const d = distanceMeters(lat,lng,r.lat,r.lon);
    if(d<500 && now-lastAlertTime>5000){
      showAlert(`${r.flg===1?'Fixed':'Average'} Radar — ${Math.round(d)} m`);
      lastAlertTime = now;
    }
  });
}

function showAlert(text){
  alertText.textContent = text;
  alertPopup.classList.remove('hidden');
  if(chime){
    chime.currentTime=0;
    const p=chime.play();
    if(p && typeof p.then==='function') p.catch(e=>console.warn('Chime blocked',e));
  }
  clearTimeout(alertPopup._timeout);
  alertPopup._timeout=setTimeout(()=>{alertPopup.classList.add('hidden');},4000);
}

/* AVG ZONES */
function detectAvgZones(lat,lng,kmh){
  let found=null;
  for(let z of avgZones){
    const total = distanceMeters(z.start.lat,z.start.lng,z.end.lat,z.end.lng);
    const distToStart = distanceMeters(z.start.lat,z.start.lng,lat,lng);
    const distToEnd = distanceMeters(z.end.lat,z.end.lng,lat,lng);
    if(Math.abs(distToStart+distToEnd-total)<60 && distToStart<=total+30){
      found={zone:z,total,distToStart}; break;
    }
  }
  if(found){
    const z = found.zone;
    const pct = Math.min(1, Math.max(0, found.distToStart/found.total));
    showAvgZone(z,pct,kmh);
    activeAvgZone = z;
  } else {
    hideAvgZone(); activeAvgZone=null;
  }
}

function showAvgZone(zone,pct,kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent=kmh;
  zoneLimitVal.textContent=zone.limit;
  const percent=Math.round(pct*100);
  progressFill.style.width=`${percent}%`;
  carMarker.style.left=`${percent}%`;
  const over = kmh-zone.limit;
  progressFill.style.background = over<=0?'linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))':`linear-gradient(90deg, rgba(${Math.min(255,Math.round(over/zone.limit*255*1.4))},${Math.max(0,200-Math.round(over/zone.limit*200))},60,0.25), rgba(${Math.min(255,Math.round(over/zone.limit*255*1.4))},${Math.max(0,200-Math.round(over/zone.limit*200))},60,0.7))`;
}

function hideAvgZone(){ avgZoneBar.classList.add('hidden'); }

/* PiP */
function setupPiPButton(){
  pipToggle.addEventListener('click', async ()=>{
    if(!document.pictureInPictureEnabled){ alert('PiP not supported'); return; }
    try{
      if(!pipStream){ pipStream=pipCanvas.captureStream(25); pipVideo.srcObject=pipStream; await pipVideo.play(); }
      if(document.pictureInPictureElement){ await document.exitPictureInPicture(); pipToggle.textContent='Enable PiP'; pipEnabled=false;}
      else{ await pipVideo.requestPictureInPicture(); pipToggle.textContent='Disable PiP'; pipEnabled=true;}
    }catch(err){console.error('PiP error',err);}
  });
  document.addEventListener('leavepictureinpicture',()=>{pipEnabled=false; pipToggle.textContent='Enable PiP';});
  document.addEventListener('enterpictureinpicture',()=>{pipEnabled=true; pipToggle.textContent='Disable PiP';});
}

function drawPiP(kmh=0){
  renderPipFrame(kmh);
  if(!pipInterval) pipInterval=setInterval(()=>{ renderPipFrame(lastSpeed||0); },200);
}

function startCanvasLoop(){ setInterval(()=>{ renderPipFrame(lastSpeed||0); },300); }
function renderPipFrame(kmh){
  const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#071021'; ctx.fillRect(0,0,w,h);
  if(!alertPopup.classList.contains('hidden')){
    roundRect(ctx,10,10,w-20,h-20,18,'#122033');
    ctx.font='22px Inter, Arial'; ctx.fillStyle='#ffd7d7'; ctx.fillText('🚨',28,58);
    ctx.font='18px Inter, Arial'; ctx.fillStyle='#fff';
    wrapText(ctx,alertText.textContent||'Alert',70,48,w-100,22);
  } else {
    roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
    ctx.font='26px Inter, Arial'; ctx.fillStyle='#00e5ff'; ctx.fillText(`${kmh} km/h`,50,100);
  }
}
function roundRect(ctx,x,y,width,height,radius,fillStyle){
  ctx.beginPath(); ctx.moveTo(x+radius,y); ctx.lineTo(x+width-radius,y);
  ctx.quadraticCurveTo(x+width,y,x+width,y+radius); ctx.lineTo(x+width,y+height-radius);
  ctx.quadraticCurveTo(x+width,y+height,x+width-radius,y+height); ctx.lineTo(x+radius,y+height);
  ctx.quadraticCurveTo(x,y+height,x,y+height-radius); ctx.lineTo(x,y+radius); ctx.quadraticCurveTo(x,y,x+radius,y);
  ctx.closePath(); ctx.fillStyle=fillStyle; ctx.fill();
}
function wrapText(ctx,text,x,y,maxWidth,lineHeight){
  const words=text.split(' '); let line='';
  for(let n=0;n<words.length;n++){
    const testLine=line+words[n]+' '; const metrics=ctx.measureText(testLine);
    const testWidth=metrics.width;
    if(testWidth>maxWidth && n>0){ ctx.fillText(line,x,y); line=words[n]+' '; y+=lineHeight; } else line=testLine;
  }
  ctx.fillText(line,x,y);
}

/* Admin menu */
function setupAdminMenu(){
  adminToggle.addEventListener('click',()=>{ adminContent.classList.toggle('hidden'); });
  testRadarBtn.addEventListener('click',()=>{ showAlert('Test Radar!'); });
  testAvgBtn.addEventListener('click',()=>{ showAlert('Test Avg Zone!'); });
  testAlertBtn.addEventListener('click',()=>{ showAlert('Test Alert!'); });
}

init();
