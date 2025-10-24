// app.js - RadarNav with improved UI layering, admin menu & SCDB radar detection

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
const adminMenu = document.getElementById('adminMenu'); // new container

const chime = new Audio('assets/chime.mp3');

// --- UI layering fix ---
function setupUI() {
  const uiElements = [alertPopup, avgZoneBar, speedDisplay, pipToggle, adminMenu];
  uiElements.forEach(el => {
    el.style.position = 'absolute';
    el.style.zIndex = 9999;
    el.style.pointerEvents = 'auto';
  });

  // enlarge UI
  avgZoneBar.style.height = '50px';
  avgSpeedVal.style.fontSize = '24px';
  zoneLimitVal.style.fontSize = '24px';
  carMarker.style.height = '24px';
  speedDisplay.style.fontSize = '32px';
  pipToggle.style.fontSize = '18px';
}

// --- SCDB / avg zones / map ---
async function init() {
  setupUI();
  await loadData();
  initMap();
  setupPiPButton();
  startGeolocation();
  startCanvasLoop();
  setupAdminMenu();
}

async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const data = await res.json();
    radars = data.cameras || data;
    console.log(`Loaded ${radars.length} cameras from SCDB`);
    if(!radars.length) console.warn("No cameras loaded - check JSON path!");

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch (err) {
    console.error('Failed to load SCDB or avg zones', err);
  }
}

function initMap() {
  map = L.map('map', { zoomControl: false }).setView([40.73, -73.935], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0, 0], { radius: 10, color: '#00e5ff', fillColor: '#00a3b7', fillOpacity: 1 }).addTo(map);

  // show radars
  radars.forEach(r => {
    const color = r.type === 'average' ? '#88f' : '#ffcc00';
    const circle = L.circle([r.lat, r.lng], { radius: 14, color, weight: 3 }).addTo(map);
    circle.bindPopup(`${r.label || 'Radar'}${r.speedLimit ? ' - ' + r.speedLimit + ' km/h' : ''}`);
  });

  avgZones.forEach(z => {
    L.polyline([[z.start.lat, z.start.lng],[z.end.lat, z.end.lng]], { color:'#88f', weight:6, opacity:0.8 }).addTo(map);
  });
}

// --- GPS ---
function startGeolocation() {
  if(!('geolocation' in navigator)){ alert('Geolocation not supported'); return; }
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy:true, maximumAge:500, timeout:10000 });
}

function onGeoError(err) { console.warn('Geo error', err); }

let currentPos=null, activeAvgZone=null, avgZoneData={}, lastAlertTime=0;

function onPosition(p) {
  const lat=p.coords.latitude,lng=p.coords.longitude,speedMps=p.coords.speed;
  currentPos={lat,lng,speedMps,timestamp:p.timestamp};
  map.setView([lat,lng], map.getZoom());
  userMarker.setLatLng([lat,lng]);

  let kmh = speedMps==null?lastSpeed:Math.round(speedMps*3.6);
  lastSpeed=kmh;
  speedDisplay.textContent = `${kmh} km/h`;

  detectRadars(lat,lng);
  detectAvgZones(lat,lng,kmh);
  drawPiP(kmh);
}

function distanceMeters(aLat,aLng,bLat,bLng){
  const R=6371000,toRad=v=>v*Math.PI/180;
  const dLat=toRad(bLat-aLat), dLon=toRad(bLng-aLng);
  const lat1=toRad(aLat), lat2=toRad(bLat);
  const sinDLat=Math.sin(dLat/2), sinDLon=Math.sin(dLon/2);
  const aa=sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  return 2*R*Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
}

// --- radar detection ---
function detectRadars(lat,lng){
  const now=Date.now();
  radars.forEach(r=>{
    const d=distanceMeters(lat,lng,r.lat,r.lng);
    if(d<500 && now-lastAlertTime>5000){
      showAlert(`${r.label||'Radar'} — ${Math.round(d)} m`);
      lastAlertTime=now;
    }
  });
}

function showAlert(text){
  alertText.textContent=text;
  alertPopup.classList.remove('hidden');
  if(chime){ chime.currentTime=0; chime.play().catch(()=>{}); }

  clearTimeout(alertPopup._timeout);
  alertPopup._timeout = setTimeout(()=>{ alertPopup.classList.add('hidden'); },4000);
}

