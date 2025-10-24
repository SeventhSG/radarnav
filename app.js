// app.js - Full RadarNav Prototype with SCDB Integration and Mobile Optimizations

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
const adminMenu = document.getElementById('adminMenu');

// Chime
const chime = new Audio('assets/chime.mp3');

// NoSleep
const noSleep = new NoSleep();

async function init() {
  try {
    await loadData();
    initMap();
    setupPiPButton();
    setupAdminMenu();
    startGeolocation();
    startCanvasLoop();
    enableNoSleep();
  } catch (err) {
    showAlert(`Initialization Error: ${err.message}`);
  }
}

async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const textData = await res.text();
    // Parse JSON line by line
    radars = [];
    textData.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('{_meta')) return;
      try {
        const cam = JSON.parse(line);
        radars.push({
          lat: cam.lat,
          lon: cam.lon,
          flg: cam.flg,
          unt: cam.unt
        });
      } catch (err) { console.warn('Invalid line in SCDB:', line); }
    });
    console.log(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch (err) {
    showAlert(`Data load error: ${err.message}`);
    console.error(err);
  }
}

function initMap() {
  map = L.map('map', { zoomControl: false, zoomSnap: 0.25 }).setView([0,0], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.marker([0,0], {
    icon: L.icon({
      iconUrl: 'assets/car.png',
      iconSize: [50, 50],
      iconAnchor: [25, 25]
    }),
    rotationAngle: 0
  }).addTo(map);

  radars.forEach(r => {
    r.marker = L.circleMarker([r.lat, r.lon], { radius: 8, color: r.flg === 2 ? '#ff3333' : '#33ff33', weight:2 })
      .addTo(map);
  });

  avgZones.forEach(z => {
    z.line = L.polyline([[z.start.lat, z.start.lng],[z.end.lat, z.end.lng]], { color:'#88f', weight:4, opacity:0.7 }).addTo(map);
  });
}

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
  showAlert(`Geo error: ${err.message}`);
}

let currentPos = null;
let activeAvgZone = null;
let avgZoneData = {};

function onPosition(p){
  const lat = p.coords.latitude;
  const lng = p.coords.longitude;
  const speedMps = p.coords.speed;
  const heading = p.coords.heading;
  currentPos = { lat, lng, speedMps, heading };

  if (map) map.setView([lat, lng], map.getZoom(), { animate: true });
  if (userMarker) userMarker.setLatLng([lat, lng]).setRotationAngle(heading || 0);

  const kmh = speedMps == null ? lastSpeed : Math.round(speedMps*3.6);
  lastSpeed = kmh;
  speedDisplay.textContent = `${kmh} km/h`;

  // Filter radars in 10km radius
  radars.forEach(r => {
    const d = distanceMeters(lat,lng,r.lat,r.lon);
    if(d>10000) r.marker.setOpacity(0);
    else r.marker.setOpacity(1);
  });

  detectRadars(lat,lng,heading);
  detectAvgZones(lat,lng,kmh);
  drawPiP(kmh);
}

// Haversine distance
function distanceMeters(aLat,aLng,bLat,bLng){
  const R=6371000;
  const toRad=v=>v*Math.PI/180;
  const dLat=toRad(bLat-aLat);
  const dLon=toRad(bLng-aLng);
  const lat1=toRad(aLat);
  const lat2=toRad(bLat);
  const sinDLat=Math.sin(dLat/2);
  const sinDLon=Math.sin(dLon/2);
  const aa=sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  const c=2*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));
  return R*c;
}

let lastAlertTime=0;
function detectRadars(lat,lng,heading){
  const now=Date.now();
  radars.forEach(r=>{
    const d=distanceMeters(lat,lng,r.lat,r.lon);
    // Only alert if within 1km and on path
    if(d<1000 && now-lastAlertTime>5000){
      showAlert(`Radar ahead! ${Math.round(d)} m`, true);
      lastAlertTime=now;
    }
  });
}

