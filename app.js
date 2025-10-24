// Full working RadarNav prototype
let map,userMarker,radars=[],avgZones=[],watchId=null,lastSpeed=0;
const alertPopup=document.getElementById('alertPopup'),
      alertText=document.getElementById('alertText'),
      avgZoneBar=document.getElementById('avgZoneBar'),
      avgSpeedVal=document.getElementById('avgSpeedVal'),
      zoneLimitVal=document.getElementById('zoneLimitVal'),
      progressFill=document.getElementById('progressFill'),
      carMarker=document.getElementById('carMarker'),
      speedDisplay=document.getElementById('speedDisplay'),
      adminMenu=document.getElementById('adminMenu');

const chime=new Audio('assets/chime.mp3');

async function init(){
  setupAdminMenu();
  await loadData();
  initMap();
  startGeolocation();
}

async function loadData(){
  try{
    const res = await fetch('SCDB_SpeedCams.json');
    const data = await res.json();
    radars = data.map(cam => ({
      lat: cam.lat,
      lon: cam.lon,
      flg: cam.flg,
      unt: cam.unt
    }));
    console.log(`Loaded ${radars.length} cameras`);
    
    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch(err){ console.error('Failed to load SCDB', err);}
}

function initMap(){
  map = L.map('map').setView([39.0, 38.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'&copy; OpenStreetMap contributors'
  }).addTo(map);

  userMarker = L.circleMarker([0,0], {radius:10, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1}).addTo(map);

  radars.forEach(r => {
    // Use lon instead of lng
    const lat = r.lat, lng = r.lon;
    let color = '#ffcc00'; // default fixed
    if(r.flg === 3) color = '#88f'; // average
    const circle = L.circle([lat,lng], {radius:14, color, weight:3}).addTo(map);
    circle.bindPopup(`Radar - ${r.flg ? r.flg + ' ' + r.unt : ''}`);
  });

  avgZones.forEach(z=>{
    L.polyline([[z.start.lat,z.start.lng],[z.end.lat,z.end.lng]],{color:'#88f',weight:6,opacity:0.8}).addTo(map);
  });
}

let currentPos=null,activeAvgZone=null,lastAlertTime=0;
function startGeolocation(){
  if(!('geolocation'in navigator)){alert('No GPS');return;}
  watchId=navigator.geolocation.watchPosition(onPosition,err=>console.warn(err),{enableHighAccuracy:true,maximumAge:500,timeout:10000});
}

function onPosition(p){
  const lat=p.coords.latitude,lng=p.coords.longitude,speedMps=p.coords.speed;
  currentPos={lat,lng,speedMps};
  map.setView([lat,lng],map.getZoom());
  userMarker.setLatLng([lat,lng]);
  let kmh=speedMps==null?lastSpeed:Math.round(speedMps*3.6);
  lastSpeed=kmh;
  speedDisplay.textContent=`${kmh} km/h`;
  detectRadars(lat,lng);
  detectAvgZones(lat,lng,kmh);
}

function distanceMeters(aLat,aLng,bLat,bLng){
  const R=6371000,toRad=v=>v*Math.PI/180;
  const dLat=toRad(bLat-aLat),dLon=toRad(bLng-aLng);
  const lat1=toRad(aLat),lat2=toRad(bLat);
  const aa=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));
}

function detectRadars(lat,lng){
  const now=Date.now();
  radars.forEach(r=>{
    const d=distanceMeters(lat,lng,r.lat,r.lng);
    if(d<500 && now-lastAlertTime>5000){showAlert(`${r.label||'Radar'} - ${Math.round(d)} m`);lastAlertTime=now;}
  });
}

function showAlert(text){
  alertText.textContent=text;
  alertPopup.classList.remove('hidden');
  if(chime){chime.currentTime=0;chime.play().catch(()=>{});}
  clearTimeout(alertPopup._timeout);
  alertPopup._timeout=setTimeout(()=>alertPopup.classList.add('hidden'),4000);
}

function detectAvgZones(lat,lng,kmh){
  let found=null;
  for(let z of avgZones){
    const total=distanceMeters(z.start.lat,z.start.lng,z.end.lat,z.end.lng),
          distStart=distanceMeters(z.start.lat,z.start.lng,lat,lng),
          distEnd=distanceMeters(z.end.lat,z.end.lng,lat,lng),
          gap=Math.abs(distStart+distEnd-total);
    if(gap<60 && distStart<=total+30){found={zone:z,total,distStart};break;}
  }
  if(found){showAvgZone(found.zone,found.distStart/found.total,kmh);activeAvgZone=found.zone;}
  else{hideAvgZone();activeAvgZone=null;}
}

function showAvgZone(zone,pct,kmh){
  avgZoneBar.classList.remove('hidden');
  avgSpeedVal.textContent=kmh;
  zoneLimitVal.textContent=zone.limit;
  const percent=Math.round(Math.min(1,Math.max(0,pct))*100);
  progressFill.style.width=percent+'%';
  carMarker.style.left=percent+'%';
}

function hideAvgZone(){avgZoneBar.classList.add('hidden');}

function setupAdminMenu(){
  ['Radar Alert','Avg Zone Alert','Speed Display'].forEach(label=>{
    const btn=document.createElement('button');
    btn.textContent=label;
    btn.addEventListener('click',()=>simulateAlert(label));
    adminMenu.appendChild(btn);
  });
}

function simulateAlert(type){
  if(type==='Radar Alert') showAlert('🚨 Test Radar');
  if(type==='Avg Zone Alert') showAlert('💨 Test Avg Zone');
  if(type==='Speed Display') showAlert(`${lastSpeed} km/h`);
}

init();
