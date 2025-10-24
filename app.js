// app.js - Mobile-ready RadarNav with SCDB integration

let map, userMarker;
let radars = [];
let avgZones = [];
let watchId = null;
let lastSpeed = 0;
let lastPos = null;
let wakeLock = null;

// PiP / mini overlay
let pipEnabled = false;
let pipCanvas = document.getElementById('pipCanvas');
let pipCtx = pipCanvas.getContext('2d');
let pipInterval = null;

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

// chime
const chime = new Audio('assets/chime.mp3');

// initialize
async function init() {
  await loadData();
  initMap();
  startGeolocation();
  setupPiPButton();
  enableWakeLock();
  startCanvasLoop();
  setupAdminMenu();
}

// load SCDB cameras & avg zones
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const text = await res.text();

    // SCDB JSON has multiple objects concatenated; split by newlines/braces
    radars = text
      .split(/\r?\n/)
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(r => r && r.lat && r.lon)
      .map(cam => ({
        lat: cam.lat,
        lon: cam.lon,
        flg: cam.flg,
        unt: cam.unt || 'kmh'
      }));

    console.log(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();

  } catch (err) {
    console.error('Failed to load SCDB:', err);
    showAlert(`Error loading SCDB: ${err.message}`);
  }
}

// init Leaflet map
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([39.0, 35.0], 6); // Turkey center

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0,0], { radius: 10, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);

  // Show radars
  radars.forEach(r => {
    L.circle([r.lat, r.lon], {
      radius: r.flg === 2 ? 15 : 10,
      color: r.flg === 2 ? '#ff0000' : '#ffff00',
      weight: 2
    }).addTo(map);
  });

  // avg zones
  avgZones.forEach(z => {
    L.polyline([[z.start.lat,z.start.lng],[z.end.lat,z.end.lng]], {
      color:'#88f', weight:4, opacity:0.7
    }).addTo(map);
  });
}

// geolocation tracking
function startGeolocation() {
  if (!('geolocation' in navigator)) return alert('Geolocation not supported');

  watchId = navigator.geolocation.watchPosition(onPosition, err=>{
    console.warn('Geo error', err);
    showAlert('Geo error: ' + err.message);
  }, {
    enableHighAccuracy:true,
    maximumAge:500,
    timeout:10000
  });
}

// wake lock to keep screen awake
async function enableWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', ()=>console.log('Screen unlocked'));
    console.log('Screen awake');
  } catch (err) {
    console.warn('Wake lock failed:', err);
  }
}

// distance in meters
function distanceMeters(aLat,aLng,bLat,bLng){
  const R = 6371000, toRad = v=>v*Math.PI/180;
  const dLat = toRad(bLat-aLat), dLon = toRad(bLng-aLng);
  const lat1 = toRad(aLat), lat2=toRad(bLat);
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// bearing in degrees
function getBearing(lat1,lon1,lat2,lon2){
  const toRad = d=>d*Math.PI/180, toDeg=r=>r*180/Math.PI;
  const dLon = toRad(lon2-lon1);
  const y = Math.sin(dLon)*Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(dLon);
  return (toDeg(Math.atan2(y,x))+360)%360;
}

// current position
function onPosition(p) {
  const lat = p.coords.latitude;
  const lng = p.coords.longitude;
  const heading = p.coords.heading ?? lastPos ? getBearing(lastPos.lat,lastPos.lon,lat,lng) : 0;
  const speedMps = p.coords.speed;
  const kmh = speedMps!=null ? Math.round(speedMps*3.6) : lastSpeed;
  lastSpeed = kmh;

  lastPos = {lat,lng,heading};

  map.setView([lat,lng], map.getZoom());
  userMarker.setLatLng([lat,lng]);
  speedDisplay.textContent = `${kmh} km/h`;

  detectRadars(lat,lng,heading);
  detectAvgZones(lat,lng,kmh);
  drawPiP(kmh);
}

// detect radars ahead within 100km
let lastAlertTime=0;
function detectRadars(lat,lng,heading){
  const now = Date.now();
  radars.forEach(r=>{
    const d = distanceMeters(lat,lng,r.lat,r.lon)/1000; // km
    if(d>100) return;
    const bearing = getBearing(lat,lng,r.lat,r.lon);
    const diff = Math.abs(bearing-heading);
    if(diff>60) return; // only ahead
    if(now - lastAlertTime>5000){
      showAlert(`Radar ahead: ${Math.round(d*1000)} m (${r.unt})`);
      lastAlertTime = now;
    }
  });
}

// show alert in center
function showAlert(text){
  alertText.textContent=text;
  alertPopup.classList.remove('hidden');

  // play chime
  if(chime){ chime.currentTime=0; chime.play().catch(()=>{}); }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout=setTimeout(()=>alertPopup.classList.add('hidden'),4000);
}

// avg zones
function detectAvgZones(lat,lng,kmh){
  let found=null;
  for(let z of avgZones){
    const total=distanceMeters(z.start.lat,z.start.lng,z.end.lat,z.end.lng);
    const distStart=distanceMeters(z.start.lat,z.start.lng,lat,lng);
    const distEnd=distanceMeters(z.end.lat,z.end.lng,lat,lng);
    const gap=Math.abs(distStart+distEnd-total);
    if(gap<60 && distStart<=total+30){ found={zone:z,total,distStart}; break; }
  }
  if(found){ showAvgZone(found.zone,found.distStart/found.total,kmh); }
  else hideAvgZone();
}
function showAvgZone(zone,pct,kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent=kmh;
  zoneLimitVal.textContent=zone.limit;
  const percent=Math.round(pct*100);
  progressFill.style.width=`${percent}%`;
  carMarker.style.left=`${percent}%`;
}
function hideAvgZone(){ avgZoneBar.classList.add('hidden'); }

// PiP simulation
function setupPiPButton(){
  pipToggle.addEventListener('click',()=>{
    pipEnabled=!pipEnabled;
    pipToggle.textContent=pipEnabled?'Disable PiP':'Enable PiP';
  });
}
function drawPiP(kmh=0){
  if(!pipEnabled) return;
  const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#071021'; ctx.fillRect(0,0,w,h);
  ctx.font='28px Arial'; ctx.fillStyle='#00e5ff';
  ctx.fillText(`${kmh} km/h`,20,50);
}

// keep updating canvas
function startCanvasLoop(){
  setInterval(()=>drawPiP(lastSpeed||0),300);
}

// simple admin menu for testing alerts
function setupAdminMenu(){
  document.body.addEventListener('click',e=>{
    const x=e.clientX, y=e.clientY, w=window.innerWidth/3;
    if(x<w) showAlert('Test Alert 1');
    else if(x<2*w) showAlert('Test Alert 2');
    else showAlert('Test Alert 3');
  });
}

// start
init();
