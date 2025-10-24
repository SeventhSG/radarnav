// RadarNav Turkey v1 - works with SCDB NDJSON

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

let currentPos = null;
let activeAvgZone = null;
let avgZoneData = {};
let lastAlertTime = 0;

// --- Load SCDB and Avg Zones ---
async function loadData() {
  try {
    const res = await fetch('SCDB_SpeedCams.json');
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.includes('_meta'));
    radars = lines.map(line => {
      line = line.replace(/"un t"|\"unt\s+"/g,'"unt"');
      try {
        const obj = JSON.parse(line);
        return { lat: obj.lat, lon: obj.lon, flg: obj.flg, unt: obj.unt };
      } catch(e) { return null; }
    }).filter(r => r);
    console.log(`Loaded ${radars.length} cameras`);

    const z = await fetch('avg_zones.json');
    avgZones = await z.json();
  } catch(err) {
    showError(`Failed to load SCDB: ${err.message}`);
    console.error(err);
  }
}

// --- Init map ---
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([39.0, 35.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM' }).addTo(map);
  userMarker = L.circleMarker([0,0], { radius:8, color:'#00e5ff', fillColor:'#00a3b7', fillOpacity:1 }).addTo(map);

  radars.forEach(r => {
    L.circle([r.lat, r.lon], { radius: 300, color: r.flg===2?'#ff0000':'#ffff00', weight:2 }).addTo(map);
  });

  avgZones.forEach(z => {
    L.polyline([[z.start.lat,z.start.lon],[z.end.lat,z.end.lon]], { color:'#88f', weight:4, opacity:0.7 }).addTo(map);
  });
}

// --- Geolocation ---
function startGeolocation() {
  if (!navigator.geolocation) return showError('Geolocation not supported');
  watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy:true, maximumAge:500, timeout:10000 });
}

function onGeoError(err){ showError('Geo error: '+err.message); }

function onPosition(p) {
  const lat = p.coords.latitude, lng = p.coords.longitude;
  const speedMps = p.coords.speed; 
  const kmh = speedMps==null?lastSpeed:Math.round(speedMps*3.6);
  lastSpeed = kmh;
  currentPos = { lat, lng, speedMps };
  speedDisplay.textContent = `${kmh} km/h`;

  map.setView([lat,lng], map.getZoom());
  userMarker.setLatLng([lat,lng]);

  detectRadars(lat,lng);
  detectAvgZones(lat,lng,kmh);
  drawPiP(kmh);
}

// --- Haversine ---
function distanceMeters(aLat,aLng,bLat,bLng){
  const R=6371000, toRad=v=>v*Math.PI/180;
  const dLat=toRad(bLat-aLat), dLon=toRad(bLng-aLng);
  const lat1=toRad(aLat), lat2=toRad(bLat);
  const sinDLat=Math.sin(dLat/2), sinDLon=Math.sin(dLon/2);
  const aa = sinDLat*sinDLat
