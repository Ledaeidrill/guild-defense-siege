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
const qs = (sel, root = document) => root.querySelector(sel);
const normalize = s => (s||'').toString().trim().toLowerCase();

let CURRENT_DEF_KEY = null;
let OFFS_CHOICES = []; // sélection courante [name1,name2,name3]

function toast(msg) {
  const t = qs('#toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => { t.textContent = ''; t.classList.remove('show'); }, 2800);
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

async function apiPost(payloadObj){
  const payload = JSON.stringify(payloadObj);
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'payload=' + encodeURIComponent(payload)
  });
  const txt = await res.text();
  console.log('[apiPost]', res.status, txt);
  try { return JSON.parse(txt); }
  catch { return { ok:false, error:'Réponse invalide', raw: txt }; }
}

function ensureTrioArray(trio, key){
  if (Array.isArray(trio)) return trio;
  if (trio && typeof trio === 'object') return Object.values(trio);
  return String(key || '').split(' / ');
}

// =====================
// ONGLET / ÉTAT
// =====================
let picks = []; // [{id,name,icon}]
let inFlight = false;

const tabReport = qs('#tab-report');
const tabStats  = qs('#tab-stats');
const tabDone   = qs('#tab-done');
const pageReport= qs('#page-report');
const pageStats = qs('#page-stats');
const pageDone  = qs('#page-done');

function activateTab(tabBtn, pageEl){
  [tabReport,tabStats,tabDone].forEach(b=>b?.classList.remove('active'));
  tabBtn?.classList.add('active');
  [pageReport,pageStats,pageDone].forEach(p=>p?.classList.add('hidden'));
  pageEl?.classList.remove('hidden');
}
tabReport?.addEventListener('click', () => activateTab(tabReport, pageReport));
tabStats ?.addEventListener('click', () => { activateTab(tabStats, pageStats); loadStats(); });
tabDone  ?.addEventListener('click', () => { activateTab(tabDone, pageDone);  loadHandled(); });

// =====================
// INDEX MONSTRES
// =====================
const MONS_BY_NAME = (() => {
  const m = new Map();
  (window.MONSTERS || []).forEach(x => m.set((x.name||'').toLowerCase(), x));
  return m;
})();
const findMonsterByName = (n) => MONS_BY_NAME.get((n||'').toLowerCase()) || null;

function cardHtmlByName(name){
  const d = findMonsterByName(name) || { name, icon:'' };
  const src = fixIconUrl(d.icon||'');
  const esc = (s)=> (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `
    <div class="pick def-pick">
      <img src="${src}" alt="${esc(d.name)}" loading="lazy">
      <div class="pname">${esc(d.name)}</div>
    </div>`;
}

// =====================
// GRILLE
// =====================
const grid   = qs('#monster-grid');
const search = qs('#search');

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

function makeCard(m){
  const card = document.createElement('div');
  card.className = 'card';
  card.title = m.name;
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
  card.append(img);

  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = m.name;
  card.append(span);

  return card;
}

function renderGrid() {
  const q = (search?.value||'').trim();
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

// Débounce recherche
let _searchTimer;
search?.addEventListener('input', () => { clearTimeout(_searchTimer); _searchTimer = setTimeout(renderGrid, 120); });
renderGrid();

// =====================
// SÉLECTION (drag & drop)
// =====================
function addPick(m) {
  if (picks.find(p => p.id === m.id)) return;
  if (picks.length >= 3) { toast('Tu as déjà 3 monstres. Retire-en un.'); return; }
  picks.push(m);
  renderPicks();
  if (search) search.value = '';
  renderGrid();
}
function removePick(id) {
  picks = picks.filter(p => p.id !== id);
  renderPicks();
}
function renderPicks() {
  const zone = qs('#picks');
  zone.innerHTML = '';
  picks.forEach((p, index) => {
    const div = document.createElement('div');
    div.className = 'pick';
    div.dataset.id = p.id;
    div.dataset.index = index;
    div.draggable = true; // drag natif

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
qs('#picks')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.close');
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  const id = Number(btn.getAttribute('data-id'));
  removePick(id);
});
function enableDragAndDrop(container) {
  container.querySelectorAll('.pick').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.index);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    el.addEventListener('drop', (e) => {
      e.stopPropagation();
      const srcIndex  = parseInt(e.dataTransfer.getData('text/plain'));
      const destIndex = parseInt(el.dataset.index);
      if (!Number.isNaN(srcIndex) && !Number.isNaN(destIndex) && srcIndex !== destIndex) {
        const moved = picks.splice(srcIndex, 1)[0];
        picks.splice(destIndex, 0, moved);
        renderPicks();
      }
      return false;
    });
  });
}

