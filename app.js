// app.js - RadarNav optimized Leaflet version
// Dependencies: Leaflet, NoSleep.js

let map, userMarker, headingMarker;
let radars = [], avgZones = [];
let watchId = null, lastSpeed = 0;
let pipEnabled = false, pipVideo = document.getElementById('pipVideo');
let pipCanvas = document.getElementById('pipCanvas'), pipCtx = pipCanvas.getContext('2d');
let pipStream = null, pipInterval = null;
let activeAvgZone = null;

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

const noSleep = new NoSleep();

// ================= INIT =================
async function init() {
  await loadData();
  initMap();
  setupPiPButton();
  startGeolocation();
  startCanvasLoop();
  enableNoSleep();
}

// ================= LOAD DATA =================
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const data = await res.json();

    // Filter valid entries
    radars = data.filter(cam => cam.lat && cam.lon).map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,
      unt: cam.unt
    }));

    console.log(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch (err) {
    console.error('Failed to load data', err);
    showAlert(`Data load error: ${err.message}`);
  }
}

// ================= MAP =================
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([0, 0], 14);

  // Google Maps-like tile layer (Carto Positron)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  // User marker and heading marker
  userMarker = L.circleMarker([0,0], { radius: 10, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);
  headingMarker = L.polyline([[0,0],[0,0]], { color:'#00ff00', weight:3 }).addTo(map);
}

// ================= GEOLOCATION =================
function startGeolocation() {
  if (!('geolocation' in navigator)) {
    alert('Geolocation not supported in this browser');
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true, maximumAge: 500, timeout: 10000
  });
}

let lastPos = null;
function onPosition(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const speedMps = pos.coords.speed || lastSpeed / 3.6;
  const heading = pos.coords.heading || (lastPos ? getBearing(lastPos, {lat,lng}) : 0);
  lastPos = {lat, lng};

  lastSpeed = Math.round(speedMps * 3.6);
  speedDisplay.textContent = `${lastSpeed} km/h`;

  // Update user marker & heading
  userMarker.setLatLng([lat, lng]);
  const headingOffset = 50; // 50m ahead
  const ahead = computeOffset({lat,lng}, headingOffset, heading);
  headingMarker.setLatLng([[lat,lng],[ahead.lat,ahead.lng]]);
  map.setView([lat,lng]);

  // Filter radars within 10km
  const nearbyRadars = radars.filter(r => distanceMeters(lat,lng,r.lat,r.lon) <= 10000);
  updateRadarMarkers(nearbyRadars);

  // Check approaching radars (within 1km on path)
  detectRadars(lat,lng,heading);

  // Avg zones
  detectAvgZones(lat,lng,lastSpeed);

  // PiP
  drawPiP();
}

function onGeoError(err){
  console.warn('Geo error', err);
  showAlert(`Geo error: ${err.message}`);
}

// ================= UTILITIES =================
function distanceMeters(aLat,aLng,bLat,bLng){
  const R = 6371000;
  const dLat = (bLat-aLat)*Math.PI/180;
  const dLng = (bLng-aLng)*Math.PI/180;
  const lat1 = aLat*Math.PI/180;
  const lat2 = bLat*Math.PI/180;
  const sinDLat = Math.sin(dLat/2);
  const sinDLng = Math.sin(dLng/2);
  const aa = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLng*sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R*c;
}

// Compute approximate bearing in degrees
function getBearing(a,b){
  const y = Math.sin((b.lon-a.lon)*Math.PI/180) * Math.cos(b.lat*Math.PI/180);
  const x = Math.cos(a.lat*Math.PI/180)*Math.sin(b.lat*Math.PI/180) -
            Math.sin(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.cos((b.lon-a.lon)*Math.PI/180);
  return (Math.atan2(y,x)*180/Math.PI + 360)%360;
}

// Offset by distance (meters) in given bearing
function computeOffset(pos, meters, bearing){
  const R = 6378137; // Earth radius
  const δ = meters/R;
  const θ = bearing*Math.PI/180;
  const φ1 = pos.lat*Math.PI/180;
  const λ1 = pos.lon*Math.PI/180;
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));
  return {lat: φ2*180/Math.PI, lon: λ2*180/Math.PI};
}

// ================= ALERT =================
let radarMarkers = [];
function updateRadarMarkers(list){
  // Clear old
  radarMarkers.forEach(m => map.removeLayer(m));
  radarMarkers = [];

  list.forEach(r => {
    const m = L.circle([r.lat,r.lon], {radius:12,color:r.flg===2?'#ff0000':'#ffaa00',weight:2}).addTo(map);
    radarMarkers.push(m);
  });
}

let lastAlertTime = 0;
function detectRadars(lat,lng,heading){
  const now = Date.now();
  radars.forEach(r=>{
    const d = distanceMeters(lat,lng,r.lat,r.lon);
    const brg = getBearing({lat,lng}, r);
    const angleDiff = Math.abs((heading-brg+360)%360);
    // alert only if within 1km and roughly in front (±45°)
    if(d<1000 && angleDiff<45 && now - lastAlertTime>5000){
      showAlert(`Radar ahead! ${Math.round(d)}m`);
      lastAlertTime = now;
    }
  });
}

