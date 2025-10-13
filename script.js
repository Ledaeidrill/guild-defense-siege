// =====================
// CONFIG
// =====================
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwSwLs7MdkDR_PgubrCEL7GQvpCL8D0gGYlQ2JSCMHYY4xQ1YKvpTSMN6aDsmCt6xXCvA/exec';
const TOKEN = 'Chaos_Destiny';
const ADMIN_TOKEN_PARAM = new URL(location.href).searchParams.get('admin');
const isAdmin = () => !!ADMIN_TOKEN_PARAM;

// =====================
// HELPERS
// =====================
const qs = (sel, root=document) => root.querySelector(sel);
const normalize = s => (s||'').toString().trim().toLowerCase();
let CURRENT_DEF_KEY = null;
let OFFS_CHOICES = [];

function toast(msg){
  const t = qs('#toast');
  if(!t){ alert(msg); return; }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>{ t.textContent=''; t.classList.remove('show'); }, 2800);
}

function fixIconUrl(src){
  if(!src) return src;
  if(src.startsWith('https://swarfarm.com/unit_icon_'))
    return src.replace('https://swarfarm.com/', 'https://swarfarm.com/static/herders/images/monsters/');
  if(src.startsWith('/unit_icon_'))
    return 'https://swarfarm.com/static/herders/images/monsters' + src;
  if(src.startsWith('/static/herders/images/monsters/'))
    return 'https://swarfarm.com' + src;
  return src;
}

async function apiPost(payloadObj){
  const payload = JSON.stringify(payloadObj);
  const res = await fetch(APPS_SCRIPT_URL,{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},
    body:'payload='+encodeURIComponent(payload)
  });
  const txt = await res.text();
  try{ return JSON.parse(txt); }catch{ return {ok:false,error:'Réponse invalide',raw:txt}; }
}

function ensureTrioArray(trio,key){
  if(Array.isArray(trio)) return trio;
  if(trio && typeof trio==='object') return Object.values(trio);
  return String(key||'').split(' / ');
}

// =====================
// ONGLET / ÉTAT
// =====================
let picks=[];
let inFlight=false;

const tabReport=qs('#tab-report');
const tabStats =qs('#tab-stats');
const tabDone  =qs('#tab-done');
const pageReport=qs('#page-report');
const pageStats =qs('#page-stats');
const pageDone  =qs('#page-done');

function activateTab(tabBtn,pageEl){
  [tabReport,tabStats,tabDone].forEach(b=>b?.classList.remove('active'));
  tabBtn?.classList.add('active');
  [pageReport,pageStats,pageDone].forEach(p=>p?.classList.add('hidden'));
  pageEl?.classList.remove('hidden');
}
tabReport?.addEventListener('click',()=>activateTab(tabReport,pageReport));
tabStats ?.addEventListener('click',()=>{activateTab(tabStats,pageStats);loadStats();});
tabDone  ?.addEventListener('click',()=>{activateTab(tabDone,pageDone);loadHandled();});

// =====================
// INDEX MONSTRES
// =====================
const MONS_BY_NAME = (()=>{ const m=new Map();(window.MONSTERS||[]).forEach(x=>m.set((x.name||'').toLowerCase(),x));return m;})();
const findMonsterByName = n => MONS_BY_NAME.get((n||'').toLowerCase())||null;

function cardHtmlByName(name){
  const d=findMonsterByName(name)||{name,icon:''};
  const src=fixIconUrl(d.icon||'');
  return `<div class="pick def-pick"><img src="${src}" alt="${d.name}"><div class="pname">${d.name}</div></div>`;
}

// =====================
// ENVOI DEF
// =====================
qs('#send')?.addEventListener('click', async ()=>{
  if(inFlight) return;
  if(picks.length!==3) return toast('Sélectionne exactement 3 monstres.');
  const player=qs('#player')?.value||'', notes=qs('#notes')?.value||'', monsters=picks.map(p=>p.name);
  try{
    inFlight=true;
    qs('#send').disabled=true;
    qs('#send').classList.add('sending');
    const json=await apiPost({mode:'submit',token:TOKEN,player,monsters,notes});
    if(json.already_handled){ toast(json.message||'Déjà traitée'); picks=[];renderPicks(); qs('#notes').value=''; return; }
    if(!json.ok){ toast(json.error||'Erreur'); return; }
    toast('Défense enregistrée ✅'); picks=[];renderPicks();qs('#notes').value='';
  }catch(e){console.error(e);toast('Erreur réseau');}
  finally{inFlight=false;qs('#send').disabled=false;qs('#send').classList.remove('sending');}
});