// =====================
// ENVOI
// =====================
const sendBtn = qs('#send');
sendBtn?.addEventListener('click', async () => {
  if (inFlight) return;
  if (picks.length !== 3) return toast('Sélectionne exactement 3 monstres.');

  const player   = qs('#player')?.value || '';
  const notes    = qs('#notes') ?.value || '';
  const monsters = picks.map(p => p.name);

  try {
    inFlight = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');

    const json = await apiPost({ mode:'submit', token: TOKEN, player, monsters, notes });

    if (json.already_handled) {
      toast(json.message || 'Défense déjà traitée — va voir ingame les counters.');
      picks = []; renderPicks(); if (qs('#notes')) qs('#notes').value='';
      return;
    }
    if (!json.ok) { toast(json.error || 'Erreur'); return; }

    toast('Défense enregistrée ✅');
    picks = []; renderPicks(); if (qs('#notes')) qs('#notes').value='';
  } catch (e) {
    console.error(e);
    toast('Échec de l’envoi. Vérifie l’URL/token ou le déploiement.');
  } finally {
    inFlight = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove('sending');
  }
});

// =====================
// TOP DÉFENSES
// =====================
async function loadStats() {
  const box = document.getElementById('stats');
  box.innerHTML = 'Chargement…';
  try {
    const data = await apiPost({ mode: 'stats', token: TOKEN });
    console.log('[loadStats]', data);

    if (!data || !data.ok) {
      box.innerHTML = 'Erreur chargement stats : ' + (data?.error || 'inconnue');
      return;
    }

    const rows = Array.isArray(data.stats) ? data.stats : [];
    if (!rows.length) { box.innerHTML = 'Aucune donnée pour l’instant.'; return; }

    let html = `<div class="def-list">`;
    for (const r of rows) {
      const trio = ensureTrioArray(r.trio, r.key);
      html += `
        <div class="def-row">
          <div class="def-item">
            <div class="def-trio">
              ${trio.map(cardHtmlByName).join('')}
            </div>
            <div class="def-count">${r.count ?? 0}</div>
          </div>
          ${isAdmin() ? `<button class="btn-ghost act-handle" data-key="${r.key.replace(/"/g,'&quot;')}">Traiter</button>` : ``}
        </div>`;
    }
    html += `</div>`;
    box.innerHTML = html;

    if (isAdmin()) {
      const list = box.querySelector('.def-list');
      list.addEventListener('click', async (e) => {
        const btn = e.target.closest('.act-handle');
        if (!btn) return;
        const key = btn.getAttribute('data-key');
        const resp = await apiPost({ action:'handle', admin_token: ADMIN_TOKEN_PARAM, key });
        console.log('[handle]', resp);
        if (!resp.ok) return toast(resp.error || 'Action admin impossible.');
        toast('Défense déplacée dans "Défs traitées" ✅');
        await Promise.all([loadStats(), loadHandled()]);
      });
    }
  } catch (e) {
    console.error(e);
    box.innerHTML = 'Impossible de charger les stats (voir console).';
  }
}

// =====================
// DÉFENSES TRAITÉES
// =====================
async function loadHandled() {
  const box = document.getElementById('done');
  box.innerHTML = 'Chargement…';
  try {
    const data = await apiPost({ mode: 'handled', token: TOKEN });
    console.log('[loadHandled]', data);

    if (!data || !data.ok) {
      box.innerHTML = 'Erreur chargement défenses traitées : ' + (data?.error || 'inconnue');
      return;
    }

    const rows = Array.isArray(data.handled) ? data.handled : [];
    if (!rows.length) { box.innerHTML = 'Aucune défense traitée pour le moment.'; return; }

    const list = document.createElement('div');
    list.className = 'def-list';

    rows.forEach(r => {
      const item = document.createElement('div');
      item.className = 'def-item';

      const trio = document.createElement('div');
      trio.className = 'def-trio';

      ensureTrioArray(r.trio, r.key).forEach(name => {
        const m = findMonsterByName(name) || { name, icon: '' };
        const card = document.createElement('div');
        card.className = 'pick def-pick';

        const img = document.createElement('img');
        img.src = fixIconUrl(m.icon || ''); img.alt = m.name;
        img.onerror = () => { img.remove(); };

        const label = document.createElement('div');
        label.className = 'pname';
        label.textContent = m.name;

        card.appendChild(img);
        card.appendChild(label);
        trio.appendChild(card);
      });

      // droite : bouton "voir les offs"
      const right = document.createElement('div');
      right.style.display='flex'; right.style.gap='10px'; right.style.alignItems='center';
      const btnOffs = document.createElement('button');
      btnOffs.className = 'btn-ghost';
      btnOffs.textContent = 'Voir les offs';
      btnOffs.addEventListener('click', () => openOffsModal(r.key));
      right.appendChild(btnOffs);

      item.append(trio, right);
      list.appendChild(item);
    });

    box.innerHTML = '';
    box.appendChild(list);
  } catch (e) {
    console.error(e);
    box.innerHTML = 'Impossible de charger les défenses traitées (voir console).';
  }
}

// =====================
// MODALE OFFENSES
// =====================
function openOffsModal(defKey){
  CURRENT_DEF_KEY = defKey;
  document.getElementById('offs-title').textContent = `Offenses pour : ${defKey}`;
  document.getElementById('offs-chooser').classList.add('hidden'); // vue liste par défaut
  document.getElementById('offs-modal').classList.remove('hidden');
  loadOffs(defKey);
}
function closeOffsModal(){
  CURRENT_DEF_KEY = null;
  document.getElementById('offs-modal').classList.add('hidden');
}
document.getElementById('offs-back').addEventListener('click', closeOffsModal);
document.querySelector('#offs-modal .modal-backdrop').addEventListener('click', closeOffsModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOffsModal(); });
// Ouvrir le chooser depuis le bouton bas
document.getElementById('offs-add-btn').addEventListener('click', () => {
  if (!isAdmin()) return toast('Réservé aux admins.');
  openOffsChooser();
});

async function loadOffs(defKey){
  const box = document.getElementById('offs-list');
  box.innerHTML = 'Chargement…';
  try {
    const data = await apiPost({ mode:'get_offs', token: TOKEN, key: defKey });
    if (!data || !data.ok) { box.innerHTML = 'Erreur de chargement.'; return; }

    const offs = data.offs || [];
    const frag = document.createDocumentFragment();

    // on mappe chaque offense -> carte
    offs.forEach(o => frag.appendChild(buildOffRow(o)));

    // carte + ajouter (seulement admin)
    if (isAdmin()) frag.appendChild(buildAddCard());

    box.innerHTML = '';
    box.appendChild(frag);
  } catch (e) {
    console.error(e);
    box.innerHTML = 'Erreur de chargement.';
  }
}

function buildOffRow(o){
  const row = document.createElement('div');
  row.className = 'off-row';

  const wrap = document.createElement('div');
  wrap.style.display='flex';
  wrap.style.flexDirection='column';
  wrap.style.alignItems='center';

  const trio = document.createElement('div');
  trio.className = 'off-trio';

  (o.trio||[]).forEach(name=>{
    const m = findMonsterByName(name) || { name, icon:'' };
    const card = document.createElement('div');
    card.className = 'off-pick';
    const img = document.createElement('img');
    img.src = fixIconUrl(m.icon||''); img.alt = m.name; img.onerror = () => img.remove();
    const label = document.createElement('div'); label.textContent = m.name;
    card.append(img,label);
    trio.appendChild(card);
  });

  wrap.appendChild(trio);

  // actions admin : retirer
  if (isAdmin() && o.row) {
    const actions = document.createElement('div');
    actions.className = 'off-actions';
    const del = document.createElement('button');
    del.className = 'btn-ghost';
    del.textContent = 'Retirer';
    del.addEventListener('click', async () => {
      const resp = await apiPost({ mode:'del_off', admin_token: ADMIN_TOKEN_PARAM, row: String(o.row) });
      if (!resp || !resp.ok) return toast(resp?.error || 'Échec suppression');
      toast('Offense retirée ✅');
      loadOffs(CURRENT_DEF_KEY);
    });
    actions.appendChild(del);
    wrap.appendChild(actions);
  }

  row.appendChild(wrap);
  return row;
}

function buildAddCard(){
  const wrap = document.createElement('div');
  wrap.className = 'add-card';
  wrap.innerHTML = `<div class="add-plus">+</div><div class="add-label">Ajouter une offense</div>`;
  wrap.addEventListener('click', openOffsChooser);
  return wrap;
}

function openOffsChooser(){
  OFFS_CHOICES = [];
  updateChosenChips();

  const chooser = document.getElementById('offs-chooser');
  chooser.classList.remove('hidden');

  // remplir la grille
  const grid = document.getElementById('offs-grid');
  grid.innerHTML = '';
  (window.MONSTERS || []).forEach(m => grid.appendChild(buildMonsterCard(m)));

  // recherche
  const input = document.getElementById('offs-search');
  input.value = '';
  input.oninput = () => filterMonsterGrid(input.value.trim().toLowerCase());

  // bouton valider
  const btn = document.getElementById('offs-validate');
  btn.disabled = true;
  btn.onclick = submitOffense;
}

function buildMonsterCard(m){
  const div = document.createElement('div');
  div.className = 'mon-card';
  div.dataset.name = m.name.toLowerCase();
  div.innerHTML = `
    <img src="${fixIconUrl(m.icon||'')}" alt="${m.name}" onerror="this.remove()">
    <div style="margin-top:6px;font-size:12px;">${m.name}</div>
  `;
  div.addEventListener('click', () => togglePick(m.name, div));
  return div;
}

function filterMonsterGrid(q){
  const cards = document.querySelectorAll('#offs-grid .mon-card');
  cards.forEach(c => {
    const ok = !q || c.dataset.name.includes(q);
    c.style.display = ok ? '' : 'none';
  });
}

function togglePick(name, cardEl){
  const i = OFFS_CHOICES.indexOf(name);
  if (i >= 0) {
    OFFS_CHOICES.splice(i,1);
    cardEl.classList.remove('selected');
  } else {
    if (OFFS_CHOICES.length >= 3) return; // max 3
    OFFS_CHOICES.push(name);
    cardEl.classList.add('selected');
  }
  updateChosenChips();
}

function updateChosenChips(){
  const ids = ['ch1','ch2','ch3'];
  ids.forEach((id, idx)=>{
    const chip = document.getElementById(id);
    const v = OFFS_CHOICES[idx];
    chip.textContent = v ? v : (idx+1);
    chip.classList.toggle('empty', !v);
  });
  document.getElementById('offs-validate').disabled = (OFFS_CHOICES.length !== 3);
}

async function submitOffense(){
  if (!isAdmin()) { toast('Réservé aux admins.'); return; }
  if (!CURRENT_DEF_KEY) return;

  const [o1,o2,o3] = OFFS_CHOICES;
  const note = document.getElementById('off-note').value.trim();

  const resp = await apiPost({
    mode: 'add_off',
    admin_token: ADMIN_TOKEN_PARAM,  // param admin depuis l’URL
    key: CURRENT_DEF_KEY,
    o1, o2, o3, note,
    by: 'admin'
  });

  if (!resp || !resp.ok) { toast(resp?.error || 'Échec de l’ajout.'); return; }

  toast('Offense ajoutée ✅');
  // Revenir à la liste et recharger
  document.getElementById('offs-chooser').classList.add('hidden');
  loadOffs(CURRENT_DEF_KEY);
}

function openOffsChooser(){
  OFFS_CHOICES = [];
  renderOffsPicks();

  const chooser = document.getElementById('offs-chooser');
  chooser.classList.remove('hidden');

  // remplir la grille
  const grid = document.getElementById('offs-grid');
  grid.innerHTML = '';
  (window.MONSTERS || []).forEach(m => grid.appendChild(buildMonsterCard(m)));

  // recherche
  const input = document.getElementById('offs-search');
  input.value = '';
  input.oninput = () => filterMonsterGrid(input.value.trim().toLowerCase());

  // bouton valider
  const btn = document.getElementById('offs-validate');
  btn.disabled = true;
  btn.onclick = submitOffense;
}

function buildMonsterCard(m){
  const div = document.createElement('div');
  div.className = 'mon-card';
  div.dataset.name = m.name.toLowerCase();
  div.innerHTML = `
    <img src="${fixIconUrl(m.icon||'')}" alt="${m.name}" onerror="this.remove()">
    <div style="margin-top:6px;font-size:12px;">${m.name}</div>
  `;
  div.addEventListener('click', () => toggleOffsPick(m));
  return div;
}

function toggleOffsPick(m){
  const i = OFFS_CHOICES.findIndex(x => x.name === m.name);
  if (i >= 0) OFFS_CHOICES.splice(i,1);
  else {
    if (OFFS_CHOICES.length >= 3) return;
    OFFS_CHOICES.push(m);
  }
  renderOffsPicks();
}

function renderOffsPicks(){
  const zone = document.getElementById('offs-picks');
  zone.innerHTML = '';
  OFFS_CHOICES.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'pick';
    const btn = document.createElement('button');
    btn.className = 'close';
    btn.type = 'button';
    btn.title = 'Retirer';
    btn.textContent = '✕';
    btn.onclick = () => { OFFS_CHOICES.splice(idx,1); renderOffsPicks(); };
    const img = document.createElement('img');
    img.src = fixIconUrl(p.icon||''); img.alt = p.name;
    const label = document.createElement('div');
    label.className = 'pname';
    label.textContent = p.name;
    div.append(btn, img, label);
    zone.appendChild(div);
  });
  document.getElementById('offs-validate').disabled = (OFFS_CHOICES.length !== 3);
}

function filterMonsterGrid(q){
  const cards = document.querySelectorAll('#offs-grid .mon-card');
  cards.forEach(c => c.style.display = (!q || c.dataset.name.includes(q)) ? '' : 'none');
}

async function submitOffense(){
  if (!isAdmin()) { toast('Réservé aux admins.'); return; }
  if (!CURRENT_DEF_KEY) return;
  if (OFFS_CHOICES.length !== 3) return;

  const [o1,o2,o3] = OFFS_CHOICES.map(x => x.name);
  const note = document.getElementById('off-note').value.trim();

  const resp = await apiPost({
    mode: 'add_off',
    admin_token: ADMIN_TOKEN_PARAM,
    key: CURRENT_DEF_KEY,
    o1, o2, o3, note,
    by: 'admin'
  });

  if (!resp || !resp.ok) { toast(resp?.error || 'Échec de l’ajout.'); return; }

  toast('Offense ajoutée ✅');
  document.getElementById('offs-chooser').classList.add('hidden');
  loadOffs(CURRENT_DEF_KEY);
}

