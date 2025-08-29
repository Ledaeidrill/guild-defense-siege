// === CONFIG ===
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwSwLs7MdkDR_PgubrCEL7GQvpCL8D0gGYlQ2JSCMHYY4xQ1YKvpTSMN6aDsmCt6xXCvA/exec';
const TOKEN = 'Chaos_Destiny';

// Admin (facultatif) via ?admin=XXXX
function getParam(name){ const u=new URL(location.href); return u.searchParams.get(name); }
const ADMIN_TOKEN_PARAM = getParam('admin');
const isAdmin = () => !!ADMIN_TOKEN_PARAM;

// === UI état ===
let picks = []; // {id,name,icon}
let inFlight = false;

// Onglets
const tabReport = document.getElementById('tab-report');
const tabStats  = document.getElementById('tab-stats');
const tabDone   = document.getElementById('tab-done');
const pageReport= document.getElementById('page-report');
const pageStats = document.getElementById('page-stats');
const pageDone  = document.getElementById('page-done');

function activateTab(tabBtn, pageEl){
  [tabReport,tabStats,tabDone].forEach(b=>b.classList.remove('active'));
  tabBtn.classList.add('active');
  [pageReport,pageStats,pageDone].forEach(p=>p.classList.add('hidden'));
  pageEl.classList.remove('hidden');
}
tabReport.onclick = () => activateTab(tabReport, pageReport);
tabStats.onclick  = () => { activateTab(tabStats, pageStats); loadStats(); };
tabDone.onclick   = () => { activateTab(tabDone, pageDone);  loadHandled(); };

// Build grid
const grid = document.getElementById('monster-grid');
const search = document.getElementById('search');

function normalize(s){ return (s||'').toString().trim().toLowerCase(); }

function matchesQuery(m, qRaw){
  const q = normalize(qRaw);
  if (!q) return true;
  const tokens = q.split(/\s+/);
  const hay = new Set([
    normalize(m.name),
    normalize(m.unawakened_name),
    normalize(m.element),
    ...(m.aliases||[]).map(normalize),
  ]);
  return tokens.every(t => { for (const h of hay) if (h.includes(t)) return true; return false; });
}

const ELEMENT_ORDER = ['Fire','Water','Wind','Light','Dark'];
const elemRank = el => { const i = ELEMENT_ORDER.indexOf(el); return i===-1?999:i; };

function fixIconUrl(src){
  if (!src) return src;
  if (src.startsWith('https://swarfarm.com/unit_icon_')) {
    return src.replace('https://swarfarm.com/', 'https://swarfarm.com/static/herders/images/monsters/');
  }
  if (src.startsWith('/unit_icon_')) {
    return 'https://swarfarm.com/static/herders/images/monsters' + src;
  }
  if (src.startsWith('/static/herders/images/monsters/')) {
    return 'https://swarfarm.com' + src;
  }
  return src;
}

function makeCard(m){
  const card = document.createElement('div');
  card.className = 'card';
  card.title = `${m.name}`;
  card.onclick = () => addPick(m);

  const img = document.createElement('img');
  img.src = fixIconUrl(m.icon || '');
  img.alt = m.name;
  img.onerror = () => {
    if (!img.dataset.tried && img.src.includes('swarfarm.com/')) {
      img.dataset.tried = '1';
      img.src = img.src.replace('swarfarm.com/', 'https://swarfarm.com/static/herders/images/monsters/');
    } else { img.remove(); }
  };
  card.appendChild(img);

  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = m.name;
  card.appendChild(span);

  return card;
}

function renderGrid() {
  const q = (search.value||'').trim();
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();

  (window.MONSTERS || [])
    .filter(m => matchesQuery(m, q))
    .sort((a,b) => {
      const er = elemRank(a.element) - elemRank(b.element);
      return er !== 0 ? er : a.name.localeCompare(b.name,'en',{sensitivity:'base'});
    })
    .forEach(m => frag.appendChild(makeCard(m)));

  grid.appendChild(frag);
}

// Débounce sur la recherche
let _searchTimer;
search.addEventListener('input', () => { clearTimeout(_searchTimer); _searchTimer = setTimeout(renderGrid, 120); });
renderGrid();