// =====================
// TOP DEFENSES
// =====================
async function loadStats(){
  const box=document.getElementById('stats');
  box.innerHTML='Chargement…';
  try{
    const data=await apiPost({mode:'stats',token:TOKEN});
    if(!data.ok) return box.textContent='Erreur : '+(data.error||'inconnue');
    const rows=data.stats||[];
    if(!rows.length) return box.textContent='Aucune donnée.';
    let html=`<div class="def-list">`;
    for(const r of rows){
      const trio=ensureTrioArray(r.trio,r.key);
      html+=`<div class="def-row"><div class="def-item"><div class="def-trio">${trio.map(cardHtmlByName).join('')}</div><div class="def-count">${r.count??0}</div></div>${isAdmin()?`<button class="btn-ghost act-handle" data-key="${r.key}">Traiter</button>`:''}</div>`;
    }
    html+='</div>';
    box.innerHTML=html;
  }catch(e){console.error(e);box.textContent='Erreur chargement stats.';}
}

// =====================
// DEFENSES TRAITEES
// =====================
async function loadHandled(){
  const box=document.getElementById('done');
  box.innerHTML='Chargement…';
  try{
    const data=await apiPost({mode:'handled',token:TOKEN});
    if(!data.ok) return box.textContent='Erreur : '+(data.error||'inconnue');
    const rows=data.handled||[];
    if(!rows.length) return box.textContent='Aucune défense traitée.';

    const list=document.createElement('div');
    list.className='def-list';
    rows.forEach(r=>{
      const item=document.createElement('div');
      item.className='def-item';
      const trio=document.createElement('div');trio.className='def-trio';
      ensureTrioArray(r.trio,r.key).forEach(name=>{
        const m=findMonsterByName(name)||{name,icon:''};
        const c=document.createElement('div');c.className='pick def-pick';
        const img=document.createElement('img');img.src=fixIconUrl(m.icon||'');img.alt=m.name;
        const l=document.createElement('div');l.className='pname';l.textContent=m.name;
        c.append(img,l);trio.append(c);
      });
      const right=document.createElement('div');
      const b=document.createElement('button');b.className='btn-ghost';b.textContent='Voir les offs';
      b.onclick=()=>openOffsModal(r.key);
      right.append(b);
      item.append(trio,right);
      list.append(item);
    });
    box.innerHTML='';box.append(list);
  }catch(e){console.error(e);box.textContent='Erreur chargement défenses.';}
}

// =====================
// MODALE OFFS
// =====================
const offsModal=qs('#offs-modal');
const offsList=qs('#offs-list');
const offsChooser=qs('#offs-chooser');
const offsAddBtn=qs('#offs-add-btn');

function openOffsModal(defKey){
  CURRENT_DEF_KEY=defKey;
  qs('#offs-title').textContent=`Offenses pour : ${defKey}`;
  offsChooser.classList.add('hidden');
  offsList.classList.remove('hidden');
  if(offsAddBtn){
    offsAddBtn.style.display=isAdmin()?'':'none';
    offsAddBtn.onclick=()=>openOffsChooser();
  }
  offsModal.classList.remove('hidden');
  loadOffs(defKey);
}
function closeOffsModal(){CURRENT_DEF_KEY=null;offsModal.classList.add('hidden');}
qs('#offs-back').onclick=closeOffsModal;
qs('#offs-modal .modal-backdrop').onclick=closeOffsModal;
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeOffsModal();});

