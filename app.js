// RadarNav Turkey - full working prototype with 100km radius filter

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

const adminMenu = {
  radarBtn: document.getElementById('testRadarBtn'),
  avgBtn: document.getElementById('testAvgBtn'),
  alertBtn: document.getElementById('testAlertBtn')
};

const chime = new Audio('assets/chime.mp3');

let currentPos = null;
let activeAvgZone = null;
let lastAlertTime = 0;

// -------------------- Load Data --------------------
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.includes('_meta'));
    radars = lines.map(line => {
      line = line.replace(/"un t"|\"unt\s+"/g,'"unt"'); 
      try { const obj = JSON.parse(line); return { lat: obj.lat, lon: obj.lon, flg: obj.flg, unt: obj.unt }; } 
      catch(e){ return null; }
    }).filter(r => r);
    console.log(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch(err) { showError(`Failed to load SCDB: ${err.message}`); console.error(err); }
}

// -------------------- Initialize Map --------------------
function initMap() {
  map = L.map('map', { zoomControl:false }).setView([39.0, 35.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM' }).addTo(map);

  userMarker = L.circleMarker([0,0], { radius:10, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);
}

// -------------------- Update Map Markers --------------------
function updateMapMarkers() {
  if(!currentPos) return;
  const radiusMeters = 100000; // 100 km
  // clear old markers
  map.eachLayer(layer=>{
    if(layer.options && layer.options._customRadar) map.removeLayer(layer);
  });

  radars.forEach(r => {
    const d = distanceMeters(currentPos.lat,currentPos.lon,r.lat,r.lon);
    if(d <= radiusMeters){
      const color = r.flg===2?'#ff0000':'#ffff00';
      L.circle([r.lat,r.lon], { radius: r.flg===2?300:150, color, weight:2, _customRadar:true }).addTo(map);
    }
  });

  avgZones.forEach(z => {
    const startD = distanceMeters(currentPos.lat,currentPos.lon,z.start.lat,z.start.lon);
    const endD = distanceMeters(currentPos.lat,currentPos.lon,z.end.lat,z.end.lon);
    if(startD<=radiusMeters || endD<=radiusMeters){
      L.polyline([[z.start.lat,z.start.lon],[z.end.lat,z.end.lon]], { color:'#88f', weight:4, opacity:0.7, _customRadar:true }).addTo(map);
    }
  });
}

// -------------------- Geolocation --------------------
function startGeolocation() {
  if (!navigator.geolocation) return showError('Geolocation not supported');
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy:true, maximumAge:500, timeout:10000 });
}

function onGeoError(err){ showError('Geo error: '+err.message); }

function onPosition(p) {
  const lat = p.coords.latitude, lng = p.coords.longitude;
  const speedMps = p.coords.speed;
  const kmh = speedMps==null ? lastSpeed : Math.round(speedMps*3.6);
  lastSpeed = kmh;
  currentPos = { lat, lng, speedMps };
  speedDisplay.textContent = `${kmh} km/h`;

  map.setView([lat,lng], map.getZoom());
  userMarker.setLatLng([lat,lng]);

  updateMapMarkers(); // refresh visible radars & avg zones
  detectRadars(lat,lng);
  detectAvgZones(lat,lng,kmh);
  drawPiP(kmh);
}

// -------------------- Distance --------------------
function distanceMeters(aLat,aLng,bLat,bLng){
  const R=6371000, toRad=v=>v*Math.PI/180;
  const dLat=toRad(bLat-aLat), dLon=toRad(bLng-aLng);
  const lat1=toRad(aLat), lat2=toRad(bLat);
  const sinDLat=Math.sin(dLat/2), sinDLon=Math.sin(dLon/2);
  const aa = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R*c;
}

// -------------------- Radar Detection --------------------
function detectRadars(lat,lng){
  const now = Date.now();
  radars.forEach(r=>{
    const d = distanceMeters(lat,lng,r.lat,r.lon);
    if(d<500 && now - lastAlertTime > 5000){
      showAlert(`${r.flg===2?'Fixed':'Average'} Radar — ${Math.round(d)} m`);
      lastAlertTime = now;
    }
  });
}

// -------------------- Average Zones --------------------
function detectAvgZones(lat,lng,kmh){
  let found = null;
  for(let z of avgZones){
    const total = distanceMeters(z.start.lat,z.start.lon,z.end.lat,z.end.lon);
    const distToStart = distanceMeters(z.start.lat,z.start.lon,lat,lng);
    const distToEnd = distanceMeters(z.end.lat,z.end.lon,lat,lng);
    const gap = Math.abs((distToStart+distToEnd)-total);
    if(gap<60 && distToStart <= total+30){ found={zone:z,total,distToStart}; break; }
  }

  if(found){
    const z = found.zone;
    const pct = Math.min(1, Math.max(0, found.distToStart/found.total));
    showAvgZone(z,pct,kmh);
    activeAvgZone = z;
  } else { hideAvgZone(); activeAvgZone=null; }
}

function showAvgZone(zone,pct,kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit;

  const percent = Math.round(pct*100);
  progressFill.style.width = `${percent}%`;
  carMarker.style.left = `${percent}%`;

  const over = kmh - zone.limit;
  let fillBg;
  if(over<=0){ fillBg='linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))'; }
  else {
    const r = Math.min(255, Math.round((over/zone.limit)*255*1.4));
    const g = Math.max(0,200-Math.round((over/zone.limit)*200));
    fillBg = `linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
  }
  progressFill.style.background = fillBg;
}

function hideAvgZone(){ avgZoneBar.classList.add('hidden'); }

// -------------------- Alerts --------------------
function showAlert(text){
  alertText.textContent = text;
  alertPopup.classList.remove('hidden');

  if(chime){ chime.currentTime=0; chime.play().catch(e=>console.warn('Chime blocked',e)); }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout = setTimeout(()=>{ alertPopup.classList.add('hidden'); },4000);
}

// -------------------- PiP --------------------
function setupPiPButton(){
  pipToggle.addEventListener('click',async ()=>{
    if(!document.pictureInPictureEnabled){ alert('PiP not supported'); return; }
    try{
      if(!pipStream){
        pipStream = pipCanvas.captureStream(25);
        pipVideo.srcObject = pipStream;
        await pipVideo.play();
      }
      if(document.pictureInPictureElement){ await document.exitPictureInPicture(); pipToggle.textContent='Enable PiP'; pipEnabled=false; }
      else{ await pipVideo.requestPictureInPicture(); pipToggle.textContent='Disable PiP'; pipEnabled=true; }
    }catch(err){ console.error('PiP error',err);}
  });
}

function drawPiP(kmh=0){
  renderPipFrame(kmh);
  if(!pipInterval){ pipInterval=setInterval(()=>{ renderPipFrame(lastSpeed||0); },200); }
}

function startCanvasLoop(){ setInterval(()=>{ renderPipFrame(lastSpeed||0); },300); }

function renderPipFrame(kmh){
  const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#071021'; ctx.fillRect(0,0,w,h);

  if(!alertPopup.classList.contains('hidden')){
    roundRect(ctx,10,10,w-20,h-20,18,'#122033');
    ctx.font='22px Inter, Arial'; ctx.fillStyle='#ffd7d7'; ctx.fillText('🚨',28,58);
    ctx.font='18px Inter, Arial'; ctx.fillStyle='#ffffff';
    wrapText(ctx,alertText.textContent||'Alert',70,48,w-100,22);
  } else {
    roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
    ctx.font='26px Inter, Arial'; ctx.fillStyle='#00e5ff'; ctx.fillText(`${kmh} km/h`,50,100);
  }
}

function roundRect(ctx,x,y,width,height,radius,fillStyle){
  ctx.beginPath();
  ctx.moveTo(x+radius,y); ctx.lineTo(x+width-radius,y);
  ctx.quadraticCurveTo(x+width,y,x+width,y+radius);
  ctx.lineTo(x+width,y+height-radius);
  ctx.quadraticCurveTo(x+width,y+height,x+width-radius,y+height);
  ctx.lineTo(x+radius,y+height); ctx.quadraticCurveTo(x,y+height,x,y+height-radius);
  ctx.lineTo(x,y+radius); ctx.quadraticCurveTo(x,y,x+radius,y);
  ctx.closePath();
  ctx.fillStyle=fillStyle; ctx.fill();
}

function wrapText(ctx,text,x,y,maxWidth,lineHeight){
  const words=text.split(' '); let line='';
  for(let n=0;n<words.length;n++){
    const testLine=line+words[n]+' '; const metrics=ctx.measureText(testLine);
    if(metrics.width>maxWidth && n>0){ ctx.fillText(line,x,y); line=words[n]+' '; y+=lineHeight; }
    else{ line=testLine; }
  }
  ctx.fillText(line,x,y);
}

// -------------------- Errors --------------------
function showError(msg){
  alertPopup.textContent = msg;
  alertPopup.classList.remove('hidden');
  console.error(msg);
}

// -------------------- Admin --------------------
function setupAdminMenu(){
  adminMenu.radarBtn.onclick = ()=>showAlert('Test Radar Alert 🚨');
  adminMenu.avgBtn.onclick = ()=>showAlert('Test Avg Zone ⚡');
  adminMenu.alertBtn.onclick = ()=>showAlert('Test Alert 💥');
}

// -------------------- Init --------------------
async function init(){
  await loadData();
  initMap();
  setupPiPButton();
  setupAdminMenu();
  startGeolocation();
  startCanvasLoop();
}

init();
