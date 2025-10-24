// app.js - RadarNav prototype with SCDB + PiP/mobile overlay
// Dependencies: Leaflet (loaded in index.html)

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

const chime = new Audio('assets/chime.mp3'); // alert chime

// detect mobile
function isMobile() {
  return /Mobi|Android/i.test(navigator.userAgent);
}

// --- INIT ---
async function init() {
  await loadData();
  initMap();
  setupPiPButton();
  startGeolocation();
  startCanvasLoop();
}

// --- LOAD DATA ---
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const data = await res.json();
    radars = data.cameras || data;
    console.log(`Loaded ${radars.length} cameras from SCDB`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch (err) {
    console.error('Failed to load SCDB or avg zones', err);
  }
}

// --- MAP ---
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([40.73, -73.935], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0,0], { radius:8, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);

  // cameras
  radars.forEach(r => {
    const color = r.type === 'average' ? '#88f' : '#ffcc00';
    const icon = L.circleMarker([r.lat, r.lng], { radius:10, color, fillColor:color, fillOpacity:0.7 }).addTo(map);
    icon.bindPopup(`${r.label || 'Radar'}${r.speedLimit ? ' - ' + r.speedLimit + ' km/h' : ''}`);
  });

  // average zones
  avgZones.forEach(z => {
    L.polyline([[z.start.lat, z.start.lng],[z.end.lat, z.end.lng]], { color:'#88f', weight:4, opacity:0.7 }).addTo(map);
  });
}

// --- GEOLOCATION ---
function startGeolocation() {
  if (!('geolocation' in navigator)) { alert('Geolocation not supported'); return; }
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy:true, maximumAge:500, timeout:10000 });
}

function onGeoError(err){ console.warn('Geo error', err); }

let currentPos = null;
let activeAvgZone = null;
let avgZoneData = {};
let lastAlertTime = 0;

function onPosition(p) {
  const lat = p.coords.latitude, lng = p.coords.longitude;
  const speedMps = p.coords.speed;
  currentPos = { lat, lng, speedMps, timestamp: p.timestamp };
  map.setView([lat, lng], map.getZoom());
  userMarker.setLatLng([lat, lng]);

  let kmh = speedMps==null ? lastSpeed : Math.round(speedMps*3.6);
  lastSpeed = kmh;
  speedDisplay.textContent = `${kmh} km/h`;

  detectRadars(lat, lng);
  detectAvgZones(lat, lng, kmh);
  drawPiP(kmh);
}

// --- DISTANCE ---
function distanceMeters(aLat,aLng,bLat,bLng){
  const R=6371000,toRad=v=>v*Math.PI/180;
  const dLat=toRad(bLat-aLat), dLon=toRad(bLng-aLng);
  const lat1=toRad(aLat), lat2=toRad(bLat);
  const sinDLat=Math.sin(dLat/2), sinDLon=Math.sin(dLon/2);
  const aa=sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  return 2*R*Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
}

// --- RADAR DETECTION ---
function detectRadars(lat,lng){
  const now = Date.now();
  radars.forEach(r=>{
    const d = distanceMeters(lat,lng,r.lat,r.lng);
    if(d<500 && now-lastAlertTime>5000){
      showAlert(`${r.label||'Radar'} — ${Math.round(d)} m`);
      lastAlertTime=now;
    }
  });
}

function showAlert(text){
  alertText.textContent = text;
  alertPopup.classList.remove('hidden');

  if(chime){ chime.currentTime=0; chime.play().catch(e=>console.warn('Chime prevented', e)); }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout = setTimeout(()=>{ alertPopup.classList.add('hidden'); }, 4000);
}

// --- AVG ZONES ---
function detectAvgZones(lat,lng,kmh){
  let found=null;
  for(let z of avgZones){
    const start=z.start,end=z.end;
    const total=distanceMeters(start.lat,start.lng,end.lat,end.lng);
    const distToStart=distanceMeters(start.lat,start.lng,lat,lng);
    const distToEnd=distanceMeters(end.lat,end.lng,lat,lng);
    const gap=Math.abs(distToStart+distToEnd-total);
    if(gap<60 && distToStart<=total+30){ found={zone:z,total,distToStart}; break; }
  }
  if(found){ showAvgZone(found.zone,found.distToStart/found.total,kmh); activeAvgZone=found.zone; }
  else{ hideAvgZone(); activeAvgZone=null; }
}

function showAvgZone(zone,pct,kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit;

  const percent = Math.round(Math.min(1, Math.max(0,pct))*100);
  progressFill.style.width = percent+'%';
  carMarker.style.left = percent+'%';

  const over = kmh - zone.limit;
  let fillBg;
  if(over<=0) fillBg='linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
  else {
    const r=Math.min(255,Math.round((over/zone.limit)*255*1.4));
    const g=Math.max(0,200-Math.round((over/zone.limit)*200));
    fillBg=`linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
  }
  progressFill.style.background=fillBg;
}

function hideAvgZone(){ avgZoneBar.classList.add('hidden'); }

// --- PiP / Mobile Overlay ---
function setupPiPButton(){
  if(isMobile()){
    pipToggle.style.display='none';
    const floatDiv=document.createElement('div');
    floatDiv.id='mobileOverlay';
    Object.assign(floatDiv.style,{
      position:'fixed', bottom:'20px', right:'20px', padding:'12px 18px',
      background:'#122033', color:'#fff', borderRadius:'16px', fontSize:'18px', zIndex:'9999'
    });
    document.body.appendChild(floatDiv);
    setInterval(()=>{ floatDiv.textContent=alertText.textContent || `${lastSpeed} km/h`; },200);
    return;
  }

  pipToggle.addEventListener('click', async ()=>{
    if(!document.pictureInPictureEnabled){ alert('PiP not supported'); return; }
    try{
      if(!pipStream){ pipStream=pipCanvas.captureStream(25); pipVideo.srcObject=pipStream; await pipVideo.play(); }
      if(document.pictureInPictureElement){ await document.exitPictureInPicture(); pipToggle.textContent='Enable PiP'; pipEnabled=false; }
      else { await pipVideo.requestPictureInPicture(); pipToggle.textContent='Disable PiP'; pipEnabled=true; }
    } catch(err){ console.error('PiP error', err); }
  });

  document.addEventListener('leavepictureinpicture',()=>{ pipEnabled=false; pipToggle.textContent='Enable PiP
