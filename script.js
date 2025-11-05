// =====================
// CONFIG
// =====================
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwSwLs7MdkDR_PgubrCEL7GQvpCL8D0gGYlQ2JSCMHYY4xQ1YKvpTSMN6aDsmCt6xXCvA/exec';
const TOKEN = 'Chaos_Destiny';
const ADMIN_TOKEN_PARAM = new URL(location.href).searchParams.get('admin') || '';
let IS_ADMIN = false;                        // état unique d’admin pour TOUTE l’app
const isAdmin = () => IS_ADMIN;              // on ne lit plus l’URL directement
let _firstGrid = true;
const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

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

// ===== JSONP (contourne CORS) =====
function fetchJSONP(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cb = 'jsonp_cb_' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP timeout'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try { delete window[cb]; } catch {}
      if (script && script.parentNode) script.parentNode.removeChild(script);
    }

    window[cb] = (data) => { cleanup(); resolve(data); };

    const script = document.createElement('script');
    script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    script.onerror = () => { cleanup(); reject(new Error('JSONP error')); };
    document.head.appendChild(script);
  });
}

// ===== JSONP GET helpers (build query + de-dup) =====
function buildQuery(obj){
  const out = [];
  for (const [k,v] of Object.entries(obj || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const x of v) out.push(encodeURIComponent(k) + '=' + encodeURIComponent(x));
    } else {
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
  }
  return out.join('&');
}

function apiGet(params, timeoutMs = 20000){
  const qs = buildQuery(params);
  const url = APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes('?') ? '&' : '?') + qs;
  return fetchJSONP(url, timeoutMs);
}

function apiGetDedup(params, opts){
  const k = JSON.stringify(params);
  if (inflightMap.has(k)) return inflightMap.get(k);
  const p = apiGet(params, (opts && opts.timeoutMs) || 20000).finally(()=> inflightMap.delete(k));
  inflightMap.set(k, p);
  return p;
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
    const res = await apiGet({ mode: 'whoami', admin_token: ADMIN_TOKEN_PARAM });
    IS_ADMIN = !!res?.is_admin;
  } catch {
    IS_ADMIN = false;
  }
}

// clé famille + élément
const famKey = (m) => `${m.family_id}::${m.element}`;

// choisir le représentant : 2A > éveillé > base (tie-break id)
const pickPreferred = (bucket) => {
  return bucket.slice().sort((a, b) => {
    const p2 = (b.second_awaken === true) - (a.second_awaken === true);
    if (p2) return p2;
    const p1 = (b.awaken_level || 0) - (a.awaken_level || 0);
    if (p1) return p1;
    return (b.com2us_id || 0) - (a.com2us_id || 0);
  })[0];
};

