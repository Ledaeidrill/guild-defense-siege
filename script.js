// === CONFIG ===
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwSwLs7MdkDR_PgubrCEL7GQvpCL8D0gGYlQ2JSCMHYY4xQ1YKvpTSMN6aDsmCt6xXCvA/exec';
const TOKEN = 'Chaos_Destiny';

// === UI état ===
let picks = []; // {id,name,icon}

// Tabs
const tabReport = document.getElementById('tab-report');
const tabStats  = document.getElementById('tab-stats');
const pageReport= document.getElementById('page-report');
const pageStats = document.getElementById('page-stats');
const tabDone = document.getElementById('tab-done');
const pageDone = document.getElementById('page-done');

tabReport.onclick = () => { tabReport.classList.add('active'); tabStats.classList.remove('active'); pageReport.classList.remove('hidden'); pageStats.classList.add('hidden'); };
tabStats.onclick  = () => { tabStats.classList.add('active'); tabReport.classList.remove('active'); pageStats.classList.remove('hidden'); pageReport.classList.add('hidden'); loadStats(); };
tabDone.onclick = () => {
  tabDone.classList.add('active');
  tabReport.classList.remove('active'); tabStats.classList.remove('active');
  pageDone.classList.remove('hidden');
  pageReport.classList.add('hidden'); pageStats.classList.add('hidden');
  loadHandled();
};

// Build grid
const grid = document.getElementById('monster-grid');
const search = document.getElementById('search');

function normalize(s){ return (s||'').toString().trim().toLowerCase(); }

const ELEMENT_ORDER = ['Fire','Water','Wind','Light','Dark'];
const elemRank = (el) => {
  const i = ELEMENT_ORDER.indexOf(el);
  return i === -1 ? 999 : i;
};

function matchesQuery(m, qRaw){
  const q = normalize(qRaw);
  if (!q) return true;
  const tokens = q.split(/\s+/);

  // Recherche : nom éveillé, nom non éveillé, élément, aliases
  const hay = new Set([
    normalize(m.name),
    normalize(m.unawakened_name),
    normalize(m.element),
    ...(m.aliases||[]).map(normalize),
  ]);

  return tokens.every(t => {
    for (const h of hay) if (h.includes(t)) return true;
    return false;
  });
}

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
  card.title = `${m.name}${m.unawakened_name ? ` • ${m.unawakened_name}`:''}`;
  card.onclick = () => addPick(m);

  const img = document.createElement('img');
  img.src = fixIconUrl(m.icon || '');
  img.alt = m.name;
  img.onerror = () => {
    if (!img.dataset.tried && img.src.includes('swarfarm.com/')) {
      img.dataset.tried = '1';
      img.src = img.src.replace('swarfarm.com/', 'swarfarm.com/static/herders/images/monsters/');
    } else {
      img.remove();
    }
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
    // ⬇️ tri "comme avant" : élément puis nom
    .sort((a,b) => {
      const er = elemRank(a.element) - elemRank(b.element);
      return er !== 0 ? er : a.name.localeCompare(b.name,'en',{sensitivity:'base'});
    })
    .forEach(m => frag.appendChild(makeCard(m)));

  grid.appendChild(frag);
}

// Index rapide nom -> monstre (lowercase)
const MONS_BY_NAME = (() => {
  const m = new Map();
  (window.MONSTERS || []).forEach(x => m.set((x.name||'').toLowerCase(), x));
  return m;
})();
function findMonsterByName(n){
  return MONS_BY_NAME.get((n||'').toLowerCase()) || null;
}

// Débounce sur la recherche pour une UI fluide
let _searchTimer;
search.addEventListener('input', () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(renderGrid, 120);
});
renderGrid();

// Sélection
function addPick(m) {
  if (picks.find(p => p.id === m.id)) return;
  if (picks.length >= 3) { toast('Tu as déjà 3 monstres. Retire-en un.'); return; }
  picks.push(m);
  renderPicks();
}

function renderPicks() {
  const zone = document.getElementById('picks');
  zone.innerHTML = '';
  picks.forEach(p => {
    const div = document.createElement('div');
    div.className = 'pick';
    div.dataset.id = p.id;

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
}

// Délégation: capte les clics sur les boutons .close dans #picks
document.getElementById('picks').addEventListener('click', (e) => {
  const btn = e.target.closest('.close');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const id = btn.getAttribute('data-id');
  removePick(Number(id));
});

function removePick(id) {
  picks = picks.filter(p => p.id !== id);
  renderPicks();
}

// Envoi
document.getElementById('send').onclick = async () => {
  if (picks.length !== 3) return toast('Sélectionne exactement 3 monstres.');
  const player = document.getElementById('player').value;
  const notes  = document.getElementById('notes').value;
  const monsters = picks.map(p => p.name);

  try {
    const payload = JSON.stringify({ token: TOKEN, player, monsters, notes });
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'payload=' + encodeURIComponent(payload)
    });

    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Erreur');

    // ✅ retour visuel + reset sélection
    toast('Défense enregistrée ✅');
    picks = [];
    renderPicks();
    document.getElementById('notes').value = '';
    // (on garde le pseudo et la recherche tels quels)
  } catch (e) {
    console.error(e);
    toast('Échec de l’envoi. Vérifie l’URL/token ou le déploiement.');
  }
};

// Stats
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

      const right = document.createElement('div');
      right.style.display = 'flex'; right.style.alignItems = 'center'; right.style.gap = '8px';

      const cnt = document.createElement('div');
      cnt.className = 'def-count'; cnt.textContent = r.count;
      right.appendChild(cnt);

      if (isAdmin()) {
        const btn = document.createElement('button');
        btn.className = 'btn-ghost';
        btn.textContent = '→ Traiter';
        btn.onclick = () => moveToHandled(r.key);
        right.appendChild(btn);
      }

      item.append(trio, right);
      list.appendChild(item);
    });

    box.innerHTML = '';
    box.appendChild(list);
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

      const right = document.createElement('div');
      right.className = 'def-actions';

      if (isAdmin()) {
        const btn = document.createElement('button');
        btn.className = 'btn-ghost';
        btn.textContent = '↩︎ Rétablir';
        btn.onclick = () => unhandle(r.key);
        right.appendChild(btn);
      }

      item.append(trio, right);
      list.appendChild(item);
    });

    box.innerHTML = '';
    box.appendChild(list);
  } catch (e) {
    console.error(e);
    box.innerHTML = 'Impossible de charger les défenses traitées.';
  }
}


// Toast (feedback visuel)
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> { t.textContent = ''; t.classList.remove('show'); }, 3000);
}

// Admin mode
function getParam(name){
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}
const ADMIN_TOKEN_PARAM = getParam('admin'); // ex: ?admin=MON_TOKEN_ADMIN
function isAdmin(){ return !!ADMIN_TOKEN_PARAM; }

async function moveToHandled(key){
  try{
    const res = await fetch(APPS_SCRIPT_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ action:'handle', admin_token: ADMIN_TOKEN_PARAM, key })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error||'Erreur');
    toast('Défense déplacée dans "Défs traitées" ✅');
    await Promise.all([loadStats(), loadHandled()]);
  }catch(err){
    console.error(err); toast('Action admin impossible.');
  }
}
async function unhandle(key){
  try{
    const res = await fetch(APPS_SCRIPT_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ action:'unhandle', admin_token: ADMIN_TOKEN_PARAM, key })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error||'Erreur');
    toast('Défense rétablie dans Top défenses ✅');
    await Promise.all([loadStats(), loadHandled()]);
  }catch(err){
    console.error(err); toast('Action admin impossible.');
  }
}


