// =====================
// CONFIG
// =====================
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwSwLs7MdkDR_PgubrCEL7GQvpCL8D0gGYlQ2JSCMHYY4xQ1YKvpTSMN6aDsmCt6xXCvA/exec';
const TOKEN = 'Chaos_Destiny';
const ADMIN_TOKEN_PARAM = new URL(location.href).searchParams.get('admin') || '';
let IS_ADMIN = false;                        // état unique d’admin pour TOUTE l’app
const isAdmin = () => IS_ADMIN;              // on ne lit plus l’URL directement

// Cache mémoire (masque la latence du réseau)
const CACHE_TTL_MS = 60000; // 60 s
const cache = {
  stats:   { data: null, ts: 0, inflight: null },
  handled: { data: null, ts: 0, inflight: null },
};
// Cache Offs (60 s)
const OFFS_CACHE_TTL = 60000;
const offsCache = new Map(); // key -> { ts, data: {ok:true, offs:[...] } }

// Clés tout juste traitées, on les masque 5 s pour éviter un flash si un fetch arrive avant l’invalidation serveur
const recentlyHandled = new Set();

// =====================
// HELPERS DOM & STRINGS
// =====================
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
const normalize = s => (s||'').toString().trim().toLowerCase();

function toast(msg) {
  const t = qs('#toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => { t.textContent = ''; t.classList.remove('show'); }, 2200);
}

function fixIconUrl(src){
  if (!src) return src;
  // 1) Chemin absolu swarfarm ancien
  if (src.startsWith('https://swarfarm.com/unit_icon_')) {
    return src.replace('https://swarfarm.com/', 'https://swarfarm.com/static/herders/images/monsters/');
  }
  // 2) Chemin absolu déjà bon
  if (src.startsWith('https://')) return src;
  // 3) Chemin relatif "/unit_icon_XXXX.png"
  if (src.startsWith('/unit_icon_')) {
    return 'https://swarfarm.com/static/herders/images/monsters' + src;
  }
  // 4) Chemin relatif "/static/herders/images/monsters/..."
  if (src.startsWith('/static/herders/images/monsters/')) {
    return 'https://swarfarm.com' + src;
  }
  // 5) Nom de fichier nu "unit_icon_XXXX.png"
  if (/^unit_icon_\d+_/.test(src)) {
    return 'https://swarfarm.com/static/herders/images/monsters/' + src;
  }
  return src;
}

function ensureTrioArray(trio, key){
  if (Array.isArray(trio)) return trio;
  if (trio && typeof trio === 'object') return Object.values(trio);
  return String(key || '').split(' / ');
}

function esc(s){
  s = (s || '').normalize('NFC');           // affichage propre (compose les diacritiques)
  return s.replace(/[&<>"'’]/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;',
    "'":'&#39;', '’':'&#39;'               // ← apostrophe droite ET typographique
  }[c]));
}

// ===== Modal Offs (markup existant dans index.html) =====
const offsModal   = qs('#offsModal');
const closeOffsBtn= qs('#closeOffs');
const offsTitle   = qs('#offsTitle');
const offsListEl  = qs('#offsList');

function showOffsModal(){ offsModal?.setAttribute('aria-hidden','false'); }
function hideOffsModal(){
  offsModal?.setAttribute('aria-hidden','true');
  if (offsListEl) offsListEl.innerHTML = '';                // reset list
  qsa('#offsAddWrap, [data-role="offs-add"]').forEach(el => el.remove());  // remove add bar
}
closeOffsBtn?.addEventListener('click', hideOffsModal);
offsModal?.addEventListener('click', (e) => {
  if (e.target === offsModal) hideOffsModal(); // clic sur le backdrop
});

// Vérifie côté serveur si le token admin est valide (recommandé)
async function detectAdmin(){
  try {
    const res = await apiPost({ mode: 'whoami', admin_token: ADMIN_TOKEN_PARAM });
    IS_ADMIN = !!res?.is_admin;
  } catch {
    IS_ADMIN = false;
  }
}

// =====================
// Offs Modal (version finale unique)
// =====================
async function openOffsModal(defKey){
  if (offsTitle) offsTitle.textContent = 'Offenses — ' + (defKey || '');
  showOffsModal();

  // 1) Détection admin côté serveur (via ?admin=...)
  await detectAdmin();

  // 2) Nettoie TOUS les anciens boutons "+ Ajouter"
  qsa('#offsAddWrap, [data-role="offs-add"]').forEach(el => el.remove());
  
  // 3) Placeholder + clé portée par le DOM
  offsListEl.innerHTML = '<div class="offsItem"><div class="meta">Chargement…</div></div>';
  offsListEl.dataset.defKey = defKey || '';

  // 4) Charge les offs puis rend la liste
  try{
    const res = await apiGetOffs(defKey);
    if (!res?.ok) throw new Error(res?.error || 'Erreur');
    renderOffsList(offsListEl, res.offs || []);
  }catch(e){
    offsListEl.innerHTML = '<div class="offsItem"><div class="meta">Impossible de charger les offenses.</div></div>';
  }

  // 5) Si admin → affiche le bouton "+ Ajouter une offense"
  if (IS_ADMIN){
    const addWrap = document.createElement('div');
    addWrap.id = 'offsAddWrap';
    addWrap.setAttribute('data-role', 'offs-add');
    addWrap.style.display = 'flex';
    addWrap.style.justifyContent = 'center';
    addWrap.style.marginTop = '10px';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn--primary';
    addBtn.type = 'button';
    addBtn.textContent = '+ Ajouter une offense';
    addBtn.onclick = () => openOffPicker(defKey, offsListEl, () => { /* optionnel */ });

    addWrap.appendChild(addBtn);
    offsListEl.parentElement.appendChild(addWrap);
  }
}

