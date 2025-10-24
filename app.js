let map, userMarker;
let radars = [];
let avgZones = [];
let lastSpeed = 0;
let pipEnabled = false;
let pipCanvas=document.getElementById('pipCanvas');
let pipCtx=pipCanvas.getContext('2d');
let pipVideo=document.getElementById('pipVideo');
let pipStream=null, pipInterval=null;
const alertPopup=document.getElementById('alertPopup');
const alertText=document.getElementById('alertText');
const avgZoneBar=document.getElementById('avgZoneBar');
const progressFill=document.getElementById('progressFill');
const carMarker=document.getElementById('carMarker');
const avgSpeedVal=document.getElementById('avgSpeedVal');
const zoneLimitVal=document.getElementById('zoneLimitVal');
const speedDisplay=document.getElementById('speedDisplay');
const pipToggle=document.getElementById('pipToggle');
const chime=new Audio('assets/chime.mp3');
let lastAlertTime=0;
let activeAvgZone=null;
let noSleep=new NoSleep();

// ---------------- LOAD DATA ----------------
async function loadData(){
    try{
        const res=await fetch('SCDB_SpeedCams.json');
        const text=await res.text();
        let lines=text.trim().split('\n');
        radars=[];
        lines.forEach(l=>{
            try{
                if(l.startsWith('{') && l.includes('lat')) {
                    let obj=JSON.parse(l);
                    radars.push({lat:obj.lat, lon:obj.lon, flg:obj.flg, unt:obj.unt});
                }
            }catch(e){console.warn('Invalid line',l);}
        });
        console.log(`Loaded ${radars.length} cameras`);
    }catch(err){alert('Data load error: '+err);}
}

// ---------------- INIT MAP ----------------
function initMap(){
    map=L.map('map',{zoomControl:false}).setView([0,0],15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OSM'}).addTo(map);
    userMarker=L.circleMarker([0,0],{radius:8,color:'#00e5ff',fillColor:'#00a3b7',fillOpacity:1}).addTo(map);
}

// ---------------- GEOLOCATION ----------------
function startGeolocation(){
    if(!navigator.geolocation){alert('Geolocation unsupported');return;}
    navigator.geolocation.watchPosition(onPosition, e=>console.warn('Geo error',e),{enableHighAccuracy:true,maximumAge:500,timeout:10000});
}

function onPosition(p){
    const lat=p.coords.latitude;
    const lon=p.coords.longitude;
    const speedMps=p.coords.speed;
    lastSpeed=speedMps==null?lastSpeed:Math.round(speedMps*3.6);
    speedDisplay.textContent=`${lastSpeed} km/h`;
    map.setView([lat,lon],16);
    userMarker.setLatLng([lat,lon]);

    detectRadars(lat,lon);
    detectAvgZones(lat,lon,lastSpeed);
    drawPiP(lastSpeed);
}

// ---------------- DISTANCE ----------------
function distanceMeters(aLat,aLon,bLat,bLon){
    const R=6371000, toRad=v=>v*Math.PI/180;
    const dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
    const lat1=toRad(aLat), lat2=toRad(bLat);
    const sinDLat=Math.sin(dLat/2), sinDLon=Math.sin(dLon/2);
    const aa=sinDLat*sinDLat+Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
    return R*2*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));
}

// ---------------- RADAR DETECTION ----------------
function detectRadars(lat,lon){
    const now=Date.now();
    radars.forEach(r=>{
        const d=distanceMeters(lat,lon,r.lat,r.lon);
        if(d<=10000){ // 10km visible
            if(!r.marker) r.marker=L.circle([r.lat,r.lon],{radius:12,color:r.flg===1?'#00ff00':'#ffcc00',weight:2}).addTo(map);
            if(d<=1000 && now-lastAlertTime>5000){
                lastAlertTime=now;
                activeAvgZone=r.flg===1?r:null;
                showAlert(`${r.flg===1?'Average':'Fixed'} camera ahead ${Math.round(d)} m`);
                playChime();
            }
        }
    });
}

// ---------------- ALERTS ----------------
function showAlert(txt){
    if(pipEnabled){
        alertText.textContent=txt;
        alertPopup.classList.remove('hidden');
        setTimeout(()=>alertPopup.classList.add('hidden'),4000);
    }
}
function playChime(){if(chime){chime.currentTime=0;const p=chime.play();if(p&&p.then)p.catch(e=>console.warn(e));}}

// ---------------- AVG ZONES ----------------
function detectAvgZones(lat,lon,kmh){
    if(!activeAvgZone||activeAvgZone.flg!==1){avgZoneBar.classList.add('hidden');return;}
    avgZoneBar.classList.remove('hidden');
    avgSpeedVal.textContent=kmh; zoneLimitVal.textContent=activeAvgZone.limit||50;
    const pct=0.5;
    const percent=Math.round(pct*100); progressFill.style.width=`${percent}%`;
    carMarker.style.left=`${percent}%`;
}

// ---------------- PiP ----------------
function setupPiPButton(){
    pipToggle.addEventListener('click',async()=>{
        if(!document.pictureInPictureEnabled){alert('PiP not supported');return;}
        try{
            if(!pipStream){pipStream=pipCanvas.captureStream(25);pipVideo.srcObject=pipStream;await pipVideo.play();}
            if(document.pictureInPictureElement){await document.exitPictureInPicture();pipToggle.textContent='Enable PiP';pipEnabled=false;}
            else{await pipVideo.requestPictureInPicture();pipToggle.textContent='Disable PiP';pipEnabled=true;}
        }catch(e){console.error('PiP error',e);}
    });
}

function drawPiP(kmh){
    const ctx=pipCtx,w=pipCanvas.width,h=pipCanvas.height;
    ctx.clearRect(0,0,w,h); ctx.fillStyle='#071021'; ctx.fillRect(0,0,w,h);
    ctx.font='26px Inter, Arial'; ctx.fillStyle='#00e5ff';
    if(activeAvgZone && activeAvgZone.flg===1){ctx.fillText(`${kmh} km/h`,50,50); ctx.fillText('AVG ZONE',50,90);}
    else{ctx.fillText(`${kmh} km/h`,50,100);}
    if(!pipInterval){pipInterval=setInterval(()=>drawPiP(lastSpeed),200);}
}

// ---------------- ADMIN ----------------
let adminClicks=0;
document.addEventListener('click',()=>{
    adminClicks++; if(adminClicks===3){alert('Admin test alert!'); adminClicks=0;}
});

// ---------------- INIT ----------------
async function init(){await loadData();initMap();setupPiPButton();startGeolocation();noSleep.enable();}
init();