// Sélection
function addPick(m) {
  if (picks.find(p => p.id === m.id)) return;
  if (picks.length >= 3) { 
    toast('Tu as déjà 3 monstres. Retire-en un.'); 
    return; 
  }
  picks.push(m);
  renderPicks();

  // ✅ Réinitialiser la recherche et recharger la grille complète
  search.value = '';
  renderGrid();
}


function renderPicks() {
  const zone = document.getElementById('picks');
  zone.innerHTML = '';
  picks.forEach((p, index) => {
    const div = document.createElement('div');
    div.className = 'pick';
    div.dataset.id = p.id;
    div.dataset.index = index;
    div.draggable = true;   // ✅ permet le drag

    // … bouton close + image + label identiques
    const btn = document.createElement('button');
    btn.className = 'close';
    btn.type = 'button';
    btn.title = 'Retirer';
    btn.textContent = '✕';
    btn.setAttribute('data-id', p.id);

    const img = document.createElement('img');
    img.src = fixIconUrl(p.icon); img.alt = p.name;

    const label = document.createElement('div');
    label.className = 'pname';
    label.textContent = p.name;

    div.append(btn, img, label);
    zone.appendChild(div);
  });

  enableDragAndDrop(zone);
}

document.getElementById('picks').addEventListener('click', (e) => {
  const btn = e.target.closest('.close');
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  const id = Number(btn.getAttribute('data-id'));
  removePick(id);
});
function removePick(id) {
  picks = picks.filter(p => p.id !== id);
  renderPicks();
}

function enableDragAndDrop(container) {
  let dragSrcEl = null;

  container.querySelectorAll('.pick').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      dragSrcEl = el;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.index);
      el.classList.add('dragging');
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    el.addEventListener('drop', (e) => {
      e.stopPropagation();
      const srcIndex = parseInt(e.dataTransfer.getData('text/plain'));
      const destIndex = parseInt(el.dataset.index);
      if (srcIndex !== destIndex) {
        // réordonner picks[]
        const moved = picks.splice(srcIndex, 1)[0];
        picks.splice(destIndex, 0, moved);
        renderPicks(); // re-render pour indices propres
      }
      return false;
    });
  });
}

// Envoi + protection double clic + feedback
const sendBtn = document.getElementById('send');
sendBtn.onclick = async () => {
  if (inFlight) return;
  if (picks.length !== 3) return toast('Sélectionne exactement 3 monstres.');
  const player = document.getElementById('player').value;
  const notes  = document.getElementById('notes').value;
  const monsters = picks.map(p => p.name);

  try {
    inFlight = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');

    const payload = JSON.stringify({ token: TOKEN, player, monsters, notes });
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'payload=' + encodeURIComponent(payload)
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('Réponse invalide: ' + text); }

    // ✅ cas "déjà traitée"
    if (json.already_handled) {
      toast(json.message || 'Défense déjà traitée — va voir ingame les counters.');
      picks = []; renderPicks(); document.getElementById('notes').value='';
      return;
    }

    if (!json.ok) {
      toast(json.error || 'Erreur');
      return; // ne pas vider la sélection
    }

    toast('Défense enregistrée ✅');
    picks = []; renderPicks(); document.getElementById('notes').value='';
  } catch (e) {
    console.error(e);
    toast('Échec de l’envoi. Vérifie l’URL/token ou le déploiement.');
  } finally {
    inFlight = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove('sending');
  }
};

// ===== Top défenses / Défs traitées =====

// Index rapide nom -> monstre
const MONS_BY_NAME = (() => {
  const m = new Map();
  (window.MONSTERS || []).forEach(x => m.set((x.name||'').toLowerCase(), x));
  return m;
})();
function findMonsterByName(n){ return MONS_BY_NAME.get((n||'').toLowerCase()) || null; }

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function cardHtmlByName(name){
  const d = findMonsterByName(name) || { name, icon:'' };
  const src = fixIconUrl(d.icon||'');
  return `
    <div class="pick def-pick">
      <img src="${src}" alt="${escapeHtml(d.name)}" loading="lazy">
      <div class="pname">${escapeHtml(d.name)}</div>
    </div>`;
}