// =====================
// COLLABS — mapping explicite + résolution par élément/alias
// =====================

// collab -> famille SW (nom "générique" côté SW, pas le nom éveillé par élément)
const MAP_COLLAB_TO_SW = {
  // Street Fighter V
  'Ryu': 'Striker',
  'Ken': 'Shadow Claw',
  'M. Bison': 'Slayer',
  'Dhalsim': 'Poison Master',
  'Chun-Li': 'Blade Dancer',

  // Cookie Run
  'GingerBrave': 'Lollipop Warrior',
  'Pure Vanilla Cookie': 'Pudding Princess',
  'Hollyberry Cookie': 'Macaron Guard',
  'Espresso Cookie': 'Black Tea Bunny',
  'Madeleine Cookie': 'Choco Knight',

  // Assassin's Creed
  'Altaïr': 'Dual Blade',
  'Ezio': 'Steel Commander',
  'Bayek': 'Desert Warrior',
  'Kassandra': 'Gladiatrix',
  'Eivor': 'Mercenary Queen',

  // The Witcher
  'Geralt': 'Magic Order Guardian',
  'Ciri': 'Magic Order Swordsinger',
  'Yennefer': 'Magic Order Enchantress',
  'Triss': 'Magic Order Elementalist',

  // Jujutsu Kaisen
  'Yuji Itadori': 'Exorcist Association Fighter',
  'Satoru Gojo': 'Exorcist Association Resolver',
  'Nobara Kugisaki': 'Exorcist Association Hunter',
  'Megumi Fushiguro': 'Exorcist Association Conjurer',
  'Ryomen Sukuna': 'Exorcist Association Arbiter',
  'Ryōmen Sukuna': 'Exorcist Association Arbiter',

  // Demon Slayer
  'Tanjiro Kamado': 'Azure Dragon Swordsman',
  'Gyomei Himejima': 'Black Tortoise Champion',
  'Nezuko Kamado': 'Vermilion Bird Dancer',
  'Zenitsu Agatsuma': 'Qilin Slasher',
  'Inosuke Hashibira': 'White Tiger Blade Master',

  // TEKKEN 8 → pas d’équivalent SW (DON’T MERGE)
  // 'Jin': null, etc.
};

function resolveSwFamilyForCollab(mon) {
  const a = nrm(mon.name);
  const u = nrm(mon.unawakened_name || '');
  for (const [collabName, sw] of Object.entries(MAP_COLLAB_TO_SW)) {
    const key = nrm(collabName);
    if (a === key || u === key) return sw;   // strict equality only
  }
  return null;
}

// Déduire le nom collab à partir d’un monstre SW (par son nom/aliases)
function resolveCollabForSw(mon) {
  const fields = [
    nrm(mon.name),
    nrm(mon.unawakened_name || ''),
    ...(mon.aliases || []).map(nrm),
  ].filter(Boolean);

  for (const [swFamily, collabName] of Object.entries(MAP_SW_TO_COLLAB)) {
    const key = nrm(swFamily);
    // match strict OU sous-chaîne dans les deux sens
    const hit = fields.some(a => a === key || a.includes(key) || key.includes(a));
    if (hit) return { swFamily, collabName };
  }
  return null;
}