// ================= SHOW ALERT =================
function showAlert(text){
  alertText.textContent = text;
  alertPopup.classList.remove('hidden');
  if(chime){ chime.currentTime=0; chime.play().catch(()=>{}); }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout = setTimeout(()=>{alertPopup.classList.add('hidden');},4000);
}

// ================= NO SLEEP =================
function enableNoSleep(){
  document.addEventListener('click',()=>{ noSleep.enable();},{once:true});
}

// ================= AVG ZONES =================
function detectAvgZones(lat,lng,kmh){
  let found = null;
  for(let z of avgZones){
    const total = distanceMeters(z.start.lat,z.start.lng,z.end.lat,z.end.lng);
    const distToStart = distanceMeters(z.start.lat,z.start.lng,lat,lng);
    const distToEnd = distanceMeters(z.end.lat,z.end.lng,lat,lng);
    if(Math.abs((distToStart+distToEnd)-total)<60 && distToStart<=total+30){
      found = {zone:z,total,distToStart};
      break;
    }
  }
  if(found){
    const pct = Math.min(1,Math.max(0,found.distToStart/found.total));
    showAvgZone(found.zone,pct,kmh);
    activeAvgZone = found.zone;
  } else {
    hideAvgZone();
    activeAvgZone=null;
  }
}

function showAvgZone(zone,pct,kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent = kmh;
  zoneLimitVal.textContent = zone.limit;
  progressFill.style.width = `${Math.round(pct*100)}%`;
}

function hideAvgZone(){
  avgZoneBar.classList.add('hidden');
}

// ================= PiP =================
// ================= PiP =================
function setupPiPButton(){
  pipToggle.addEventListener('click', async ()=>{
    if(!document.pictureInPictureEnabled){
      alert('PiP not supported');
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
      } else{
        await pipVideo.requestPictureInPicture();
        pipToggle.textContent='Disable PiP';
        pipEnabled=true;
      }
    }catch(err){console.error('PiP error',err);}
  });

  document.addEventListener('enterpictureinpicture',()=>{pipEnabled=true;pipToggle.textContent='Disable PiP';});
  document.addEventListener('leavepictureinpicture',()=>{pipEnabled=false;pipToggle.textContent='Enable PiP';});
}

// Draw PiP canvas
function drawPiP(){
  if(!pipEnabled) return;

  const ctx = pipCtx;
  const w = pipCanvas.width;
  const h = pipCanvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#071021';
  ctx.fillRect(0,0,w,h);

  // Show alert if near radar
  if(alertPopup.classList.contains('hidden')){
    // show only speed
    roundRect(ctx,20,50,w-40,h-100,14,'#0b2a33');
    ctx.font='26px Inter, Arial';
    ctx.fillStyle='#00e5ff';
    ctx.fillText(`${lastSpeed} km/h`,50,100);
  } else {
    // show alert
    roundRect(ctx,10,10,w-20,h-20,18,'#122033');
    ctx.font='22px Inter, Arial';
    ctx.fillStyle='#ffd7d7';
    ctx.fillText('🚨',28,58);
    ctx.font='18px Inter, Arial';
    ctx.fillStyle='#ffffff';
    wrapText(ctx,alertText.textContent||'Alert',70,48,w-100,22);
  }
}

// PiP loop
function startCanvasLoop(){
  setInterval(drawPiP,200);
}

// Rounded rect
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

// Wrap text helper
function wrapText(ctx,text,x,y,maxWidth,lineHeight){
  const words=text.split(' ');
  let line='';
  for(let n=0;n<words.length;n++){
    const testLine=line+words[n]+' ';
    const metrics=ctx.measureText(testLine);
    if(metrics.width>maxWidth && n>0){
      ctx.fillText(line,x,y);
      line=words[n]+' ';
      y+=lineHeight;
    } else line=testLine;
  }
  ctx.fillText(line,x,y);
}

// ================= ADMIN MENU =================
const adminMenu=document.getElementById('adminMenu');
let adminTapCount=0;
document.addEventListener('click',e=>{
  const rect=adminMenu.getBoundingClientRect();
  if(e.clientY>=rect.top && e.clientY<=rect.bottom){
    adminTapCount++;
    if(adminTapCount===3){
      toggleAdminMenu();
      adminTapCount=0;
    }
    setTimeout(()=>{adminTapCount=0;},1000);
  }
});

function toggleAdminMenu(){
  adminMenu.classList.toggle('hidden');
  // Admin buttons
  adminMenu.innerHTML=`
    <button onclick="simulateRadarAlert()">Test Radar Alert</button>
    <button onclick="simulateAvgZoneAlert()">Test Avg Zone</button>
    <button onclick="simulateSpeed()">Test Speed PiP</button>
  `;
}

function simulateRadarAlert(){
  showAlert('Test Radar! 500m');
}

function simulateAvgZoneAlert(){
  showAvgZone({limit:80},{pct:0.5},75);
}

function simulateSpeed(){
  lastSpeed=90;
  drawPiP();
}

// ================= START =================
init();
