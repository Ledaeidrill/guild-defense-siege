// === CONFIG ===
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxw6GzkHTKd4LPxTednMz2cPGTU301GKYHUmen7jCIecV3VPFghjJB1ERMLUZ_8dV0mmQ/exec';
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
function renderGrid() {
  const q = (search.value||'').trim().toLowerCase();
  grid.innerHTML = '';
  window.MONSTERS
    .filter(m => !q || m.name.toLowerCase().includes(q))
    .forEach(m => {
      const card = document.createElement('div');
      card.className = 'card';
      card.onclick = () => addPick(m);
      const img = document.createElement('img');
      img.src = m.icon;
      img.alt = m.name;
      img.onerror = () => { img.remove(); };
      const span = document.createElement('span');
      span.className = 'name';
      span.textContent = m.name;
      card.appendChild(img);
      card.appendChild(span);
      grid.appendChild(card);
    });
}
search.addEventListener('input', renderGrid);
renderGrid();

function addPick(m) {
  if (picks.find(p => p.id === m.id)) return;
  if (picks.length >= 3) { toast('Tu as déjà 3 monstres. Retire-en un.'); return; }
  picks.push(m);
  renderPicks();
}
function removePick(id) {
  picks = picks.filter(p => p.id !== id);
  renderPicks();
}
function renderPicks() {
  const zone = document.getElementById('picks');
  zone.innerHTML = '';
  picks.forEach(p => {
    const div = document.createElement('div');
    div.className = 'pick';
    const img = document.createElement('img'); img.src = p.icon; img.alt = p.name;
    const name = document.createElement('span'); name.textContent = p.name;
    const x = document.createElement('button'); x.textContent = '✕'; x.onclick = ()=>removePick(p.id);
    div.append(img,name,x);
    zone.appendChild(div);
  });
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  setTimeout(()=> t.textContent = '', 4000);
}

// Envoi
document.getElementById('send').onclick = async () => {
  if (picks.length !== 3) return toast('Sélectionne exactement 3 monstres.');
  const player = document.getElementById('player').value;
  const notes  = document.getElementById('notes').value;
  const monsters = picks.map(p => p.name);
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: TOKEN, player, monsters, notes })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Erreur');
    toast('Merci ! Défense enregistrée ✅');
    picks = []; renderPicks(); document.getElementById('notes').value='';
  } catch (e) {
    console.error(e);
    toast('Échec de l’envoi. Vérifie l’URL/token.');
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
