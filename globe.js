/* Interactive, dependency-free orthographic Earth and launch-site explorer. */
(() => {
  'use strict';
  const canvas = document.getElementById('launch-globe');
  if (!canvas) return;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rad = Math.PI / 180;
  const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
  const fmt = n => Number(n).toLocaleString('en-US');
  const vCanvas = canvas.getContext('2d', {alpha:false});
  const earth = document.createElement('canvas');
  const ectx = earth.getContext('2d');
  let longitude = -45, latitude = 23, spinning = false, timer = null;
  let year = new Date().getUTCFullYear(), all = [], sites = [], shown = [], picked = null;
  let filter = 'all', width = 420, radius = 174, center = 210, hitMarkers = [];
  let dragging = null, queued = false, updated = null;
  const overlay = $('globe-detail'), info = $('globe-summary');
  let mask = null;
  function landMask() {
    const map = document.createElement('canvas');
    map.width = 720; map.height = 360;
    const context = map.getContext('2d', {willReadFrequently:true});
    context.fillStyle = 'white';
    for (const ring of window.PALE_LAND || []) {
      if (!ring.length) continue;
      context.beginPath();
      ring.forEach((p,i) => {
        const x = (p[0]+180)*2;
        const y = (90-p[1])*2;
        if(i === 0) context.moveTo(x,y); else context.lineTo(x,y);
      });
      context.closePath(); context.fill();
    }
    mask = context.getImageData(0,0,720,360).data;
  }
  function project(lat,lon) {
    const a = lat*rad, d=(lon-longitude)*rad, c=latitude*rad;
    const z = Math.sin(c)*Math.sin(a)+Math.cos(c)*Math.cos(a)*Math.cos(d);
    if (z <= 0) return null;
    return {x:center+radius*Math.cos(a)*Math.sin(d),y:center-radius*(Math.cos(c)*Math.sin(a)-Math.sin(c)*Math.cos(a)*Math.cos(d)),z};
  }
  function resize() {
    const cssW = Math.max(220,canvas.parentElement.clientWidth);
    const n = Math.round(Math.min(560,Math.max(280,cssW*Math.min(window.devicePixelRatio||1,1.5))));
    width = n;
    radius = width*.414;
    center = width/2;
    canvas.width=width;canvas.height=width;
    earth.width=width;earth.height=width;
    draw();
  }
  function earthPixels(){
    const data=ectx.createImageData(width,width), arr=data.data;
    const lat0=latitude*rad,s0=Math.sin(lat0),c0=Math.cos(lat0);
    const lon0=longitude;
    const left=Math.floor(center-radius),right=Math.ceil(center+radius);
    for(let iy=Math.max(0,left);iy<Math.min(width,right);iy++){
      const yy=(center-iy)/radius;
      for(let ix=Math.max(0,left);ix<Math.min(width,right);ix++){
        const xx=(ix-center)/radius, r2=xx*xx+yy*yy;
        if(r2>=1)continue;
        const zz=Math.sqrt(1-r2);
        const lat=Math.asin(clamp(zz*s0+yy*c0,-1,1));
        let lon=lon0+Math.atan2(xx,zz*c0-yy*s0)/rad;
        lon=((lon+180)%360+360)%360-180;
        const latD=lat/rad;
        const mapX=clamp(Math.floor((lon+180)*2),0,719);
        const mapY=clamp(Math.floor((90-latD)*2),0,359);
        const land=mask && mask[(mapY*720+mapX)*4+3]>128;
        const light=clamp(0.28 + 0.47*zz -0.22*xx +0.24*yy,0.14,1);
        const haze=Math.pow(r2,4)*23;
        const variance=land?6*Math.sin(lon*.11+Math.cos(latD*.4))+4*Math.cos(latD*.27+lon*.5):0;
        const at=(iy*width+ix)*4;
        arr[at]=Math.round((land?48+variance:10)*light + haze*.55);
        arr[at+1]=Math.round((land?100+variance:65)*light + haze);
        arr[at+2]=Math.round((land?111+variance:113)*light + haze*1.5);
        arr[at+3]=255;
      }
    }
    ectx.putImageData(data,0,0);
  }
  function drawGrid(){
    vCanvas.strokeStyle='rgba(162,207,233,.13)';
    vCanvas.lineWidth=Math.max(.45,width/720);
    for(let lat=-60;lat<=60;lat+=30) {
      vCanvas.beginPath();let started=false;
      for(let lon=-180;lon<=180;lon+=2){
        const p=project(lat,lon);
        if(!p){started=false;continue;}
        if(!started){vCanvas.moveTo(p.x,p.y);started=true;} else vCanvas.lineTo(p.x,p.y);
      } vCanvas.stroke();
    }
    for(let lon=-180;lon<180;lon+=30){
      vCanvas.beginPath();let started=false;
      for(let lat=-89;lat<=89;lat+=2){
        const p=project(lat,lon);
        if(!p){started=false;continue;}
        if(!started){vCanvas.moveTo(p.x,p.y);started=true;}else vCanvas.lineTo(p.x,p.y);
      }vCanvas.stroke();
    }
  }
  function drawMarkers(){
    hitMarkers=[];
    const back=shown.slice().sort((a,b)=>a.count-b.count);
    for (const site of back) {
      const p=project(site.lat,site.lon);
      if(!p)continue;
      const isSelected=picked?.key===site.key;
      const size=clamp(width*.008 + Math.sqrt(site.count)*width*.003,4,14);
      vCanvas.beginPath();
      vCanvas.arc(p.x,p.y,size*2.15,0,Math.PI*2);
      vCanvas.fillStyle=isSelected?'rgba(255,192,125,.18)':'rgba(123,206,244,.14)';vCanvas.fill();
      vCanvas.beginPath();vCanvas.arc(p.x,p.y,size,0,Math.PI*2);
      vCanvas.fillStyle=isSelected?'#ffce9d':'#a3d9ff';vCanvas.fill();
      vCanvas.lineWidth=isSelected?2.5:1;
      vCanvas.strokeStyle=isSelected?'#fff3dd':'#102840';vCanvas.stroke();
      hitMarkers.push({...site,x:p.x,y:p.y,r:size+13});
      if(isSelected) {
        const label=site.site.length>25?site.site.slice(0,23)+'…':site.site;
        vCanvas.font='600 '+Math.max(10,width*.022)+'px "DM Mono", monospace';
        vCanvas.textAlign='center';vCanvas.fillStyle='#edf5ff';
        vCanvas.fillText(label,p.x,Math.max(15,p.y-size-15));
      }
    }
  }
  function draw(){
    if(!width) return;
    vCanvas.clearRect(0,0,width,width);
    const bg=vCanvas.createRadialGradient(center,center,radius*.4,center,center,radius*1.2);
    bg.addColorStop(0,'#132c48');bg.addColorStop(.63,'#0f2339');bg.addColorStop(.9,'#091525');bg.addColorStop(1,'#0b1623');
    vCanvas.fillStyle=bg;vCanvas.fillRect(0,0,width,width);
    // Orbital ring and illuminated atmosphere around the physical globe.
    vCanvas.save();vCanvas.translate(center,center);vCanvas.rotate(-.3);vCanvas.strokeStyle='#375b7748';vCanvas.lineWidth=Math.max(.8,width*.002);
    vCanvas.beginPath();vCanvas.ellipse(0,0,radius*1.13,radius*.43,0,0,Math.PI*2);vCanvas.stroke();vCanvas.restore();
    vCanvas.beginPath();vCanvas.arc(center,center,radius+width*.007,0,Math.PI*2);
    vCanvas.strokeStyle='#5aa4d544';vCanvas.lineWidth=width*.018;vCanvas.stroke();
    earthPixels();vCanvas.drawImage(earth,0,0);
    vCanvas.beginPath();vCanvas.arc(center,center,radius,0,Math.PI*2);vCanvas.strokeStyle='#8ed0fa70';vCanvas.lineWidth=1;vCanvas.stroke();
    drawGrid();drawMarkers();
  }
  function schedule(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;draw();});}
  function normalizeSite(raw) {
    if(!raw || !Number.isFinite(Number(raw.lat)) || !Number.isFinite(Number(raw.lon)) ||raw.lat===null||raw.lon===null)return null;
    const la=Number(raw.lat),lo=Number(raw.lon);
    if(la<-90||la>90||lo<-180||lo>180)return null;
    return { ...raw, lat:la,lon:lo };
  }
  function recentLimit() {
    if(filter==='all')return null;
    return Date.now()-Number(filter)*86400000;
  }
  function aggregate(){
    const cutoff=recentLimit();
    const grouped=new Map();
    for(const item of all) {
      if (cutoff && (!item.net || new Date(item.net).getTime()<cutoff)) continue;
      const entry=normalizeSite(item);
      if(!entry)continue;
      const key=(entry.site||'Unknown site')+'|'+entry.lat.toFixed(2)+'|'+entry.lon.toFixed(2);
      if(!grouped.has(key))grouped.set(key,{key,site:entry.site||'Unknown site',country:entry.country||'Unknown',lat:entry.lat,lon:entry.lon,count:0,launches:[]});
      const site=grouped.get(key);site.count++;site.launches.push(entry);
    }
    shown=[...grouped.values()].sort((a,b)=>b.count-a.count);
    sites=shown;
    if(picked){picked=shown.find(s=>s.key===picked.key)||null;}
    const visible=shown.reduce((n,s)=>n+s.count,0);
    $('globe-sites-count').textContent=fmt(shown.length);
    $('globe-activity-count').textContent=fmt(visible);
    $('globe-coverage').textContent=visible===all.length?
      all.length+' mapped launches' : visible+' mapped of '+(filter==='all'?all.length:'filtered')+' records';
    if(!shown.length){
      $('globe-site-list').innerHTML='<div class="globe-empty">No mapped launch records for this period.</div>';
      if(info)info.textContent='No launch locations available for the selected period.';
    }else{
      $('globe-site-list').innerHTML=shown.slice(0,8).map((s,i)=>
        '<button type="button" class="globe-site-row'+(picked?.key===s.key?' selected':'')+'" data-site-index="'+i+'"><span class="site-index">'+String(i+1).padStart(2,'0')+'</span><span class="site-name"><b>'+esc(s.site)+'</b><small>'+esc(s.country)+'</small></span><strong>'+fmt(s.count)+'</strong></button>'
      ).join('');
    }
    showPicked();
    schedule();
  }
  function showPicked(){
    if(!picked){
      overlay.innerHTML='<span class="globe-detail-kicker">SELECT A LAUNCH SITE</span><h3>Every journey starts somewhere.</h3><p>Tap a glowing marker or select a launch location to explore missions from that site.</p>';
      return;
    }
    const recent=picked.launches.slice().sort((a,b)=>(b.net||'').localeCompare(a.net||''));
    overlay.innerHTML='<span class="globe-detail-kicker">SELECTED LAUNCH LOCATION</span><h3>'+esc(picked.site)+'</h3><p>'+esc(picked.country)+' · '+fmt(picked.count)+' tracked launches</p><div class="globe-mission-stack">'+recent.slice(0,3).map(x=>
      '<a href="'+esc(/^https:\/\//.test(x.url||'')?x.url:'https://thespacedevs.com/llapi')+'" target="_blank" rel="noopener noreferrer"><small>'+esc(x.net?new Date(x.net).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}):'Date unavailable')+' · '+esc(x.status)+'</small><b>'+esc(x.name)+'</b><span>'+esc(x.provider)+' ↗</span></a>'
    ).join('')+'</div>';
  }
  function pick(site){
    picked=site;
    longitude=site.lon;
    latitude=clamp(site.lat,-70,70);
    aggregate();
    if(info)info.textContent=site.site+' selected. The globe is centred on the launch site.';
  }
  canvas.addEventListener('pointerdown', e=>{dragging={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';});
  canvas.addEventListener('pointermove',e=>{
    if(!dragging||dragging.id!==e.pointerId)return;
    const dx=e.clientX-dragging.x,dy=e.clientY-dragging.y;
    if(Math.abs(e.clientX-dragging.startX)+Math.abs(e.clientY-dragging.startY)>7)dragging.moved=true;
    longitude=((longitude-dx*.32+540)%360)-180;
    latitude=clamp(latitude+dy*.26,-76,76);
    dragging.x=e.clientX;dragging.y=e.clientY;schedule();
  });
  canvas.addEventListener('pointerup',e=>{
    if(!dragging||dragging.id!==e.pointerId)return;
    const moved=dragging.moved;dragging=null;canvas.style.cursor='grab';
    if(moved)return;
    const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*width,y=(e.clientY-r.top)/r.height*width;
    const nearest=hitMarkers.map(s=>({...s,distance:Math.hypot(x-s.x,y-s.y)})).filter(s=>s.distance<=s.r).sort((a,b)=>a.distance-b.distance)[0];
    if(nearest)pick(nearest);
  });
  canvas.addEventListener('pointercancel',()=>{dragging=null;canvas.style.cursor='grab';});
  $('globe-site-list').addEventListener('click',e=>{
    const row=e.target.closest('[data-site-index]');
    if(row && shown[Number(row.dataset.siteIndex)])pick(shown[Number(row.dataset.siteIndex)]);
  });
  $('globe-period').addEventListener('change',e=>{filter=e.target.value;aggregate();});
  $('globe-reset').addEventListener('click',()=>{longitude=-45;latitude=23;picked=null;aggregate();});
  $('globe-spin').addEventListener('click',()=>{
    spinning=!spinning;
    $('globe-spin').textContent=spinning?'PAUSE ROTATION':'AUTO ROTATE';
    $('globe-spin').setAttribute('aria-pressed',String(spinning));
    if(timer)clearInterval(timer);
    timer=spinning?setInterval(()=>{if(document.visibilityState==='visible'&&!dragging){longitude=((longitude+.55+180)%360)-180;schedule();}},120):null;
  });
  window.addEventListener('resize',()=>{clearTimeout(window._paleResize);window._paleResize=setTimeout(resize,120);});
  async function init(){
    landMask();
    resize();
    try{
      const res=await fetch('./data/year-launches.json',{cache:'no-store'});
      if(!res.ok)throw new Error('Data source unavailable');
      const json=await res.json();
      year=Number(json.year)||year;
      all=Array.isArray(json.launches)?json.launches:[];
      updated=json.updated||null;
      $('globe-year').textContent=String(year);
      if(updated){$('globe-updated').textContent='FEED SYNC: '+new Date(updated).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).toUpperCase();}
      if(!all.length)info.textContent='No current-year launches loaded. Data will populate on the next successful sync.';
      aggregate();
    }catch(err){
      info.textContent='The 2026 launch feed is currently unavailable. The globe will show sites after the next successful update.';
      overlay.innerHTML='<span class="globe-detail-kicker">DATA UNAVAILABLE</span><h3>Waiting for launch records</h3><p>When the daily feed refreshes, the globe will show verified launch locations from the current year.</p>';
      schedule();
    }
  }
  init();
})();