// Helpers de normalisation (accents/ponctuation/casse)
const nrm = (s) =>
  (s ?? '')
    .toString()
    .normalize('NFD')                    // sépare accents
    .replace(/\p{Diacritic}/gu, '')      // retire accents
    .replace(/[\s._-]+/g, ' ')           // homogénéise séparateurs
    .replace(/[’'"]/g, '')               // retire apostrophes/quotes/points
    .trim()
    .toLowerCase();

// mapping collab -> SW en lowercase/normalisé
const MAP_COLLAB_TO_SW_LC = Object.fromEntries(
  Object.entries(MAP_COLLAB_TO_SW).map(([k, v]) => [nrm(k), v])
);

// SW (famille) -> collab (inverse)
const MAP_SW_TO_COLLAB = (() => {
  const m = {};
  for (const [collab, sw] of Object.entries(MAP_COLLAB_TO_SW)) {
    if (!sw) continue;
    if (!m[sw]) m[sw] = collab; // si doublon, garde le premier
  }
  return m;
})();

// Résout *par élément* un monstre dont le (name | unawakened_name | aliases) matche une des clés
function findByElementAndAnyName(element, candidates, excludeId){
  const wants = new Set(candidates.map(nrm));
  const el = nrm(element);
  const matchAny = (val) => wants.has(nrm(val || ''));

  return (window.MONSTERS || []).find(x => {
    if (excludeId && x.id === excludeId) return false;
    if (nrm(x.element) !== el) return false;
    if (matchAny(x.name)) return true;
    if (matchAny(x.unawakened_name)) return true;
    const aliases = (x.aliases || []);
    return aliases.some(a => matchAny(a));
  }) || null;
}

// Renvoie le duo { sw, collab } pour le même élément, ou null si pas de pair
function findMappedPair(mon) {
  // Cas 1 : le monstre est un collab → retrouver la famille SW correspondante
  const swFamily = resolveSwFamilyForCollab(mon);
  if (swFamily) {
    const swMon = findByElementAndAnyName(mon.element, [swFamily], mon.id);
    if (swMon) return { sw: swMon, collab: mon };
  }

  // Cas 2 : le monstre est la version SW → retrouver le collab correspondant
  const hit = resolveCollabForSw(mon);
  if (hit) {
    const collabMon = findByElementAndAnyName(mon.element, [hit.collabName], mon.id);
    if (collabMon) return { sw: mon, collab: collabMon };
  }

  return null; // pas de pair (ex : TEKKEN)
}

function shouldHideInGrid(mon){
  const duo = findMappedPair(mon);
  if (!duo) return false;            // pas de pair → on affiche
  return mon.id === duo.sw.id;       // si c’est la version SW → on cache
}

// Rend l’icône + libellé fusionnés
function renderMergedVisual(mon){
  const duo = findMappedPair(mon);
  if (!duo) {
    return {
      label: mon.name,
      title: mon.name,
      htmlIcon: `<img src="${fixIconUrl(mon.icon||'')}" alt="${esc(mon.name)}" loading="lazy">`,
    };
  }
  const label = `${duo.sw.name} / ${duo.collab.name}`;
  return {
    label,
    title: label,
    htmlIcon: `
      <div class="duo-hsplit" aria-label="${esc(label)}" title="${esc(label)}">
        <img class="left"  src="${fixIconUrl(duo.sw.icon||'')}"     alt="${esc(duo.sw.name)}"     loading="lazy">
        <img class="right" src="${fixIconUrl(duo.collab.icon||'')}" alt="${esc(duo.collab.name)}" loading="lazy">
      </div>
    `,
  };
}

// =====================
// API helper (timeout + retry léger)
// =====================
async function apiPost(payloadObj, { timeoutMs = 7000, retries = 1 } = {}){
  const payload = JSON.stringify(payloadObj);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'payload=' + encodeURIComponent(payload),
      signal: controller.signal
    });

    const txt = await res.text();
    try { return JSON.parse(txt); }
    catch { return { ok:false, error:'Réponse invalide', raw: txt }; }
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 250));
      return apiPost(payloadObj, { timeoutMs, retries: retries - 1 });
    }
    return { ok:false, error: e?.name === 'AbortError' ? 'Timeout' : String(e) };
  } finally {
    clearTimeout(id);
  }
}

