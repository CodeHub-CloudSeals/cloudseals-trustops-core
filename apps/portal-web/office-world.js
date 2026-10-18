// Isometric office illustration. Animation is presentation, never agent execution.
export function createOfficeWorld(el, onSelect) {
  const canvas = el("canvas", { class: "office-world-canvas", role: "img", "aria-label": "Animated isometric office. Use the agent buttons below to inspect each desk." });
  const seats = el("div", { class: "office-seat-list", "aria-label": "Select an agent desk" });
  const caption = el("p", { class: "office-world-caption", "aria-live": "polite" });
  const root = el("div", { class: "office-world" }, canvas, caption, seats);
  const ctx = canvas.getContext("2d");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let data = { nodes: [], current: -1, running: false, preview: false, selected: 0 };
  let frame = null, lastFrame = 0, zoom = 1, width = 1000, height = 680, hitAreas = [], lastStep = -1, handoffAt = -10000;
  const W = 1000, H = 680;
  const shirts = ["#335bc0", "#3a8f91", "#8a74b0", "#c38359", "#547b98", "#38877d", "#6574b5", "#a67c98", "#5b8294"];
  const skin = ["#d7a17b", "#f0c49d", "#9d6b50", "#d5a382"];
  const statusColor = { waiting: "#8291a6", running: "#3464db", done: "#34886c", skipped: "#b58a38", failed: "#bf5d59" };
  const iso = (x, y, z = 0) => ({ x: 470 + (x - y) * 36, y: 138 + (x + y) * 18 - z });
  const seatPos = i => ({ x: 2 + (i % 3) * 3.55, y: 1.65 + Math.floor(i / 3) * 2.75 });
  function polygon(points, fill, stroke) {
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function box(x, y, w, d, z, h, top, side = "#b4c0d0", front = "#c7d0df") {
    const a = iso(x,y,z+h), b=iso(x+w,y,z+h), c=iso(x+w,y+d,z+h), e=iso(x,y+d,z+h);
    polygon([e,c,iso(x+w,y+d,z),iso(x,y+d,z)], front);
    polygon([b,c,iso(x+w,y+d,z),iso(x+w,y,z)], side);
    polygon([a,b,c,e],top);
  }
  function ellipse(x, y, rx, ry, color) { ctx.beginPath(); ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2); ctx.fillStyle=color;ctx.fill(); }
  function line(a,b,color,width=2) { ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap="round";ctx.stroke(); }
  function label(text, x, y, color = "#405674", size = 10, bold = false) { ctx.font=`${bold?650:450} ${size}px system-ui,sans-serif`;ctx.textAlign="center";ctx.fillStyle=color;ctx.fillText(text,x,y); }
  function rounded(x,y,w,h,r,color) { ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=color;ctx.fill(); }
  function plant(x,y,size=1) {
    const p=iso(x,y);ellipse(p.x,p.y+2,14*size,7*size,"#23395016");box(x-.17,y-.17,.34,.34,0,16*size,"#e4d4bc","#b9a88f","#cbbba5");
    for(let i=0;i<6;i++){const angle=i*Math.PI/3;const px=p.x+Math.cos(angle)*10*size,py=p.y-26*size+Math.sin(angle)*10*size;line({x:p.x,y:p.y-14*size},{x:px,y:py},"#458f7e",2);ctx.save();ctx.translate(px,py);ctx.rotate(angle);ellipse(0,0,5*size,12*size,i%2?"#438b74":"#69aa86");ctx.restore();}
  }
  function person(x,y,index,time,{working=false,walking=false,carry=false}={}) {
    const p=iso(x,y),phase=time*.008+index*1.7,bob=walking?Math.abs(Math.sin(phase))*2:Math.sin(time*.0015+index)*.7;
    const px=p.x,py=p.y-bob,shirt=shirts[index%shirts.length],tone=skin[index%skin.length];
    ellipse(px,p.y+2,12,5,"#263e5a20");
    const stride=walking?Math.sin(phase)*7:0;
    line({x:px-4,y:py-10},{x:px-4+stride,y:py+1},"#35445d",5);line({x:px+4,y:py-10},{x:px+4-stride,y:py+1},"#35445d",5);
    rounded(px-11,py-35,22,26,8,shirt);ellipse(px,py-39,9,11,tone);
    ctx.beginPath();ctx.arc(px,py-43,9,Math.PI,Math.PI*2);ctx.lineTo(px+9,py-40);ctx.lineTo(px-9,py-42);ctx.fillStyle=index%3===0?"#704e42":"#293b51";ctx.fill();
    const typing=working?Math.sin(time*.025+index)*3:0, swing=walking?Math.sin(phase)*6:0;
    line({x:px-8,y:py-29},{x:px-18+swing,y:py-22+typing},shirt,6);line({x:px+8,y:py-29},{x:px+16-swing,y:py-24-typing},shirt,6);
    ellipse(px-18+swing,py-22+typing,3,3,tone);ellipse(px+16-swing,py-24-typing,3,3,tone);
    if(carry){rounded(px+10,py-28,15,12,2,"#f8fbff");line({x:px+13,y:py-24},{x:px+21,y:py-24},"#7698d0",1);line({x:px+13,y:py-20},{x:px+19,y:py-20},"#a4bddc",1);}
  }
  function desk(n,i,time,active) {
    const {x,y}=seatPos(i),p=iso(x+.65,y+.65);const selected=data.selected===i;
    if(active||selected){ellipse(p.x,p.y+26,65,30,active?"#527aef15":"#77b8cf16");ctx.beginPath();ctx.ellipse(p.x,p.y+26,67,31,0,0,Math.PI*2);ctx.strokeStyle=active?"#6b96e9":"#b2cfdd";ctx.lineWidth=1.3;ctx.stroke();}
    for(const [dx,dy] of [[0,0],[1.8,0],[0,1],[1.8,1]])box(x+dx,y+dy,.08,.08,0,35,"#bac6d4","#8a9eb5","#99aec3");
    box(x-.12,y-.12,2.1,1.35,35,5,"#f5eee4","#c8baa8","#ded2c1");
    const chair=iso(x+.9,y+1.6,12);ellipse(chair.x,chair.y+9,11,5,"#657993");rounded(chair.x-10,chair.y-13,20,18,6,"#7e91a8");
    const monitorX=x+.58,monitorY=y+.2;
    box(monitorX+.38,monitorY+.08,.12,.12,41,10,"#697e96");
    const m=[iso(monitorX,monitorY,72),iso(monitorX+1,monitorY,72),iso(monitorX+1,monitorY,49),iso(monitorX,monitorY,49)];polygon(m,"#263c58","#526c89");
    const screen=[iso(monitorX+.08,monitorY,69),iso(monitorX+.92,monitorY,69),iso(monitorX+.92,monitorY,52),iso(monitorX+.08,monitorY,52)];polygon(screen,active?"#234d8a":n.state==="done"?"#315b5c":"#3c516e");
    for(let j=0;j<3;j++){const tw=active ? .45+Math.sin(time*.005+j)*.1 : .5;line(iso(monitorX+.17,monitorY,65-j*4),iso(monitorX+.17+tw,monitorY,65-j*4),active?["#83d6ef","#d4e5ff","#83d6ef"][j]:"#8da7bc",1.5);}
    box(x+.66,y+.85,.75,.26,41,1,"#afbfd1");
    box(x+.12,y+.68,.17,.17,41,10,"#ffffff","#7ebed7","#a8d8e7");
    person(x+1,y+1.7,i,time,{working:active});
    const badge=iso(x+.9,y+1.65,-17);const title=n.name.length>21?n.name.slice(0,19)+"…":n.name;
    const bw=Math.min(150,Math.max(85,title.length*5.8+20));rounded(badge.x-bw/2,badge.y,bw,21,7,selected?"#e7efff":"#ffffffed");
    ellipse(badge.x-bw/2+9,badge.y+10,2.5,2.5,statusColor[n.state]||"#8291a6");label(title,badge.x+4,badge.y+14,selected?"#143197":"#405674",9,true);
    hitAreas.push({i,x:badge.x-64,y:p.y-72,w:128,h:142});
  }
  function room(time) {
    polygon([iso(0,0),iso(12.4,0),iso(12.4,11.2),iso(0,11.2)],"#dfe7ed");
    for(let x=0;x<12;x++)for(let y=0;y<11;y++)polygon([iso(x,y),iso(x+1,y),iso(x+1,y+1),iso(x,y+1)],(x+y)%2?"#e9edf0":"#e3e9ec","#d8e0e633");
    polygon([iso(0,0),iso(0,11.2),iso(0,11.2,122),iso(0,0,122)],"#d3e0ec");
    polygon([iso(0,0),iso(12.4,0),iso(12.4,0,122),iso(0,0,122)],"#edf2f6");
    for(let j=1;j<=4;j++){
      const x=j*2.35;polygon([iso(x,0,100),iso(x+1.65,0,100),iso(x+1.65,0,41),iso(x,0,41)],"#b4d7e6","#fafcff");
      line(iso(x+.82,0,100),iso(x+.82,0,41),"#f8fbfc",3);line(iso(x,0,70),iso(x+1.65,0,70),"#f8fbfc",2);
      polygon([iso(x,0,40),iso(x+1.65,0,40),iso(x+1.65,2.4,0),iso(x,2.4,0)],"#fcf9e526");
    }
    const wall=iso(0,5,75);ctx.save();ctx.translate(wall.x,wall.y);ctx.rotate(-Math.atan(.5));label("CLOUDSEALS",0,0,"#2c527d",16,true);label("TRUSTOPS OPERATIONS",0,18,"#6e89a6",7,true);ctx.restore();
    box(.6,8.4,1.7,.6,0,30,"#829eae","#5e7f93","#7392a3");box(.5,8.35,1.9,.15,25,19,"#91adba","#7695a5","#829fac");
    plant(.65,.6,.95);plant(11.9,.7,.9);plant(.7,10.4,1.1);plant(11.7,10.6,1.1);
    box(8.5,10,2.2,.8,0,34,"#eee6db","#bba995","#d6c6b3");
    const review=iso(9.6,10.7,-20);rounded(review.x-62,review.y,124,22,7,"#ffffffed");label("HUMAN REVIEW",review.x,review.y+14,"#526b8b",9,true);
    person(9.4,10.9,5,time);
    const previewIndex=Math.floor(time/2900)%Math.max(1,data.nodes.length);
    const objects=data.nodes.map((n,i)=>({depth:seatPos(i).x+seatPos(i).y+.8,draw:()=>desk(n,i,time,data.preview?i===previewIndex:n.state==="running")}));
    // A file courier illustrates a handoff; it is not another executing AI agent.
    const pathIndex=data.preview?previewIndex:Math.max(0,data.current),previous=Math.max(0,pathIndex-1);
    const handoffProgress=data.preview?(time%2900)/2900:Math.min(1,(time-handoffAt)/2200);
    if((data.preview||time-handoffAt<2200)&&pathIndex>0){
      const a=seatPos(previous),b=seatPos(pathIndex);const t=Math.max(0,handoffProgress);
      const x=a.x+1.9+(b.x-a.x)*t,y=a.y+2+(b.y-a.y)*t;
      objects.push({depth:x+y,draw:()=>person(x,y,8,time,{walking:true,carry:true})});
    }
    // Ambient office motion is decorative, even when no backend request is active.
    const walk=(Math.sin(time*.00024)+1)/2,px=3+walk*4.8,py=9.9;
    objects.push({depth:px+py,draw:()=>person(px,py,3,time,{walking:true,carry:false})});
    objects.sort((a,b)=>a.depth-b.depth).forEach(o=>o.draw());
    const captionPoint=iso(6.2,11.6,-35);label(data.preview?"ANIMATION PREVIEW · NO AGENTS EXECUTED":"WORKFLOW STATES DRIVE THE DESKS · OFFICE MOTION IS DECORATIVE",captionPoint.x,captionPoint.y,"#6c819b",8,true);
  }
  function draw(time) {
    if(!ctx)return;
    const dpr=Math.min(window.devicePixelRatio||1,2),r=canvas.getBoundingClientRect();width=Math.max(1,r.width);height=Math.max(1,r.height);
    if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle="#f4f7fa";ctx.fillRect(0,0,width,height);
    const s=Math.min(width/W,height/H)*zoom;ctx.translate(width/2,height/2);ctx.scale(s,s);ctx.translate(-W/2,-H/2);
    hitAreas=[];room(motion.matches?0:time);
  }
  function animate(time) {
    if(!root.isConnected){frame=null;return;}
    if(motion.matches){draw(0);frame=null;return;}
    if(time-lastFrame>32){draw(time);lastFrame=time;}
    frame=requestAnimationFrame(animate);
  }
  function kick() { if(frame===null)frame=requestAnimationFrame(animate); }
  canvas.addEventListener("click",e=>{
    const r=canvas.getBoundingClientRect(),s=Math.min(r.width/W,r.height/H)*zoom;
    const x=(e.clientX-r.left-r.width/2)/s+W/2,y=(e.clientY-r.top-r.height/2)/s+H/2;
    const hit=[...hitAreas].reverse().find(h=>x>=h.x&&x<=h.x+h.w&&y>=h.y&&y<=h.y+h.h);
    if(hit)onSelect(hit.i);
  });
  canvas.addEventListener("pointermove",e=>{
    const r=canvas.getBoundingClientRect(),s=Math.min(r.width/W,r.height/H)*zoom,x=(e.clientX-r.left-r.width/2)/s+W/2,y=(e.clientY-r.top-r.height/2)/s+H/2;
    canvas.style.cursor=hitAreas.some(h=>x>=h.x&&x<=h.x+h.w&&y>=h.y&&y<=h.y+h.h)?"pointer":"default";
  });
  return { element:root, zoom(delta){zoom=Math.max(.85,Math.min(1.5,zoom+delta));draw(performance.now());},
    update(next){
      if(next.current!==lastStep){handoffAt=performance.now();lastStep=next.current;}
      data=next;
      caption.textContent=next.preview?"Animation preview: fictional office activity only. No backend calls or approvals are made.":"Click a desk to inspect its actual status and output. Walking, breathing and room lighting are decorative.";
      seats.replaceChildren(...next.nodes.map((n,i)=>el("button",{type:"button",class:`office-seat is-${n.state}`,"aria-pressed":String(next.selected===i),onclick:()=>onSelect(i)},el("i",{}),n.name,el("small",{},n.state))));
      kick();
    }
  };
}
