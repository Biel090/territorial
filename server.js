const http=require('http'),fs=require('fs'),path=require('path'),{WebSocketServer}=require('ws');
const W=288,H=112,WATER=255,NB=20,TICK=200,D4=[[1,0],[-1,0],[0,1],[0,-1]];
const page=fs.readFileSync(path.join(__dirname,'public','index.html'));
const server=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(page)});
const wss=new WebSocketServer({server}),rooms={};

function genMap(seed){
  let s=seed;const R=()=>(s=(s*1664525+1013904223)>>>0)/4294967296;
  const N=17,g=Array.from({length:N*N},R),m=new Uint8Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const fx=x/W*(N-3)+1,fy=y/H*(N-3)+1,ix=fx|0,iy=fy|0,ax=fx-ix,ay=fy-iy;
    const v=g[iy*N+ix]*(1-ax)*(1-ay)+g[iy*N+ix+1]*ax*(1-ay)+g[(iy+1)*N+ix]*(1-ax)*ay+g[(iy+1)*N+ix+1]*ax*ay;
    const e=Math.pow(Math.max(Math.abs(x/W-.5),Math.abs(y/H-.5))*2,3)*.3;
    m[y*W+x]=v-e>.45?0:WATER;
  }
  return m;
}
function loadMap(){try{const b=fs.readFileSync(path.join(__dirname,'world.bin'));if(b.length===W*H)return new Uint8Array(b);}catch{}return genMap(Math.random()*1e9|0);}
function addPlayer(r,name,team,bot){
  const p={id:r.players.length,name,team,bot,bal:100,tiles:0,alive:false,rate:0,skill:.3+Math.random()*.7};
  r.players.push(p);return p;
}
function set(r,i,id){const o=r.owner[i];if(o&&o!==WATER)r.players[o].tiles--;r.owner[i]=id;if(id)r.players[id].tiles++;r.ch.push(i,id);}
function spawn(r,p,x,y){
  if(x<7||y<7||x>=W-7||y>=H-7||r.owner[y*W+x]!==0)return false;
  for(let dy=-6;dy<=6;dy++)for(let dx=-6;dx<=6;dx++){const o=r.owner[(y+dy)*W+x+dx];if(o&&o!==WATER)return false;}
  for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)if(dx*dx+dy*dy<=9&&r.owner[(y+dy)*W+x+dx]===0)set(r,(y+dy)*W+x+dx,p.id);
  p.alive=true;p.bal=100;return true;
}
function newRoom(code){
  const r={code,owner:loadMap(),players:[null],attacks:[],boats:[],ch:[],clients:new Set(),land:0,t:0};
  for(const v of r.owner)if(v===0)r.land++;
  for(let i=1;i<=NB;i++){const p=addPlayer(r,'Bot '+i,i,true);
    for(let k=0;k<300&&!p.alive;k++)spawn(r,p,Math.random()*W|0,Math.random()*H|0);}
  r.timer=setInterval(()=>tick(r),TICK);rooms[code]=r;return r;
}
function attack(r,p,tx,ty,pct){
  if(!p.alive||tx<0||ty<0||tx>=W||ty>=H)return;
  const O=r.owner,t=O[ty*W+tx];
  if(t===WATER||t===p.id||(t&&r.players[t].team===p.team))return;
  const troops=p.bal*Math.min(1,Math.max(.01,pct));if(troops<5)return;
  let at=r.attacks.find(a=>a.a===p.id&&a.t===t&&!a.done);
  const fr=at?at.fr:new Set();
  for(let k=0;k<W*H;k++)if(O[k]===t){const x=k%W,y=(k/W)|0;
    for(const[dx,dy]of D4){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<W&&ny<H&&O[ny*W+nx]===p.id){fr.add(k);break;}}}
  if(!fr.size)return;
  p.bal-=troops;
  if(at)at.troops+=troops;else r.attacks.push({a:p.id,t,troops,fr,done:false});
}
function boat(r,p,tx,ty,pct){
  if(!p.alive||tx<0||ty<0||tx>=W||ty>=H)return;
  const O=r.owner;let L=-1,bd=1e9;
  for(let dy=-6;dy<=6;dy++)for(let dx=-6;dx<=6;dx++){const x=tx+dx,y=ty+dy;if(x<0||y<0||x>=W||y>=H)continue;
    const o=O[y*W+x],d=dx*dx+dy*dy;if(o!==WATER&&o!==p.id&&!(o&&r.players[o].team===p.team)&&d<bd){bd=d;L=y*W+x;}}
  if(L<0)return;
  const lx=L%W,ly=(L/W)|0,c=[];
  for(let k=0;k<W*H;k++)if(O[k]===p.id){const x=k%W,y=(k/W)|0;
    if(D4.some(([a,b])=>x+a>=0&&y+b>=0&&x+a<W&&y+b<H&&O[(y+b)*W+x+a]===WATER))c.push([k,x,y,(x-lx)**2+(y-ly)**2]);}
  c.sort((a,b)=>a[3]-b[3]);
  for(const [k,x,y,d2] of c.slice(0,25)){
    const n=Math.ceil(Math.sqrt(d2));if(n<2||n>70)continue;let ok=true;
    for(let s=1;s<n&&ok;s++)if(O[Math.round(y+(ly-y)*s/n)*W+Math.round(x+(lx-x)*s/n)]!==WATER)ok=false;
    if(!ok)continue;
    const troops=p.bal*Math.min(1,Math.max(.01,pct));if(troops<5)return;
    p.bal-=troops;r.boats.push({a:p.id,sx:x,sy:y,lx,ly,L,troops:troops*.96875,t0:r.t,dur:Math.ceil(n/2)});return;}
}
function runBoats(r){
  const O=r.owner,P=r.players;
  r.boats=r.boats.filter(b=>{
    if(r.t<b.t0+b.dur)return true;
    const A=P[b.a],t=O[b.L];
    if(!A.alive||t===WATER||t===b.a||(t&&P[t].team===A.team)){if(A.alive)A.bal+=b.troops;return false;}
    const fr=new Set();
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){const x=b.lx+dx,y=b.ly+dy;if(x>=0&&y>=0&&x<W&&y<H&&O[y*W+x]===t)fr.add(y*W+x);}
    r.attacks.push({a:b.a,t,troops:b.troops,fr,done:false});return false;});
}
function runAttacks(r){
  const O=r.owner,P=r.players;
  for(const at of r.attacks){
    const A=P[at.a],D=at.t?P[at.t]:null;let n=Math.min(at.fr.size,3+Math.floor(Math.sqrt(at.troops)/2));
    for(const i of at.fr){
      if(n--<=0)break;at.fr.delete(i);if(O[i]!==at.t)continue;
      const dens=D?D.bal/Math.max(D.tiles,1):0,cost=D?Math.max(1,dens*1.17):1;
      if(at.troops<cost){at.troops=0;break;}
      at.troops-=cost;if(D)D.bal=Math.max(0,D.bal-dens);
      set(r,i,at.a);
      const x=i%W,y=(i/W)|0;
      for(const[dx,dy]of D4){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<W&&ny<H&&O[ny*W+nx]===at.t)at.fr.add(ny*W+nx);}
    }
    if(!A.alive||at.troops<1||!at.fr.size){if(A.alive)A.bal+=at.troops;at.done=true;}
  }
  r.attacks=r.attacks.filter(a=>!a.done);
}
function botThink(r,b){
  const O=r.owner,P=r.players,neu=[],en=[];
  for(let k=0;k<80;k++){
    const x=Math.random()*W|0,y=Math.random()*H|0,t=O[y*W+x];
    if(t===WATER||t===b.id)continue;
    let adj=false;for(const[dx,dy]of D4){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<W&&ny<H&&O[ny*W+nx]===b.id){adj=true;break;}}
    if(!adj)continue;
    if(t===0)neu.push([x,y]);else en.push([x,y,P[t].bal/Math.max(P[t].tiles,1)]);
  }
  const pct=.3+.4*b.skill;
  if(neu.length&&b.bal>20){const c=neu[0];attack(r,b,c[0],c[1],pct*.7);}
  else if(en.length){en.sort((a,c)=>a[2]-c[2]);const c=en[0];if(b.bal*pct>c[2]*(10-6*b.skill))attack(r,b,c[0],c[1],pct);}
}
function send(r,o){const s=JSON.stringify(o);for(const c of r.clients)if(c.readyState===1)c.send(s);}
function tick(r){
  r.t++;runAttacks(r);runBoats(r);
  for(const p of r.players)if(p&&p.alive&&p.tiles===0){p.alive=false;p.bal=0;}
  if(r.t%5===0){
    for(const p of r.players){if(!p||!p.alive)continue;
      p.rate=.02*Math.max(0,1-p.bal/(100*p.tiles));
      p.bal+=p.tiles*.3+p.bal*p.rate;
      if(p.bot&&Math.random()<.25+.5*p.skill)botThink(r,p);}
    send(r,{t:'s',p:r.players.slice(1).map(p=>[p.id,p.name,p.tiles,Math.floor(p.bal),p.alive,p.rate])});
  }
  if(r.boats.length||r.hadBoats){r.hadBoats=r.boats.length>0;
    send(r,{t:'b',b:r.boats.map(b=>{const f=Math.min(1,(r.t-b.t0)/b.dur);return[b.sx+(b.lx-b.sx)*f,b.sy+(b.ly-b.sy)*f,b.a];})});}
  if(r.ch.length){send(r,{t:'d',c:r.ch});r.ch=[];}
}
wss.on('connection',ws=>{
  let r=null,p=null;
  ws.on('message',m=>{
    let d;try{d=JSON.parse(m)}catch{return}
    if(d.t==='join'&&!r){
      const code=String(d.room||'').toUpperCase().slice(0,4);
      if(code&&!rooms[code])return ws.send(JSON.stringify({t:'err',m:'Aquesta sala no existeix'}));
      const room=code?rooms[code]:newRoom(Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join(''));
      if(room.clients.size>=4)return ws.send(JSON.stringify({t:'err',m:'Sala plena'}));
      r=room;p=addPlayer(r,String(d.name||'Jugador').slice(0,16),0,false);r.clients.add(ws);
      ws.send(JSON.stringify({t:'init',code:r.code,w:W,h:H,nb:NB,me:p.id,land:r.land,owner:Buffer.from(r.owner).toString('base64')}));
    }else if(r&&d.t==='spawn'&&!p.alive)spawn(r,p,d.x|0,d.y|0);
    else if(r&&d.t==='atk')attack(r,p,d.x|0,d.y|0,+d.pct||.3);
    else if(r&&d.t==='boat')boat(r,p,d.x|0,d.y|0,+d.pct||.3);
    else if(r&&d.t==='give'){const o=r.players[d.to|0];if(o&&!o.bot&&o!==p&&o.alive&&p.alive){const a=p.bal*Math.min(.5,Math.max(.01,+d.pct||.25));p.bal-=a;o.bal+=a;}}
  });
  ws.on('close',()=>{
    if(!r)return;r.clients.delete(ws);
    if(p.alive){for(let i=0;i<W*H;i++)if(r.owner[i]===p.id)set(r,i,0);p.alive=false;p.bal=0;}
    if(!r.clients.size){clearInterval(r.timer);delete rooms[r.code];}
  });
});
server.listen(process.env.PORT||3000,()=>console.log('Servidor a http://localhost:'+(process.env.PORT||3000)));
