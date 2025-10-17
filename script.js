// =====================
// CONFIG
// =====================
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwSwLs7MdkDR_PgubrCEL7GQvpCL8D0gGYlQ2JSCMHYY4xQ1YKvpTSMN6aDsmCt6xXCvA/exec';
const TOKEN = 'Chaos_Destiny';
const ADMIN_TOKEN_PARAM = new URL(location.href).searchParams.get('admin');
const isAdmin = () => !!ADMIN_TOKEN_PARAM;

// Cache mémoire (masque la latence du réseau)
const CACHE_TTL_MS = 60_000; // 60 s, cohérent avec le cache Apps Script si tu le mets côté serveur
const cache = {
  stats:   { data: null, ts: 0, inflight: null },
  handled: { data: null, ts: 0, inflight: null },
};

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

function ensureTrioArray(trio, key){
  if (Array.isArray(trio)) return trio;
  if (trio && typeof trio === 'object') return Object.values(trio);
  return String(key || '').split(' / ');
}

function esc(s){
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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
      // Backoff minimal
      await new Promise(r => setTimeout(r, 250));
      return apiPost(payloadObj, { timeoutMs, retries: retries - 1 });
    }
    return { ok:false, error: e?.name === 'AbortError' ? 'Timeout' : String(e) };
  } finally {
    clearTimeout(id);
  }
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

function cardHtmlByName(name){
  const d = findMonsterByName(name) || { name, icon:'' };
  const src = fixIconUrl(d.icon||'');
  return `
    <div class="pick def-pick" title="${esc(d.name)}">
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
  img.loading = 'lazy';
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
  if (!grid) return;
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
  requestIdleCallback?.(renderGrid, { timeout: 200 }) || renderGrid();
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

    const btn = document.createElement('button');
    btn.className = 'close';
    btn.type = 'button';
    btn.title = 'Retirer';
    btn.textContent = '✕';
    btn.setAttribute('data-id', p.id);

    const img = document.createElement('img');
    img.src = fixIconUrl(p.icon); img.alt = p.name; img.loading = 'lazy';

    const label = document.createElement('div');
    label.className = 'pname';
    label.textContent = p.name;

    div.append(btn, img, label);
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

    // On invalide le cache côté front pour forcer un refresh silencieux des stats
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

  rows.forEach(r => {
    const trio = ensureTrioArray(r.trio, r.key);
    const row = document.createElement('div'); row.className = 'def-row';

    const item = document.createElement('div'); item.className = 'def-item';

    const trioDiv = document.createElement('div'); trioDiv.className = 'def-trio';
    trio.forEach(name => {
      const m = findMonsterByName(name) || { name, icon: '' };
      const card = document.createElement('div'); card.className = 'pick def-pick';
      const img = document.createElement('img'); img.src = fixIconUrl(m.icon || ''); img.alt = m.name; img.loading='lazy';
      img.onerror = () => img.remove();
      const label = document.createElement('div'); label.className = 'pname'; label.textContent = m.name;
      card.append(img, label); trioDiv.append(card);
    });

    const right = document.createElement('div'); right.style.display='flex'; right.style.gap='10px'; right.style.alignItems='center';
    const count = document.createElement('div'); count.className = 'def-count'; count.textContent = r.count ?? 0;
    right.appendChild(count);

    item.append(trioDiv, right);
    row.appendChild(item);

    if (isAdmin()) {
      const btn = document.createElement('button'); btn.className = 'btn-ghost act-handle'; btn.textContent = 'Traiter';
      btn.setAttribute('data-key', r.key.replace(/"/g,'&quot;'));
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
      const key = btn.getAttribute('data-key');

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

  if (!rows.length) { box.innerHTML = 'Aucune défense traitée pour le moment.'; return; }

  const list = document.createElement('div');
  list.className = 'def-list';

  rows.filter(r => !recentlyHandled.has(r.key)).forEach(r => {
    const item = document.createElement('div'); item.className = 'def-item';
    const trio = document.createElement('div'); trio.className = 'def-trio';

    ensureTrioArray(r.trio, r.key).forEach(name => {
      const m = findMonsterByName(name) || { name, icon: '' };
      const card = document.createElement('div'); card.className = 'pick def-pick';
      const img = document.createElement('img'); img.src = fixIconUrl(m.icon || ''); img.alt = m.name; img.loading='lazy';
      img.onerror = () => { img.remove(); };
      const label = document.createElement('div'); label.className = 'pname'; label.textContent = m.name;
      card.append(img, label);
      trio.appendChild(card);
    });

    // (Optionnel) r.count / r.note pas fournis par la route actuelle : laissé vide
    item.append(trio);
    list.appendChild(item);
  });

  box.innerHTML = '';
  box.appendChild(list);
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
  // Rendu instantané depuis cache si présent
  if (cache.stats.data) renderStats(cache.stats.data);
  // Refresh silencieux
  const fresh = await fetchStats();
  renderStats(fresh);
});

tabDone?.addEventListener('click', async () => {
  activateTab(tabDone, pageDone);
  if (cache.handled.data) renderHandled(cache.handled.data);
  const fresh = await fetchHandled();
  renderHandled(fresh);
});

// Préfetch à l’ouverture de la page pour masquer la latence au premier clic
document.addEventListener('DOMContentLoaded', () => {
  // Préfetch silencieux
  fetchStats().then(d => { if (!pageStats.classList.contains('hidden')) renderStats(d); });
  fetchHandled().then(d => { if (!pageDone.classList.contains('hidden')) renderHandled(d); });
});