async function loadOffs(defKey){
  offsList.innerHTML='Chargement…';
  try{
    const data=await apiPost({mode:'get_offs',token:TOKEN,key:defKey});
    if(!data.ok) return offsList.textContent='Erreur chargement.';
    const offs=data.offs||[];
    if(!offs.length){offsList.innerHTML='<div class="hint">Aucune offense enregistrée.</div>';return;}
    offsList.innerHTML=offs.map(o=>buildOffRow(o).outerHTML||'').join('');
  }catch(e){console.error(e);offsList.textContent='Erreur chargement.';}
}

function buildOffRow(o){
  const row=document.createElement('div');row.className='off-row';
  const trio=document.createElement('div');trio.className='off-trio';
  (o.trio||[]).forEach(name=>{
    const m=findMonsterByName(name)||{name,icon:''};
    const c=document.createElement('div');c.className='off-pick';
    const img=document.createElement('img');img.src=fixIconUrl(m.icon||'');img.alt=m.name;
    const l=document.createElement('div');l.textContent=m.name;
    c.append(img,l);trio.append(c);
  });
  row.append(trio);return row;
}

// =====================
// AJOUT OFFENSE (CHOOSER)
// =====================
function openOffsChooser(){
  if(!isAdmin())return toast('Réservé aux admins.');
  OFFS_CHOICES=[];renderOffsPicks();
  offsList.classList.add('hidden');
  offsChooser.classList.remove('hidden');

  const grid=qs('#offs-grid');grid.innerHTML='';
  (window.MONSTERS||[]).forEach(m=>grid.append(buildMonsterCard(m)));

  const input=qs('#offs-search');
  input.value='';input.oninput=()=>filterMonsterGrid(input.value.trim().toLowerCase());

  qs('#offs-validate').disabled=true;
  qs('#offs-validate').onclick=submitOffense;
}

function buildMonsterCard(m){
  const d=document.createElement('div');
  d.className='mon-card';d.dataset.name=(m.name||'').toLowerCase();
  d.innerHTML=`<img src="${fixIconUrl(m.icon||'')}" alt="${m.name}"><div style="margin-top:6px;font-size:12px;">${m.name}</div>`;
  d.onclick=()=>toggleOffsPick(m,d);
  return d;
}

function toggleOffsPick(m,el){
  const i=OFFS_CHOICES.findIndex(x=>x.name===m.name);
  if(i>=0){OFFS_CHOICES.splice(i,1);el?.classList.remove('selected');}
  else{if(OFFS_CHOICES.length>=3)return;OFFS_CHOICES.push(m);el?.classList.add('selected');}
  renderOffsPicks();
}

function renderOffsPicks(){
  const z=qs('#offs-picks');z.innerHTML='';
  OFFS_CHOICES.forEach((p,i)=>{
    const d=document.createElement('div');d.className='pick';
    const b=document.createElement('button');b.className='close';b.textContent='✕';b.onclick=()=>{OFFS_CHOICES.splice(i,1);renderOffsPicks();};
    const img=document.createElement('img');img.src=fixIconUrl(p.icon||'');img.alt=p.name;
    const l=document.createElement('div');l.className='pname';l.textContent=p.name;
    d.append(b,img,l);z.append(d);
  });
  qs('#offs-validate').disabled=(OFFS_CHOICES.length!==3);
}

function filterMonsterGrid(q){
  document.querySelectorAll('#offs-grid .mon-card').forEach(c=>c.style.display=(!q||c.dataset.name.includes(q))?'':'none');
}

async function submitOffense(){
  if(!isAdmin())return toast('Réservé aux admins.');
  if(!CURRENT_DEF_KEY||OFFS_CHOICES.length!==3)return;
  const [o1,o2,o3]=OFFS_CHOICES.map(x=>x.name);
  const note=qs('#off-note').value.trim();
  const resp=await apiPost({mode:'add_off',admin_token:ADMIN_TOKEN_PARAM,key:CURRENT_DEF_KEY,o1,o2,o3,note,by:'admin'});
  if(!resp.ok)return toast(resp.error||'Échec ajout.');
  toast('Offense ajoutée ✅');
  offsChooser.classList.add('hidden');
  offsList.classList.remove('hidden');
  loadOffs(CURRENT_DEF_KEY);
}