// Helpers Offs API
async function apiGetOffs(key, { force = false } = {}){
  const ent = offsCache.get(key);
  if (!force && ent && (Date.now() - ent.ts) < OFFS_CACHE_TTL) return ent.data;
  const res = await apiPost({ mode:'get_offs', token: TOKEN, key });
  if (res?.ok) offsCache.set(key, { ts: Date.now(), data: res });
  return res;
}
async function apiAddOff({ key, o1, o1el, o2, o2el, o3, o3el, note = '', by = '' }){
  return apiPost({
    mode: 'add_off',
    admin_token: ADMIN_TOKEN_PARAM,   // 
    key, o1, o1el, o2, o2el, o3, o3el, note, by
  });
}
async function apiDelOff({ key, o1, o1el, o2, o2el, o3, o3el }){
  return apiPost({
    mode:'del_off', admin_token: ADMIN_TOKEN_PARAM,
    key, o1, o1el, o2, o2el, o3, o3el
  });
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

// =====================
// INDEX MONSTRES
// =====================
const MONS_BY_NAME = (() => {
  const m = new Map();
  (window.MONSTERS || []).forEach(x => m.set((x.name||'').toLowerCase(), x));
  return m;
})();
const findMonsterByName = (n) => MONS_BY_NAME.get((n||'').toLowerCase()) || null;

// ==> Utiliser le rendu fusionné aussi pour les cartes "déf/offs"
function cardHtmlByName(name){
  const d = findMonsterByName(name) || { name, icon:'', element:'' };
  const v = renderMergedVisual(d);
  return `
    <div class="pick def-pick" title="${esc(v.title)}">
      ${v.htmlIcon}
      <div class="pname">${esc(v.label)}</div>
    </div>`;
}

// === Lookups rapides (nom+élément) ===
const MONS_BY_NAME_EL = new Map(
  (window.MONSTERS || []).map(x => [
    `${(x.name||'').toLowerCase()}|${(x.element||'').toLowerCase()}`, x
  ])
);
const findByNameEl = (n, el) =>
  MONS_BY_NAME_EL.get(`${(n||'').toLowerCase()}|${(el||'').toLowerCase()}`) || null;


// =====================
// GRILLE
// =====================
const grid   = qs('#monster-grid');
const search = qs('#search');

function matchesQuery(m, qRaw){
  const q = normalize(qRaw);
  if (!q) return true;
  const tokens = q.split(/\s+/);

  // Synonymes : autorise la recherche croisée SW<->COLLAB
  const extra = [];
  const duo = findMappedPair(m);
  if (duo) {
    if (m.id === duo.sw.id) extra.push(duo.collab.name); // taper "Ryu" trouve "Striker" caché
    else                    extra.push(duo.sw.name);     // taper "Striker" trouve "Ryu" affiché
  } else {
    const s1 = resolveSwFamilyForCollab(m); if (s1) extra.push(s1);
    const s2 = resolveCollabForSw(m);       if (s2) extra.push(s2.collabName);
  }

  const hay = new Set([
    normalize(m.name),
    normalize(m.unawakened_name),
    normalize(m.element),
    ...(m.aliases||[]).map(normalize),
    ...extra.map(normalize),
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

  // 👉 rendu fusionné SW|COLLAB si applicable
  const v = renderMergedVisual(m);
  card.innerHTML = `
    ${v.htmlIcon}
    <span class="name" title="${esc(v.title)}">${esc(v.label)}</span>
  `;
  return card;
}

// Renvoie un "score d'ordre de sortie" (plus petit = plus ancien)
function releaseKey(m){
  // Utilise release_ts si tu l’ajoutes côté Python, sinon com2us_id, sinon family_id, sinon id
  if (m.release_ts != null) return m.release_ts;        // nombre (timestamp)
  if (m.com2us_id != null)  return m.com2us_id;
  if (m.family_id != null)  return m.family_id;
  return m.id || 0;
}

function stars(m){
  return (m.natural_stars != null ? m.natural_stars
       : (m.base_stars     != null ? m.base_stars : 0));
}

// Comparateur global demandé
function monsterComparator(a, b){
  // 1) Élément
  const er = elemRank(a.element) - elemRank(b.element);
  if (er !== 0) return er;

  // 2) Niveau d'awake: 2e éveil d'abord
  const a2 = !!a.second_awaken, b2 = !!b.second_awaken;
  if (a2 !== b2) return a2 ? -1 : 1;

  // 3) ★ desc : 5★ -> 4★ -> 3★
  const sa = stars(a), sb = stars(b);
  if (sa !== sb) return sb - sa;

  // 4) plus récent -> plus ancien
  const ra = releaseKey(a), rb = releaseKey(b);
  if (ra !== rb) return rb - ra;

  // 5) nom
  return a.name.localeCompare(b.name,'en',{sensitivity:'base'});
}

function renderGrid() {
  const q = (search?.value||'').trim();
  if (!grid) return;
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  const seenPairs = new Set(); // SW-family + element

  (window.MONSTERS || [])
    .filter(m => matchesQuery(m, q))
    .filter(m => !shouldHideInGrid(m))
    .sort(monsterComparator)
    .forEach(m => {
      const duo = findMappedPair(m);
      if (duo) {
        const key = `${duo.sw.family_id || nrm(duo.sw.name)}|${nrm(duo.sw.element)}`;
        if (seenPairs.has(key)) return;      // already rendered this pair
        seenPairs.add(key);
      }
      frag.appendChild(makeCard(m));
    });

  grid.appendChild(frag);
}

// Débounce recherche (léger)
let _searchTimer;
search?.addEventListener('input', () => { clearTimeout(_searchTimer); _searchTimer = setTimeout(renderGrid, 100); });
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
  if (typeof requestIdleCallback === 'function') { requestIdleCallback(renderGrid, { timeout: 200 }); } else { renderGrid(); }
}

function removePick(id) {
  picks = picks.filter(p => p.id !== id);
  renderPicks();
}

function renderPicks() {
  const zone = qs('#picks');
  if (!zone) return;

  zone.innerHTML = '';
  const frag = document.createDocumentFragment();

  picks.forEach((p, index) => {
    const div = document.createElement('div');
    div.className = 'pick';
    div.dataset.id = p.id;
    div.dataset.index = index;
    div.draggable = true;

    // bouton retirer
    const btn = document.createElement('button');
    btn.className = 'close';
    btn.type = 'button';
    btn.title = 'Retirer';
    btn.textContent = '✕';
    btn.onclick = () => { picks.splice(index, 1); renderPicks(); };

    // ✅ visuel fusionné SW|Collab
    const v = renderMergedVisual(p);

    div.innerHTML = `
      <button class="close" type="button" title="Retirer">✕</button>
      ${v.htmlIcon}
      <div class="pname" title="${esc(v.title)}">${esc(v.label)}</div>
    `;
    // ré-associe le click du bouton close inséré via innerHTML
    div.querySelector('.close').onclick = btn.onclick;

    frag.appendChild(div);
  });

  zone.appendChild(frag);
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
// ENVOI (corrigé: mode:'submit')
// =====================
const sendBtn = qs('#send');
sendBtn?.addEventListener('click', async () => {
  if (inFlight) return;
  if (picks.length !== 3) return toast('Sélectionne exactement 3 monstres.');

  const player = qs('#player')?.value || '';
  const notes  = qs('#notes')?.value  || '';

  // ➜ construits ICI les deux tableaux
  const monsters    = picks.map(p => p.name);
  const monsters_el = picks.map(p => p.element || ''); // pour collabs

  try {
    inFlight = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');

    const json = await apiPost({
      mode: 'submit',
      token: TOKEN,
      player,
      monsters,
      monsters_el,
      notes
    });

    if (json.already_handled) {
      toast(json.message || 'Défense déjà traitée — va voir les offenses');
      picks = []; renderPicks(); if (qs('#notes')) qs('#notes').value='';
      return;
    }
    if (!json.ok) { toast(json.error || 'Erreur'); return; }

    toast('Défense enregistrée ✅');
    picks = []; renderPicks(); if (qs('#notes')) qs('#notes').value='';

    // Forcer un refresh silencieux des stats
    cache.stats.ts = 0;
    void fetchStats().then(updateStatsUIIfVisible);
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
// DATA LAYER (fetch + cache mémoire)
// =====================
function isFresh(ts){ return (Date.now() - ts) < CACHE_TTL_MS; }

async function fetchStats(force = false){
  if (!force && cache.stats.data && isFresh(cache.stats.ts)) return cache.stats.data;
  if (cache.stats.inflight) return cache.stats.inflight;

  const p = apiPost({ mode: 'stats', token: TOKEN }).then(res => {
    cache.stats.inflight = null;
    if (!res?.ok) throw new Error(res?.error || 'Erreur stats');
    cache.stats.data = res; cache.stats.ts = Date.now();
    return res;
  }).catch(err => {
    cache.stats.inflight = null;
    console.error('[fetchStats]', err);
    return cache.stats.data || { ok:true, stats: [] }; // fallback cache/empty
  });

  cache.stats.inflight = p;
  return p;
}

async function fetchHandled(force = false){
  if (!force && cache.handled.data && isFresh(cache.handled.ts)) return cache.handled.data;
  if (cache.handled.inflight) return cache.handled.inflight;

  const p = apiPost({ mode: 'handled', token: TOKEN }).then(res => {
    cache.handled.inflight = null;
    if (!res?.ok) throw new Error(res?.error || 'Erreur handled');
    cache.handled.data = res; cache.handled.ts = Date.now();
    return res;
  }).catch(err => {
    cache.handled.inflight = null;
    console.error('[fetchHandled]', err);
    return cache.handled.data || { ok:true, handled: [] };
  });

  cache.handled.inflight = p;
  return p;
}

// =====================
// RENDER LAYER (séparée)
// =====================
function renderStats(data){
  const box = document.getElementById('stats');
  if (!box) return;
  const rows = Array.isArray(data?.stats) ? data.stats : [];

  if (!rows.length) { box.innerHTML = 'Aucune donnée pour l’instant.'; return; }

  const frag = document.createDocumentFragment();
  const list = document.createElement('div');
  list.className = 'def-list';

  rows.filter(r => !recentlyHandled.has(r.key)).forEach(r => {
    const trio = ensureTrioArray(r.trio, r.key);
    const row = document.createElement('div'); row.className = 'def-row';

    const item = document.createElement('div'); item.className = 'def-item';

    const trioDiv = document.createElement('div'); trioDiv.className = 'def-trio';
    trio.forEach((name, i) => {
    const el = (r.els && r.els[i]) || '';
    const m  = (el ? findByNameEl(name, el) : findMonsterByName(name)) || { name, element: el, icon: '' };
    const card = document.createElement('div'); card.className = 'pick def-pick';
    const v = renderMergedVisual(m);
    card.innerHTML = `
      ${v.htmlIcon}
      <div class="pname">${esc(v.label)}</div>
    `;
    trioDiv.append(card);
  });

    const right = document.createElement('div'); right.style.display='flex'; right.style.gap='10px'; right.style.alignItems='center';
    const count = document.createElement('div'); count.className = 'def-count'; count.textContent = r.count ?? 0;
    right.appendChild(count);

    item.append(trioDiv, right);
    row.appendChild(item);

    if (isAdmin()) {
      const btn = document.createElement('button'); btn.className = 'btn-ghost act-handle'; btn.textContent = 'Traiter';
      btn.dataset.key = r.key;
      row.appendChild(btn);
    }
    list.appendChild(row);
  });

  box.innerHTML = '';
  frag.appendChild(list);
  box.appendChild(frag);

  if (isAdmin()) {
    box.onclick = async (e) => {
      const btn = e.target.closest('.act-handle');
      if (!btn) return;
      const key = btn.dataset.key;

      // Optimisme UI : déplacer localement la clé dans "traitées"
      moveKeyFromStatsToHandledOptimistic(key);
      // Masque anti-flash 5 s
      recentlyHandled.add(key);
      setTimeout(() => recentlyHandled.delete(key), 5000);

      const resp = await apiPost({ mode:'handle', admin_token: ADMIN_TOKEN_PARAM, key });
      if (!resp.ok) {
        toast(resp.error || 'Action admin impossible.');
        // rollback (rafraîchir depuis serveur)
        await Promise.all([fetchStats(true), fetchHandled(true)]);
        updateStatsUIIfVisible();
        updateHandledUIIfVisible();
        return;
      }
      toast('Défense déplacée dans "Défs traitées" ✅');

      cache.stats.ts = 0;       // invalide cache front
      cache.handled.ts = 0;

      // Refresh silencieux
      await Promise.all([fetchStats(true), fetchHandled(true)]);
      updateStatsUIIfVisible();
      updateHandledUIIfVisible();
    };
  }
}

function renderHandled(data){
  const box = document.getElementById('done');
  if (!box) return;
  const rows = Array.isArray(data?.handled) ? data.handled : [];

  if (!rows.length) { 
    box.innerHTML = 'Aucune défense traitée pour le moment.'; 
    return; 
  }

  const list = document.createElement('div');
  list.className = 'def-list';

  rows
    .filter(r => !recentlyHandled.has(r.key))
    .forEach(r => {
      const item = document.createElement('div'); 
      item.className = 'def-item';

      const trio = document.createElement('div'); 
      trio.className = 'def-trio';
      
      ensureTrioArray(r.trio, r.key).forEach((name, i) => {
      const el = (r.els && r.els[i]) || '';
      const m  = (el ? findByNameEl(name, el) : findMonsterByName(name)) || { name, element: el, icon: '' };
      const card = document.createElement('div'); 
      card.className = 'pick def-pick';
      const v = renderMergedVisual(m);
      card.innerHTML = `
        ${v.htmlIcon}
        <div class="pname">${esc(v.label)}</div>
      `;
      trio.appendChild(card);
    });

      // "Voir offs" pour tout le monde
      const right = document.createElement('div');
      right.style.display='flex'; 
      right.style.gap='10px'; 
      right.style.alignItems='center';

      const btn = document.createElement('button');
      btn.className = 'btn-ghost btn-offs';
      btn.type = 'button';
      btn.textContent = 'Voir offs';
      btn.dataset.key = r.key;
      btn.addEventListener('mouseenter', () => { apiGetOffs(r.key).catch(()=>{}); });

      right.appendChild(btn);
      item.append(trio, right);
      list.appendChild(item);
    });

  box.innerHTML = '';
  box.appendChild(list);

  // Handler de clic (pour tous)
  box.onclick = (e) => {
    const btn = e.target.closest('.btn-offs');
    if (!btn) return;
    const key = btn.dataset.key;
    openOffsModal(key);
  };
}

// Optimistic update (déplacement local d’une clé)
function moveKeyFromStatsToHandledOptimistic(key){
  const s = cache.stats.data;
  const h = cache.handled.data;
  if (!s?.stats) return;

  const idx = s.stats.findIndex(x => x.key === key);
  if (idx !== -1) {
    const row = s.stats.splice(idx, 1)[0]; // retire de stats
    if (h?.handled) {
      // évite doublons
      if (!h.handled.some(x => x.key === key)) {
        h.handled.unshift({ key: row.key, trio: ensureTrioArray(row.trio, row.key) });
        cache.handled.ts = Date.now(); // rafraîchi
      }
    } else {
      cache.handled.data = { ok:true, handled: [{ key: row.key, trio: ensureTrioArray(row.trio, row.key) }] };
    }
    cache.stats.ts = Date.now(); // rafraîchi
    updateStatsUIIfVisible();
    updateHandledUIIfVisible();
  }
}

// Helpers de mise à jour conditionnelle (pour rendu instantané)
function updateStatsUIIfVisible(){
  if (!pageStats?.classList.contains('hidden') && cache.stats.data) {
    renderStats(cache.stats.data);
  }
}
function updateHandledUIIfVisible(){
  if (!pageDone?.classList.contains('hidden') && cache.handled.data) {
    renderHandled(cache.handled.data);
  }
}

// =====================
// NAVIGATION + PREFETCH
// =====================
tabReport?.addEventListener('click', () => activateTab(tabReport, pageReport));

tabStats?.addEventListener('click', async () => {
  activateTab(tabStats, pageStats);
  if (cache.stats.data) renderStats(cache.stats.data); // Rendu instantané
  const fresh = await fetchStats(); // Refresh silencieux
  renderStats(fresh);
});

tabDone?.addEventListener('click', async () => {
  activateTab(tabDone, pageDone);
  if (cache.handled.data) renderHandled(cache.handled.data);
  const fresh = await fetchHandled();
  renderHandled(fresh);
});

// Préfetch à l’ouverture de la page pour masquer la latence au premier clic
document.addEventListener('DOMContentLoaded', async () => {
  await detectAdmin(); // ← on connaît le vrai statut admin ici
  fetchStats().then(d => { if (!pageStats.classList.contains('hidden')) renderStats(d); });
  fetchHandled().then(d => { if (!pageDone.classList.contains('hidden')) renderHandled(d); });
});

// =====================
// Offs Modal
// =====================

function renderOffsList(target, offs){
  target.innerHTML = '';
  if (!offs.length){
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Aucune offense enregistrée pour le moment.';
    target.appendChild(p);
    return;
  }

  offs.forEach(o => {
    const item = document.createElement('div');
    item.className = 'offsItem';

    // Trio rendu avec tes cartes .pick.def-pick + duo si merge
    const trioWrap = document.createElement('div');
    trioWrap.className = 'off-trio';
    const names = o.trio || [];
    const els   = [o.o1el || '', o.o2el || '', o.o3el || ''];
    names.forEach((name, i) => {
      const el = els[i];
      const m  = (el ? findByNameEl(name, el) : findMonsterByName(name)) || { name, element: el, icon: '' };
      const v  = renderMergedVisual(m);
      const card = document.createElement('div');
      card.className = 'pick def-pick';
      card.title = v.title;
      card.innerHTML = `
        ${v.htmlIcon}
        <div class="pname">${esc(v.label)}</div>
      `;
      trioWrap.appendChild(card);
    });

    // Bouton Supprimer (admin)
    if (IS_ADMIN) {
      const del = document.createElement('button');
      del.className = 'btn-ghost';
      del.type = 'button';
      del.textContent = 'Supprimer';
    
      del.onclick = async () => {
        const defKey = target.dataset.defKey || '';
        const trio = (o.trio || []).map(x => String(x||'').trim());
        if (trio.length !== 3) return;
        try {
          del.disabled = true; del.textContent = 'Suppression…';
          const resp = await apiDelOff({
            key: defKey, 
            o1: trio[0], o1el: o.o1el || '', 
            o2: trio[1], o2el: o.o2el || '', 
            o3: trio[2], o3el: o.o3el || '' 
          });
          if (!resp?.ok) { toast(resp?.error || 'Suppression impossible'); del.disabled=false; del.textContent='Supprimer'; return; }
          offsCache.delete(defKey);
          const res = await apiGetOffs(defKey, { force: true });
          if (res?.ok) renderOffsList(target, res.offs || []);
          toast('Offense supprimée ✅');
        } catch (e) {
          console.error(e);
          toast('Erreur pendant la suppression');
          del.disabled=false; del.textContent='Supprimer';
        }
      };

    // ligne + zone actions à droite
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '12px';
  
    const actions = document.createElement('div');
    actions.style.marginLeft = 'auto';   // ← pousse complètement à droite
    actions.appendChild(del);
  
    row.append(trioWrap, actions);
    item.appendChild(row);
  } else {
    item.appendChild(trioWrap);
  }
  target.appendChild(item);
  });
}

// Mini-picker Off (3 max)
function openOffPicker(defKey, offsListEl, onClose){
  // --- Modale au-dessus
  const modal = document.createElement('div');
  modal.className = 'modal modal--picker';
  modal.style.zIndex = '2000';
  modal.setAttribute('aria-hidden','false');

  const dialog = document.createElement('div');
  dialog.className = 'modal__dialog';
  dialog.setAttribute('role','dialog');
  dialog.setAttribute('aria-modal','true');
  dialog.setAttribute('aria-labelledby','pickerTitle');

  const header = document.createElement('div');
  header.className = 'modal__header';
  const h = document.createElement('div');
  h.className = 'modal__title'; h.id = 'pickerTitle';
  h.textContent = 'Ajouter une offense';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-ghost'; closeBtn.type = 'button'; closeBtn.textContent = 'Fermer';
  header.append(h, closeBtn);

  const body = document.createElement('div'); body.className = 'modal__body';
  dialog.append(header, body); modal.appendChild(dialog); document.body.appendChild(modal);

  function closePicker(){
    modal.setAttribute('aria-hidden','true');
    modal.remove();
    if (typeof onClose === 'function') onClose();
  }
  closeBtn.addEventListener('click', closePicker);
  modal.addEventListener('click', (e) => { if (e.target === modal) closePicker(); });
  document.addEventListener('keydown', function esc(e){ if(e.key==='Escape'){ closePicker(); document.removeEventListener('keydown', esc); } });

  // --- Contenu
  const wrap = document.createElement('div'); wrap.className = 'picker'; body.appendChild(wrap);

  const pickTitle = document.createElement('div'); pickTitle.className = 'picker-title';
  pickTitle.textContent = 'Sélectionne 3 monstres';
  wrap.appendChild(pickTitle);

  const picksBox = document.createElement('div'); picksBox.className = 'picks'; wrap.appendChild(picksBox);
  let offPicks = [];

  // Recherche
  const row = document.createElement('div'); row.className='row field';
  const lab = document.createElement('label'); lab.textContent='Recherche';
  const inp = document.createElement('input'); inp.placeholder='Rechercher un monstre'; inp.autocomplete='off';
  row.append(lab, inp); wrap.appendChild(row);

  // Grille
  const gwrap = document.createElement('div'); gwrap.className='picker-grid';
  const grid = document.createElement('div'); grid.className='monster-grid';
  gwrap.appendChild(grid); wrap.appendChild(gwrap);

  // Actions (Valider + spinner)
  const actions = document.createElement('div'); actions.className='picker-actions';
  const validate = document.createElement('button');
  validate.className = 'btn-primary'; validate.type='button';
  validate.innerHTML = 'Valider off <span class="btn-spinner"></span>';
  actions.appendChild(validate); wrap.appendChild(actions);

  // ====== RENDER PICKS ======
  function renderOffPicks(){
    picksBox.innerHTML='';
    offPicks.forEach((p, index) => {
      const div = document.createElement('div'); div.className='pick'; div.dataset.index = index; div.draggable = true;

      const close = document.createElement('button'); close.className = 'close'; close.type='button'; close.title='Retirer'; close.textContent='✕';
      close.onclick = () => { offPicks.splice(index,1); renderOffPicks(); };

      const v = renderMergedVisual(p);
      div.innerHTML = `
        <button class="close" type="button" title="Retirer">✕</button>
        ${v.htmlIcon}
        <div class="pname">${esc(v.label)}</div>
      `;
      div.querySelector('.close').onclick = close.onclick;

      // DnD
      div.addEventListener('dragstart', e => { e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', div.dataset.index); div.classList.add('dragging'); });
      div.addEventListener('dragend',   () => div.classList.remove('dragging'));
      div.addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect='move'; });
      div.addEventListener('drop', e => {
        e.preventDefault();
        const src = parseInt(e.dataTransfer.getData('text/plain'),10);
        const dst = parseInt(div.dataset.index,10);
        if (!Number.isNaN(src) && !Number.isNaN(dst) && src!==dst){
          const mv = offPicks.splice(src,1)[0];
          offPicks.splice(dst,0,mv);
          renderOffPicks();
        }
      });

      picksBox.appendChild(div);
    });
  }

  // ====== RENDER GRID ======
  function renderPickerGrid(){
    const q = (inp.value||'').trim().toLowerCase();
    grid.textContent = '';
    const frag = document.createDocumentFragment();

    const list = (window.MONSTERS||[])
      .filter(m => !q || [m.name, m.unawakened_name, m.element, ...(m.aliases||[])]
        .some(s => (s||'').toLowerCase().includes(q)))
      .sort(monsterComparator);

    for (const m of list) {
      const card = document.createElement('div');
      card.className = 'card';
      card.title = m.name;
      card.__data = m;

      const v = renderMergedVisual(m);
      card.innerHTML = `
        ${v.htmlIcon}
        <span class="name" title="${esc(v.title)}">${esc(v.label)}</span>
      `;

      card.addEventListener('click', () => {
      card.addEventListener('click', () => {
        if (offPicks.some(p => p.id === m.id)) return;
        if (offPicks.length >= 3) { toast('Tu as déjà 3 monstres.'); return; }
        offPicks.push(m);
        renderOffPicks();
      
        // → vider la recherche automatiquement
        inp.value = '';
        // re-render la grille complète
        renderPickerGrid();
        // (optionnel) remettre le focus sur la recherche
        inp.focus();
      });
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  inp.addEventListener('input', renderPickerGrid);
  renderPickerGrid(); renderOffPicks();

  // ====== Validation
  let _offSubmitting = false;
  validate.onclick = async () => {
    if (_offSubmitting) return;
    if (offPicks.length !== 3) { toast('Sélectionne exactement 3 monstres.'); return; }

    _offSubmitting = true;
    validate.disabled = true;
    validate.classList.add('sending');
    validate.textContent = 'Validation…';

    const [a,b,c]   = offPicks.map(x => x.name);
    const [e1,e2,e3]= offPicks.map(x => x.element || '');
    try {
      const resp = await apiAddOff({
        key: defKey,
        o1:a, o1el:e1,
        o2:b, o2el:e2,
        o3:c, o3el:e3,
      });
      if (!resp?.ok) { toast(resp?.error || 'Erreur ajout off'); return; }

      // mise à jour locale
      const ent = offsCache.get(defKey);
      if (ent?.data?.ok) {
        ent.data.offs = (ent.data.offs || []).concat([{
          trio: [a, b, c], o1el:e1, o2el:e2, o3el:e3
        }]);
        ent.ts = Date.now();
        renderOffsList(offsListEl, ent.data.offs);
      } else {
        const res = await apiGetOffs(defKey, { force: true });
        if (res?.ok) renderOffsList(offsListEl, res.offs || []);
      }

      toast('Offense ajoutée ✅'); closePicker();
    } catch (err) {
      console.error(err); toast('Erreur réseau');
    } finally {
      validate.classList.remove('sending');
      validate.disabled = false;
      validate.textContent = 'Valider off';
    }
  };
}

