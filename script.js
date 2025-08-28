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
tabReport.onclick = () => { tabReport.classList.add('active'); tabStats.classList.remove('active'); pageReport.classList.remove('hidden'); pageStats.classList.add('hidden'); };
tabStats.onclick  = () => { tabStats.classList.add('active'); tabReport.classList.remove('active'); pageStats.classList.remove('hidden'); pageReport.classList.add('hidden'); loadStats(); };

// Build grid
const grid = document.getElementById('monster-grid');
const search = document.getElementById('search');

function normalize(s){ return (s||'').toString().trim().toLowerCase(); }

function matchesQuery(m, qRaw){
  const q = normalize(qRaw);
  if (!q) return true;
  const tokens = q.split(/\s+/);

  // On cherche dans : nom éveillé, nom non éveillé, élément, aliases
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

const ELEMENT_ORDER = ['Fire','Water','Wind','Light','Dark'];
const elemRank = el => {
  const i = ELEMENT_ORDER.indexOf(el);
  return i === -1 ? 999 : i;
};

function makeCard(m){
  const card = document.createElement('div');
  card.className = 'card';
  card.title = `${m.name}${m.unawakened_name ? ` • ${m.unawakened_name}`:''}`;
  card.onclick = () => addPick(m);

  const img = document.createElement('img');

  // URL initiale
  let src = m.icon || '';

  // Si c’est un chemin “raccourci”, on reconstruit l’URL swarfarm complète
  // Cas 1: https://swarfarm.com/unit_icon_XXXX.png
  if (src.startsWith('https://swarfarm.com/unit_icon_')) {
    src = src.replace('https://swarfarm.com/', 'https://swarfarm.com/static/herders/images/monsters/');
  }
  // Cas 2: chemin relatif /unit_icon_XXXX.png
  if (src.startsWith('/unit_icon_')) {
    src = 'https://swarfarm.com/static/herders/images/monsters' + src;
  }
  // Cas 3: déjà le bon chemin: /static/herders/images/monsters/...
  if (src.startsWith('/static/herders/images/monsters/')) {
    src = 'https://swarfarm.com' + src;
  }

  img.src = src;
  img.alt = m.name;

  img.onerror = () => {
    // dernier filet de sécurité: réessayer avec le chemin “monsters/”
    if (!img.dataset.tried && img.src.includes('swarfarm.com/')) {
      img.dataset.tried = '1';
      img.src = img.src.replace('swarfarm.com/', 'swarfarm.com/static/herders/images/monsters/');
    } else {
      img.remove(); // si ça échoue encore, on masque l’image
    }
  };

  card.appendChild(img);

  // (On enlève le badge élément pour alléger visuellement)

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

search.removeEventListener?.('input', renderGrid);
search.addEventListener('input', renderGrid);
renderGrid();

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
    div.dataset.id = p.id; // utile au besoin

    const btn = document.createElement('button');
    btn.className = 'close';
    btn.type = 'button';
    btn.title = 'Retirer';
    btn.textContent = '✕';
    btn.setAttribute('data-id', p.id); // <= pour la délégation

    const img = document.createElement('img');
    img.src = p.icon; img.alt = p.name;

    const label = document.createElement('div');
    label.className = 'pname';
    label.textContent = p.name;

    div.append(btn, img, label);
    zone.appendChild(div);
  });
}

// 1) Délégation: capte les clics sur les boutons .close dans #picks
document.getElementById('picks').addEventListener('click', (e) => {
  const btn = e.target.closest('.close');
  if (!btn) return;                 // clic ailleurs => on ignore
  e.preventDefault();
  e.stopPropagation();
  const id = btn.getAttribute('data-id');
  removePick(Number(id));
});

// 2) Retirer un pick puis re-render
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

    // Réponse JSON
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Erreur');

    toast('Merci ! Défense enregistrée ✅');
    picks = []; renderPicks(); document.getElementById('notes').value='';
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
    const rows = json.stats;
    if (!rows.length) { box.innerHTML = 'Aucune donnée pour l’instant.'; return; }
    const tbl = document.createElement('table');
    tbl.className = 'table';
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr><th>Défense (ordre normalisé)</th><th>Count</th><th>Exemple</th></tr>`;
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach(r => {
      const tr = document.createElement('tr');
      const key = document.createElement('td'); key.className='key'; key.textContent = r.key;
      const cnt = document.createElement('td'); cnt.textContent = r.count;
      const ex  = document.createElement('td'); ex.textContent = (r.example||[]).join(' / ');
      tr.append(key,cnt,ex); tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    box.innerHTML = '';
    box.appendChild(tbl);
  } catch (e) {
    console.error(e);
    box.innerHTML = 'Impossible de charger les stats.';
  }
}