// --- average zones ---
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
  avgSpeedVal.textContent=kmh;
  zoneLimitVal.textContent=zone.limit;
  const percent=Math.round(Math.min(1,Math.max(0,pct))*100);
  progressFill.style.width=percent+'%';
  carMarker.style.left=percent+'%';

  const over=kmh-zone.limit;
  let fillBg;
  if(over<=0) fillBg='linear-gradient(90deg, rgba(0,229,255,0.2), rgba(0,229,255,0.6))';
  else{
    const r=Math.min(255,Math.round((over/zone.limit)*255*1.4));
    const g=Math.max(0,200-Math.round((over/zone.limit)*200));
    fillBg=`linear-gradient(90deg, rgba(${r},${g},60,0.25), rgba(${r},${g},60,0.7))`;
  }
  progressFill.style.background=fillBg;
}

function hideAvgZone(){ avgZoneBar.classList.add('hidden'); }

// --- PiP ---
function setupPiPButton(){
  pipToggle.style.zIndex=9999;
  if(/Mobi|Android/i.test(navigator.userAgent)){
    pipToggle.style.display='none';
    const overlay=document.createElement('div');
    overlay.id='mobileOverlay';
    Object.assign(overlay.style,{
      position:'fixed',bottom:'20px',right:'20px',padding:'12px 18px',
      background:'#122033',color:'#fff',borderRadius:'16px',fontSize:'20px',zIndex:9999
    });
    document.body.appendChild(overlay);
    setInterval(()=>{ overlay.textContent=alertText.textContent||`${lastSpeed} km/h`; },200);
    return;
  }
  pipToggle.addEventListener('click',async ()=>{
    if(!document.pictureInPictureEnabled){ alert('PiP not supported'); return; }
    try{
      if(!pipStream){ pipStream=pipCanvas.captureStream(25); pipVideo.srcObject=pipStream; await pipVideo.play(); }
      if(document.pictureInPictureElement){ await document.exitPictureInPicture(); pipToggle.textContent='Enable PiP'; pipEnabled=false; }
      else { await pipVideo.requestPictureInPicture(); pipToggle.textContent='Disable PiP'; pipEnabled=true; }
    }catch(err){ console.error('PiP error',err); }
  });
  document.addEventListener('leavepictureinpicture',()=>{ pipEnabled=false; pipToggle.textContent='Enable PiP'; });
  document.addEventListener('enterpictureinpicture',()=>{ pipEnabled=true; pipToggle.textContent='Disable PiP'; });
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
    ctx.font='26px Inter, Arial'; ctx.fillStyle='#ffd7d7'; ctx.fillText('🚨',30,60);
    ctx.font='20px Inter, Arial'; ctx.fillStyle='#fff';
    wrapText(ctx,alertText.textContent||'Alert',80,60,w-120,26);
  } else {
    roundRect(ctx,20,50,w-40,h-120,16,'#0b2a33');
    ctx.font='28px Inter, Arial'; ctx.fillStyle='#00e5ff';
    ctx.fillText(`${kmh} km/h`,50,110);
  }
}

function roundRect(ctx,x,y,w,h,r,fillStyle){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath(); ctx.fillStyle=fillStyle; ctx.fill();
}

function wrapText(ctx,text,x,y,maxWidth,lineHeight){
  const words=text.split(' '); let line='';
  for(let n=0;n<words.length;n++){
    const testLine=line+words[n]+' ';
    const testWidth=ctx.measureText(testLine).width;
    if(testWidth>maxWidth && n>0){ ctx.fillText(line,x,y); line=words[n]+' '; y+=lineHeight; }
    else line=testLine;
  }
  ctx.fillText(line,x,y);
}

// --- Admin menu for testing ---
function setupAdminMenu(){
  adminMenu.style.position='absolute';
  adminMenu.style.bottom='20px';
  adminMenu.style.left='20px';
  adminMenu.style.zIndex=9999;
  adminMenu.style.display='flex';
  adminMenu.style.gap='10px';
  ['Radar Alert','Avg Zone Alert','Speed Display'].forEach((label)=>{
    const btn=document.createElement('button');
    btn.textContent=label;
    btn.style.fontSize='16px';
    btn.style.padding='8px 12px';
    btn.addEventListener('click',()=>{ simulateAlert(label); });
    adminMenu.appendChild(btn);
  });
}

function simulateAlert(type){
  if(type==='Radar Alert'){ showAlert('🚨 Test Radar'); }
  if(type==='Avg Zone Alert'){ showAlert('💨 Test Avg Zone'); }
  if(type==='Speed Display'){ showAlert(`${lastSpeed} km/h`); }
}

// --- start ---
init();