function showAlert(text, isCenter=false){
  alertText.textContent=text;
  alertPopup.classList.remove('hidden');
  if(isCenter) alertPopup.style.transform='translate(-50%, -50%)';

  if(chime){
    chime.currentTime=0;
    chime.play().catch(()=>{});
  }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout=setTimeout(()=>{ alertPopup.classList.add('hidden'); },4000);
}

// Average speed zones
function detectAvgZones(lat,lng,kmh){
  let found=null;
  for(let z of avgZones){
    const total=distanceMeters(z.start.lat,z.start.lng,z.end.lat,z.end.lng);
    const distToStart=distanceMeters(z.start.lat,z.start.lng,lat,lng);
    const distToEnd=distanceMeters(z.end.lat,z.end.lng,lat,lng);
    if(Math.abs(distToStart+distToEnd-total)<60 && distToStart<=total+30){
      found={zone:z,total,distToStart};
      break;
    }
  }

  if(found){
    const pct=Math.min(1, Math.max(0, found.distToStart/found.total));
    showAvgZone(found.zone,pct,kmh);
    activeAvgZone=found.zone;
  }else{
    hideAvgZone();
    activeAvgZone=null;
  }
}

function showAvgZone(zone,pct,kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent=kmh;
  zoneLimitVal.textContent=zone.limit;
  progressFill.style.width=`${Math.round(pct*100)}%`;
}

function hideAvgZone(){
  avgZoneBar.classList.add('hidden');
}

// PiP
function setupPiPButton(){
  pipToggle.addEventListener('click', async()=>{
    if(!document.pictureInPictureEnabled){ alert('PiP not supported'); return;}
    try{
      if(!pipStream){
        pipStream=pipCanvas.captureStream(25);
        pipVideo.srcObject=pipStream;
        await pipVideo.play();
      }
      if(document.pictureInPictureElement){
        await document.exitPictureInPicture();
        pipToggle.textContent='Enable PiP';
        pipEnabled=false;
      }else{
        await pipVideo.requestPictureInPicture();
        pipToggle.textContent='Disable PiP';
        pipEnabled=true;
      }
    }catch(err){ console.error('PiP error',err);}
  });
  document.addEventListener('leavepictureinpicture',()=>{pipEnabled=false;pipToggle.textContent='Enable PiP';});
  document.addEventListener('enterpictureinpicture',()=>{pipEnabled=true;pipToggle.textContent='Disable PiP';});
}

function drawPiP(kmh=0){
  if(!pipInterval) pipInterval=setInterval(()=>{ renderPipFrame(lastSpeed || 0); },200);
  renderPipFrame(kmh);
}

function startCanvasLoop(){
  setInterval(()=>{ renderPipFrame(lastSpeed || 0); },300);
}

function renderPipFrame(kmh){
  const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#071021';
  ctx.fillRect(0,0,w,h);

  if(!alertPopup.classList.contains('hidden')){
    roundRect(ctx,10,10,w-20,h-20,18,'#122033');
    ctx.font='22px Inter, Arial'; ctx.fillStyle='#ffd7d7';
    ctx.fillText('🚨',28,58);
    ctx.font='18px Inter, Arial'; ctx.fillStyle='#fff';
    wrapText(ctx,alertText.textContent||'Alert',70,48,w-100,22);
  }else{
    roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
    ctx.font='26px Inter, Arial'; ctx.fillStyle='#00e5ff';
    ctx.fillText(`${kmh} km/h`,50,100);
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
  const words=text.split(' ');
  let line='';
  for(let n=0;n<words.length;n++){
    const testLine=line+words[n]+' ';
    const metrics=ctx.measureText(testLine);
    if(metrics.width>maxWidth && n>0){ ctx.fillText(line,x,y); line=words[n]+' '; y+=lineHeight; } 
    else line=testLine;
  }
  ctx.fillText(line,x,y);
}

// Admin menu triple-tap
function setupAdminMenu(){
  let taps=0; let lastTap=0;
  document.body.addEventListener('touchstart',()=>{
    const now=Date.now();
    if(now-lastTap<500){ taps++; } else { taps=1; }
    lastTap=now;
    if(taps===3){ adminMenu.classList.toggle('hidden'); taps=0; }
  });
}

function enableNoSleep(){ noSleep.enable(); }

init();