async function loadStats() {
  const box = document.getElementById('stats');
  box.innerHTML = 'Chargement…';
  try {
    const url = `${APPS_SCRIPT_URL}?token=${encodeURIComponent(TOKEN)}&mode=stats`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Erreur');

    const rows = json.stats || [];
    if (!rows.length) { box.innerHTML = 'Aucune donnée pour l’instant.'; return; }

    let html = `<div class="def-list">`;
    for (const r of rows) {
      const trio = (r.trio || r.key.split(' / '));
      html += `
        <div class="def-row">
          <div class="def-item">
            <div class="def-trio">
              ${trio.map(cardHtmlByName).join('')}
            </div>
            <div class="def-count">${r.count}</div>
          </div>
          ${isAdmin() ? `<button class="btn-ghost act-handle" data-key="${escapeHtml(r.key)}">Traiter</button>` : ``}
        </div>`;
    }
    html += `</div>`;
    box.innerHTML = html;

    if (isAdmin()) {
      const list = box.querySelector('.def-list');
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('.act-handle');
        if (!btn) return;
        const key = btn.getAttribute('data-key');
        if (!key) return;
        moveToHandled(key);
      });
    }
  } catch (e) {
    console.error(e);
    box.innerHTML = 'Impossible de charger les stats.';
  }
}

async function loadHandled() {
  const box = document.getElementById('done');
  box.innerHTML = 'Chargement…';
  try {
    const url = `${APPS_SCRIPT_URL}?token=${encodeURIComponent(TOKEN)}&mode=handled`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Erreur');

    const rows = json.handled || [];
    if (!rows.length) { box.innerHTML = 'Aucune défense traitée pour le moment.'; return; }

    const list = document.createElement('div');
    list.className = 'def-list';

    rows.forEach(r => {
      const item = document.createElement('div');
      item.className = 'def-item';

      const trio = document.createElement('div');
      trio.className = 'def-trio';

      (r.trio || r.key.split(' / ')).forEach(name => {
        const data = findMonsterByName(name) || { name, icon:'' };
        const card = document.createElement('div');
        card.className = 'pick def-pick';

        const img = document.createElement('img');
        img.src = fixIconUrl(data.icon||''); img.alt = data.name;
        img.onerror = () => { img.remove(); };

        const label = document.createElement('div');
        label.className = 'pname';
        label.textContent = data.name;

        card.append(img, label);
        trio.appendChild(card);
      });

      if (isAdmin()) {
        const right = document.createElement('div');
        right.className = 'def-actions';
        const btn = document.createElement('button');
        btn.className = 'btn-ghost';
        btn.textContent = 'Rétablir';
        btn.onclick = () => unhandle(r.key);
        right.appendChild(btn);
        item.append(trio, right);
      } else {
        item.append(trio);
      }

      list.appendChild(item);
    });

    box.innerHTML = '';
    box.appendChild(list);
  } catch (e) {
    console.error(e);
    box.innerHTML = 'Impossible de charger les défenses traitées.';
  }
}

// Actions admin
async function moveToHandled(key){
  console.log(">>> [moveToHandled] key:", key);
  try{
    const payload = JSON.stringify({ action:'handle', admin_token: ADMIN_TOKEN_PARAM, key });
    const res = await fetch(APPS_SCRIPT_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'payload=' + encodeURIComponent(payload)
    });
    console.log(">>> [moveToHandled] HTTP:", res.status);
    const txt = await res.text(); console.log(">>> [moveToHandled] raw:", txt);
    const json = JSON.parse(txt);
    if (!json.ok) { toast(json.error || 'Action admin impossible.'); return; }
    toast('Défense déplacée dans "Défs traitées" ✅');
    await Promise.all([loadStats(), loadHandled()]);
  }catch(err){
    console.error(">>> [moveToHandled] err:", err); toast('Action admin impossible.');
  }
}

async function unhandle(key){
  console.log(">>> [unhandle] key:", key);
  try{
    const payload = JSON.stringify({ action:'unhandle', admin_token: ADMIN_TOKEN_PARAM, key });
    const res = await fetch(APPS_SCRIPT_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'payload=' + encodeURIComponent(payload)
    });
    console.log(">>> [unhandle] HTTP:", res.status);
    const txt = await res.text(); console.log(">>> [unhandle] raw:", txt);
    const json = JSON.parse(txt);
    if (!json.ok) { toast(json.error || 'Action admin impossible.'); return; }
    toast('Défense rétablie dans Top défenses ✅');
    await Promise.all([loadStats(), loadHandled()]);
  }catch(err){
    console.error(">>> [unhandle] err:", err); toast('Action admin impossible.');
  }
}

// Toast
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> { t.textContent = ''; t.classList.remove('show'); }, 2800);
}