// =====================
// Offs Modal (version finale unique)
// =====================
async function openOffsModal(defKey){
  if (offsTitle) offsTitle.textContent = 'Offenses — ' + (defKey || '');
  showOffsModal();

  // 1) Loader animé + key
  const loader = makeDotsLoader('Chargement');
  offsListEl.replaceChildren(loader.el);
  loader.show(120);
  offsListEl.dataset.defKey = defKey || '';

  // 2) Bouton “+ Ajouter” (inchangé)
  qsa('#offsAddWrap, [data-role="offs-add"]').forEach(el => el.remove());
  const addWrap = document.createElement('div');
  addWrap.id = 'offsAddWrap';
  addWrap.setAttribute('data-role', 'offs-add');
  addWrap.style.display = 'flex';
  addWrap.style.justifyContent = 'center';
  addWrap.style.marginTop = '10px';
  addWrap.style.minHeight = '48px';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn--primary';
  addBtn.type = 'button';
  addBtn.textContent = '+ Ajouter une offense';
  addBtn.hidden = !(ADMIN_TOKEN_PARAM && ADMIN_TOKEN_PARAM.trim());
  addBtn.onclick = () => openOffPicker(defKey, offsListEl, () => {});
  addWrap.appendChild(addBtn);
  offsListEl.parentElement.appendChild(addWrap);

  // 3) admin + offs en parallèle
  const pAdmin = detectAdmin().catch(() => false);
  const pOffs  = apiGetOffs(defKey);

  // 4) Afficher la liste quand prête
  try{
    const res = await pOffs;
    if (!res?.ok) throw new Error(res?.error || 'Erreur');
    loader.hide();
    renderOffsList(offsListEl, res.offs || []);
  }catch(e){
    loader.hide();
    offsListEl.innerHTML = '<div class="offsItem"><div class="meta">Impossible de charger les offenses.</div></div>';
  }

  // 5) Afficher / cacher le bouton selon admin
  try{
    await pAdmin;
    addBtn.hidden = !IS_ADMIN;
  }catch{
    addBtn.hidden = true;
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

// === Strict collab merge (basé SEULEMENT sur COLLAB_MAP) ===

const _pairById = new Map();

async function buildStrictCollabPairs(){
  _pairById.clear();
  await new Promise(r => setTimeout(r, 0));

  const list = window.MONSTERS || [];
  const toKey = (s) => (s ?? '')
    .toString()
    .normalize('NFKD')               // sépare diacritiques
    .replace(/\p{Diacritic}/gu,'')   // retire diacritiques
    .replace(/\s+/g,' ')             // espace unique
    .trim()
    .toLowerCase();

  // === 1) Index stricts "nom ➜ family_id" et "unawakened_name ➜ family_id"
  // (on n’utilise PAS aliases ici, pour éviter les collisions "Dragon", "Guardian", etc.)
  const name2fid = new Map();
  const unaw2fid = new Map();
  const push1 = (map, k, fid) => { const s = map.get(k); if (s) s.add(fid); else map.set(k, new Set([fid])); };

  for (const m of list){
    const kn = toKey(m.name);
    if (kn) push1(name2fid, kn, m.family_id);
    const ku = toKey(m.unawakened_name);
    if (ku) push1(unaw2fid, ku, m.family_id);
  }

  const resolveFamilyId = (label) => {
    const k = toKey(label);
    const a = name2fid.get(k) || new Set();
    const b = unaw2fid.get(k) || new Set();
    const union = new Set([...a, ...b]);
    if (union.size === 1) return [...union][0];
    console.warn('[COLLAB MAP] Ambiguous / missing label:', label, '→ fids:', [...union]);
    return null;
  };

  // === 2) Construit les paires "famille collab ↔ famille SW" par élément
  const cmap = (typeof MAP_SW_TO_COLLAB !== 'undefined' ? MAP_SW_TO_COLLAB : {});
  for (const [swName, collabName] of Object.entries(cmap)) {
    const swFid  = resolveFamilyId(swName);
    const coFid  = resolveFamilyId(collabName);
    if (!swFid || !coFid) continue;

    // buckets par (famille, élément)
    const swByEl = new Map();
    const coByEl = new Map();
    for (const m of list) {
      if (m.family_id === swFid) {
        const el = (m.element||'').toLowerCase();
        const arr = swByEl.get(el); if (arr) arr.push(m); else swByEl.set(el,[m]);
      }
      if (m.family_id === coFid) {
        const el = (m.element||'').toLowerCase();
        const arr = coByEl.get(el); if (arr) arr.push(m); else coByEl.set(el,[m]);
      }
    }

    // associer TOUTES les variantes par élément commun
    for (const [el, swArr] of swByEl.entries()){
      const coArr = coByEl.get(el);
      if (!coArr || !coArr.length) continue;
      for (const sw of swArr){
        for (const co of coArr){
          const pair = { sw, collab: co };
          _pairById.set(sw.id, pair);
          _pairById.set(co.id, pair);
        }
      }
    }
  }

  console.debug('[collab] pairs built (by family_id):', _pairById.size);
}

// Helpers de normalisation (accents/ponctuation/casse)
function _nrm(s){
  try{
    if (typeof window.nrm === 'function') return window.nrm(s);
  }catch{}
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // sans accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')                     // espaces propres
    .trim();
}

// Concatène les champs utiles d'un monstre pour la recherche
function _haystack(m){
  const parts = [
    m?.name, m?.unawakened_name, m?.element,
    ...(Array.isArray(m?.aliases) ? m.aliases : [])
  ];
  return _nrm(parts.filter(Boolean).join(' '));
}

function findByMapName(name){
  const k = _nrm(name);
  if (!k) return null;
  const list = window.MONSTERS || [];

  // 1) nom affiché exact (normalisé)
  let hit = list.find(x =>_nrm(x.name) === k);
  if (hit) return hit;

  // 2) certains noms de MAP peuvent être des non-éveillés
  hit = list.find(x =>_nrm(x.unawakened_name) === k);
  if (hit) return hit;

  // 3) filet: un alias EXACT (normalisé)
  return list.find(x => (x.aliases || []).some(a =>_nrm(a) === k)) || null;
}

// SW (famille) -> collab (inverse)
const MAP_SW_TO_COLLAB = (() => {
  const m = {};
  for (const [collab, sw] of Object.entries(MAP_COLLAB_TO_SW)) {
    if (!sw) continue;
    if (!m[sw]) m[sw] = collab; // si doublon, garde le premier
  }
  return m;
})();

// Remplace TOUT le contenu précédent de findMappedPair par :
function findMappedPair(mon){
  return _pairById.get(mon.id) || null; // ✅ seulement si la paire vient de COLLAB_MAP
}

function shouldHideInGrid(mon){
  const duo = findMappedPair(mon);
  if (!duo) return false;            // pas de pair → on affiche
  return mon.id === duo.collab.id;       // si c’est la version collab → on cache
}

// Rend l’icône + libellé fusionnés
function renderMergedVisual(m, opts){
  const mergeCollab = !(opts && opts.mergeCollab === false);
  const duo = mergeCollab ? findMappedPair(m) : null;

  // Unified text used for title/aria
  const unifiedTitle = duo ? `${duo.sw.name} / ${duo.collab.name}` : m.name;

  if (duo){
    const htmlIcon = `
      <div class="duo-hsplit" title="${esc(unifiedTitle)}" aria-label="${esc(unifiedTitle)}">
        <img loading="lazy" decoding="async" fetchpriority="low"
             class="left"
             src="${fixIconUrl(duo.sw.icon)}"
             alt="${esc(duo.sw.name)}">
        <img loading="lazy" decoding="async" fetchpriority="low"
             class="right"
             src="${fixIconUrl(duo.collab.icon)}"
             alt="${esc(duo.collab.name)}">
      </div>`;
    const label = unifiedTitle;
    const title = unifiedTitle;
    return { htmlIcon, label, title };
  }
  
  // Cas non-duo
  const htmlIcon = `
    <img loading="lazy" decoding="async" fetchpriority="low"
         src="${fixIconUrl(m.icon)}"
         alt="${esc(m.name)}"
         title="${esc(m.name)}">`;

  const label = m.name;
  const title = m.name;
  return { htmlIcon, label, title };
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

// ===== Client-side request de-dup + SWR (localStorage) =====
const inflightMap = new Map(); // key (payload string) -> Promise

function swrGetLS(key, maxAgeMs){
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if ((Date.now() - ts) > maxAgeMs) return null;
    return data;
  }catch{ return null; }
}
function swrSetLS(key, data){
  try{ localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); }catch{}
}

// Wrap pour dédupliquer des POST identiques (même payload)
async function apiPostDedup(payloadObj, opts){
  const payload = JSON.stringify(payloadObj);
  const k = payload; // stable key
  if (inflightMap.has(k)) return inflightMap.get(k);
  const p = apiPost(payloadObj, opts).finally(()=> inflightMap.delete(k));
  inflightMap.set(k, p);
  return p;
}

// Helpers Offs API (SWR + de-dup)
async function apiGetOffs(key, { force = false } = {}){
  // 0) LS instant
  if (!force && !offsCache.has(key)){
    const ls = swrGetLS('offs:'+key, 5*60*1000);
    if (ls?.ok) offsCache.set(key, { ts: Date.now(), data: ls });
  }
  const ent = offsCache.get(key);
  if (!force && ent && (Date.now() - ent.ts) < OFFS_CACHE_TTL) return ent.data;

  const res = await apiGetDedup({ mode:'get_offs', token: TOKEN, key });
  if (res?.ok){
    offsCache.set(key, { ts: Date.now(), data: res });
    swrSetLS('offs:'+key, res);
  }
  return res;
}

async function apiAddOff({ key, o1, o1el, o2, o2el, o3, o3el, note = '', by = '' }){
  const res = await apiGetDedup({
    mode: 'add_off',
    admin_token: ADMIN_TOKEN_PARAM,
    key, o1, o1el, o2, o2el, o3, o3el, note, by
  }, { timeoutMs: 8000 });

  if (res?.ok) {
    offsCache.delete(key);
    try { localStorage.removeItem('offs:'+key); } catch {}
  }
  return res;
}

async function apiDelOff({ key, o1, o1el, o2, o2el, o3, o3el }){
  const res = await apiGetDedup({
    mode:'del_off', admin_token: ADMIN_TOKEN_PARAM,
    key, o1, o1el, o2, o2el, o3, o3el
  }, { timeoutMs: 8000 });

  if (res?.ok) {
    offsCache.delete(key);
    try { localStorage.removeItem('offs:'+key); } catch {}
  }
  return res;
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
    <div class="monster-card" title="${esc(v.title)}" aria-label="${esc(v.title)}">
      ${v.htmlIcon}
      <div class="name" title="${esc(v.title)}">${esc(v.label)}</div>
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

// === Loader "Chargement." → ".." → "..." (points animés) ===
function makeDotsLoader(label = 'Chargement', className = 'grid-loading') {
  const el = document.createElement('div');
  el.className = className;
  const spanText  = document.createElement('span');
  const spanDots  = document.createElement('span');
  spanDots.className = 'dots';         // ← important pour ton CSS
  spanText.textContent = label;
  el.append(spanText, spanDots);

  let t = 0, timer = null;
  function tick(){ t = (t + 1) % 4; spanDots.textContent = '.'.repeat(Math.min(t, 3)); }

  let showTimer = null;
  function show(delayMs = 180) {
    hide();
    showTimer = setTimeout(() => {
      t = 0; spanDots.textContent = '';
      timer = setInterval(tick, 320);
      el.style.display = 'flex';
    }, Math.max(0, delayMs));
  }
  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (timer)     { clearInterval(timer);   timer = null; }
    el.style.display = 'none';
  }
  hide();
  return { el, show, hide };
}

// Build fast haystack once for all monsters
(function buildHay() {
  const list = window.MONSTERS || [];
  for (const m of list) {
    const parts = [m?.name, m?.unawakened_name, m?.element, ...(Array.isArray(m?.aliases) ? m.aliases : [])]
      .filter(Boolean).join(' ');
    m._hay = _nrm(parts);   // already strips accents + lowercases
  }
})();


// =====================
// GRILLE
// =====================
const grid   = qs('#monster-grid');
const search = qs('#search');

// Make decode wait "free" on fast paths
async function waitForImages(root, { maxWait = 900, minWait = 180, sample = 36 } = {}) {
  const imgs = [...root.querySelectorAll('img')].slice(0, sample);
  const decodeOne = (img) => {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    if (typeof img.decode === 'function') return img.decode().catch(() => {});
    return new Promise((res) => {
      img.addEventListener('load', res,  { once: true });
      img.addEventListener('error', res, { once: true });
    });
  };
  const allDecoded = Promise.allSettled(imgs.map(decodeOne));
  const capMax = new Promise((res) => setTimeout(res, maxWait));
  const capMin = new Promise((res) => setTimeout(res, minWait));
  await Promise.race([allDecoded, capMax]);
  await capMin;
}

async function renderGrid() {
  const box = document.querySelector('.grid-scroll');

  const loader = makeDotsLoader('Chargement');
  box.replaceChildren(loader.el);
  loader.show(320);

  const q = (search?.value || '').trim();
  const frag = document.createDocumentFragment();
  const seenPairs = new Set();

  (window.MONSTERS || [])
    .filter(m => matchesQuery(m, q))
    .filter(m => !shouldHideInGrid(m))
    .sort(monsterComparator)
    .forEach(m => {
      const duo = findMappedPair(m);
      if (duo) {
        const key = `${duo.sw.family_id || _nrm(duo.sw.name)}|${_nrm(duo.sw.element)}`;
        if (seenPairs.has(key)) return;
        seenPairs.add(key);
      }
      frag.appendChild(makeCard(m));
    });

  const gridEl = document.createElement('div');
  gridEl.className = 'monster-grid';
  gridEl.appendChild(frag);

  await waitForImages(gridEl, { maxWait: 450, minWait: 0, sample: 8 });

  loader.hide();
  box.replaceChildren(gridEl);
  _firstGrid = false;
}

function matchesQuery(m, q){
  const query = _nrm(q || '');
  if (!query) return true;
  const hay = m._hay || _haystack(m);
  const tokens = query.split(/\s+/).filter(Boolean);
  for (const tok of tokens){ if (!hay.includes(tok)) return false; }
  return true;
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

// Débounce recherche (léger)
let _searchTimer;
search?.addEventListener('input', () => { clearTimeout(_searchTimer); _searchTimer = setTimeout(renderGrid, 150); });

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

  const monsters    = picks.map(p => p.name);
  const monsters_el = picks.map(p => p.element || '');

  try {
    inFlight = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('sending');

    const json = await apiGet({
      mode: 'submit',
      token: TOKEN,
      player,
      notes,
      monsters,        // sent as ?monsters=a&monsters=b&monsters=c
      monsters_el
    });

    if (json.already_handled) {
      toast(json.message || 'Défense déjà traitée — va voir les offenses');
      picks = []; renderPicks(); if (qs('#notes')) qs('#notes').value='';
      return;
    }
    if (!json.ok) { toast(json.error || 'Erreur'); return; }

    toast('Défense enregistrée ✅');
    picks = []; renderPicks(); if (qs('#notes')) qs('#notes').value='';

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

async function fetchStats(){
  const url = APPS_SCRIPT_URL + '?fn=stats&token=' + encodeURIComponent(TOKEN);
  const data = await fetchJSONP(url, 20000);   // JSONP → plus de CORS
  try { (cache.stats ||= {}).data = data; } catch {}
  return data;
}

async function fetchHandled(){
  const url = APPS_SCRIPT_URL + '?fn=handled&token=' + encodeURIComponent(TOKEN);
  const data = await fetchJSONP(url, 20000);
  try { (cache.handled ||= {}).data = data; } catch {}
  return data;
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

      const resp = await apiGet({ mode:'handle', admin_token: ADMIN_TOKEN_PARAM, key });
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
  // Prefetch Offs au survol d'une ligne (une seule liaison)
  if (!box.__prefetchBound) {
    box.__prefetchBound = true;
    box.addEventListener('pointerenter', (e) => {
      const row = e.target.closest('.def-row');
      if (!row) return;
      const btn = row.querySelector('.act-handle'); // le bouton contient la clé
      const key = btn?.dataset?.key;
      if (key) { apiGetOffs(key).catch(()=>{}); }   // réchauffe offsCache (TTL 60s)
    }, { passive:true });
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
  const box = document.getElementById('stats');
  if (!box) return;
  const loader = makeDotsLoader('Chargement');
  box.replaceChildren(loader.el);
  loader.show(120);
  const fresh = await fetchStats();  // réseau + SWR
  loader.hide();
  renderStats(fresh);
});

tabDone?.addEventListener('click', async () => {
  activateTab(tabDone, pageDone);
  const box = document.getElementById('done');
  if (!box) return;
  const loader = makeDotsLoader('Chargement');
  box.replaceChildren(loader.el);
  loader.show(120);
  const fresh = await fetchHandled();
  loader.hide();
  renderHandled(fresh);
});

// Préfetch à l’ouverture de la page pour masquer la latence au premier clic
document.addEventListener('DOMContentLoaded', async () => {
  await detectAdmin();
  // --- NEW: loader tout de suite dans la fenêtre de grille
  const box = document.querySelector('.grid-scroll');
  if (box) {
    const boot = makeDotsLoader('Chargement');
    box.replaceChildren(boot.el);
    boot.show(300);
  }
  await buildStrictCollabPairs();          // construit _pairById (SW ↔ collab)
  await renderGrid();                      // ← RENDRE LA GRILLE APRÈS la construction
  
  // Si l’onglet est affiché, on montre le loader le temps du fetch
  if (!pageStats.classList.contains('hidden')) {
    const box = document.getElementById('stats');
    const loader = makeDotsLoader('Chargement');
    box.replaceChildren(loader.el);
    loader.show(120);
    const d = await fetchStats();
    loader.hide();
    renderStats(d);
  } else {
    fetchStats().catch(()=>{});
  }
  
  if (!pageDone.classList.contains('hidden')) {
    const box = document.getElementById('done');
    const loader = makeDotsLoader('Chargement');
    box.replaceChildren(loader.el);
    loader.show(120);
    const d = await fetchHandled();
    loader.hide();
    renderHandled(d);
  } else {
    fetchHandled().catch(()=>{});
  }
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
  body.style.overflow = 'hidden';   // on laisse la grille gérer son scroll
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
  wrap.style.flex = '1';
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.maxHeight = '70vh'; // évite que la modale déborde trop

  const pickTitle = document.createElement('div'); pickTitle.className = 'picker-title';
  pickTitle.textContent = 'Sélectionne 3 monstres';
  wrap.appendChild(pickTitle);

  const picksBox = document.createElement('div');
  // on garde "picks" ET on ajoute "off-picks" pour réutiliser tes styles
  picksBox.className = 'picks off-picks';
  wrap.appendChild(picksBox);
  let offPicks = [];

  // Recherche
  const row = document.createElement('div'); row.className='row field';
  const lab = document.createElement('label'); lab.textContent='Recherche';
  const inp = document.createElement('input'); inp.placeholder='Rechercher un monstre'; inp.autocomplete='off';
  row.append(lab, inp); wrap.appendChild(row);

  // Grille
  const gwrap = document.createElement('div'); 
  gwrap.className='picker-grid';
  const grid = document.createElement('div'); 
  grid.className='monster-grid';
  
  gwrap.style.flex = '1 1 auto';
  gwrap.style.minHeight = '80px';
  gwrap.style.removeProperty('height');
  gwrap.style.overflow = 'auto';
  gwrap.style.scrollbarGutter = 'stable both-edges'; // ← évite le petit “coup” quand la barre apparaît/disparaît
  gwrap.style.border = '1px solid rgba(255,255,255,0.07)';
  gwrap.style.borderRadius = '8px';
  gwrap.style.padding = '6px';

  gwrap.appendChild(grid);   // ← insère la grille dans le conteneur
  wrap.appendChild(gwrap);   // ← insère le conteneur dans la modale (avant la barre d’actions)

// ====== RENDER GRID (Offense picker)
function renderPickerGrid(){
  const loader = makeDotsLoader('Chargement');
  gwrap.replaceChildren(loader.el);
  loader.show(280);
  
  const q = (inp.value || '').trim();
  grid.innerHTML = '';

  const frag = document.createDocumentFragment();
  const seenPairs = new Set();

  const list = (window.MONSTERS || [])
    .filter(m => matchesQuery(m, q))
    .filter(m => !shouldHideInGrid(m))
    .sort(monsterComparator);

  for (const d of list) {
    const duo = findMappedPair(d);
    if (duo) {
      const key = `${duo.sw.family_id ||_nrm(duo.sw.name)}|${_nrm(duo.sw.element)}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
    }
    const card = document.createElement('div');
    card.className = 'card'; card.__data = d;
    const v = renderMergedVisual(d);
    card.title = v.title;
    card.innerHTML = `${v.htmlIcon}<span class="name" title="${esc(v.title)}">${esc(v.label)}</span>`;
    card.addEventListener('click', () => {
      if (offPicks.some(p => p.id === d.id)) return;
      if (offPicks.length >= 3) { toast('Tu as déjà 3 monstres.'); return; }
      offPicks.push(d);
      renderOffPicks();
      if ((inp.value||'').trim() !== '') { inp.value=''; renderPickerGrid(); }
    });
    frag.appendChild(card);
  }

  const gridEl = document.createElement('div');
  gridEl.className = 'monster-grid';
  gridEl.appendChild(frag);

  loader.hide();
  gwrap.replaceChildren(gridEl);
}

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

// Debounced search for the picker
let _pickerTimer = null, _pickerGen = 0;
inp.addEventListener('input', () => {
  clearTimeout(_pickerTimer);
  const gen = ++_pickerGen;
  _pickerTimer = setTimeout(() => {
    if (gen === _pickerGen) renderPickerGrid();
  }, 120); // adjust delay if you want
});
  
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
