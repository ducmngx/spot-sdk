// Top-level controller: graph picker, fetch graph + annotations, save/export.
import { Map2D } from './map2d.js';

const state = {
  graphName: null,
  graph: null,
  annotations: { doors: [], waypoint_pois: {}, rooms: [], no_go_zones: [] },
  selectedWaypointId: null,
  view: '2d',
  map2d: null, map3d: null,
  scans: null,        // Float32Array (Nx3) in seed frame, lazy-loaded
  scansVisible: false,
};

function setStatus(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}
function api(path, opts) { return fetch(`/api/graphs/${encodeURIComponent(state.graphName)}${path}`, opts); }

async function init() {
  const graphs = await fetch('/api/graphs').then(r => r.json());
  const sel = document.getElementById('graph-select');
  graphs.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.name;
    opt.textContent = g.name;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => loadGraph(sel.value));
  await loadGraph(graphs[0].name);
}

async function loadGraph(name) {
  state.graphName = name;
  state.selectedWaypointId = null;
  state.map3d = null;     // force rebuild on next 3D toggle
  state.scans = null; state.scansVisible = false;
  document.getElementById('scans-toggle').textContent = 'Show scans';
  state.graph = await api('').then(r => r.json());
  state.annotations = await api('/annotations').then(r => r.json());
  document.getElementById('graph-info').textContent =
    `${state.graph.waypoints.length} waypoints · ${state.graph.fiducials.length} fiducials · anchored=${state.graph.anchored}`;

  // Reset 2D
  const c2 = document.getElementById('canvas2d');
  state.map2d = new Map2D(c2, state.graph, state, {
    onSelectWaypoint: wp => selectWaypoint(wp),
    onSelectFiducial: f => selectFiducial(f),
    onPolygonClosed: (type, vertices) => onPolygonClosed(type, vertices),
  });
  state.map2d.draw();

  // Reset 3D container
  const c3 = document.getElementById('canvas3d');
  c3.innerHTML = '';

  // If currently in 3D, rebuild it now
  if (state.view === '3d') await ensure3D();

  // Reset waypoint form
  document.getElementById('wp-empty').hidden = false;
  document.getElementById('wp-form').hidden = true;

  renderDoors();
  renderRooms();
  renderNoGo();
}

// --- Tabs ---
document.querySelectorAll('#tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Waypoint panel ---
function selectWaypoint(wp) {
  state.selectedWaypointId = wp.id;
  document.querySelector('[data-tab="waypoint"]').click();
  document.getElementById('wp-empty').hidden = true;
  document.getElementById('wp-form').hidden = false;
  document.getElementById('wp-id').value = wp.id;
  const poi = state.annotations.waypoint_pois[wp.id] || { name: wp.name, tags: [], notes: '' };
  document.getElementById('wp-name').value = poi.name || wp.name;
  document.getElementById('wp-tags').value = (poi.tags || []).join(', ');
  document.getElementById('wp-notes').value = poi.notes || '';
  state.map2d?.draw();
}
document.getElementById('wp-apply').addEventListener('click', () => {
  const id = document.getElementById('wp-id').value;
  state.annotations.waypoint_pois[id] = {
    name: document.getElementById('wp-name').value.trim(),
    tags: document.getElementById('wp-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    notes: document.getElementById('wp-notes').value,
  };
  setStatus('Updated (unsaved)');
  state.map2d?.draw();
});

// --- Doors panel ---
const CATEGORY_LABELS = {
  localization:      'Localization (1–299)',
  dock:              'Spot Dock (520–549)',
  dock_station:      'Spot Dock — Spot Station (580–584)',
  mission_interrupt: 'Mission interrupt (585–586)',
  unknown:           'Unknown / out-of-range',
};

function selectFiducial(f) {
  document.querySelector('[data-tab="doors"]').click();
  const el = document.getElementById(`fid-card-${f.tag_id}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.classList.add('focus');
  setTimeout(() => el?.classList.remove('focus'), 1500);
}

function renderDoors() {
  const list = document.getElementById('doors-list');
  list.innerHTML = '';
  if (!state.graph.fiducials.length) {
    list.innerHTML = '<div class="muted">No fiducials in this graph.</div>';
    return;
  }

  const byCategory = {};
  for (const f of state.graph.fiducials) {
    (byCategory[f.category] = byCategory[f.category] || []).push(f);
  }

  // Render localization first (the only category that can be a door),
  // then docks / mission interrupts / unknown as info-only.
  const order = ['localization', 'dock', 'dock_station', 'mission_interrupt', 'unknown'];
  for (const cat of order) {
    const fids = byCategory[cat];
    if (!fids?.length) continue;
    const header = document.createElement('h3');
    header.textContent = CATEGORY_LABELS[cat];
    header.style.cssText = 'font-size:12px; color:#a0aec0; text-transform:uppercase; letter-spacing:0.05em; margin:1rem 0 0.5rem;';
    list.appendChild(header);

    for (const f of fids) {
      list.appendChild(cat === 'localization' ? doorCard(f) : infoCard(f));
    }
  }
}

function infoCard(f) {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = `fid-card-${f.tag_id}`;
  card.innerHTML = `
    <h3>#${f.tag_id} <span class="muted">@ (${f.x.toFixed(2)}, ${f.y.toFixed(2)})</span></h3>
    <div class="muted">Reserved by Boston Dynamics — not a door.</div>
  `;
  return card;
}

function doorCard(f) {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = `fid-card-${f.tag_id}`;
  const existing = state.annotations.doors.find(d => d.tag_id === f.tag_id);

  if (!existing) {
    card.innerHTML = `
      <h3>#${f.tag_id} <span class="muted">@ (${f.x.toFixed(2)}, ${f.y.toFixed(2)})</span></h3>
      <div class="muted">Localization tag — not marked as a door.</div>
      <button>Mark as door</button>
    `;
    card.querySelector('button').addEventListener('click', () => {
      state.annotations.doors.push({
        tag_id: f.tag_id, name: `door_${f.tag_id}`,
        tag_to_handle: [0, 0, 0.12], handle_type: 'lever',
        swing: 'pull', hinge: 'right',
        nav_waypoint: nearestWaypointName(f), approach_standoff_m: 1.0,
      });
      renderDoors();
      state.map2d?.draw();
      setStatus(`#${f.tag_id} marked as door (unsaved)`);
    });
    return card;
  }

  card.innerHTML = `
    <h3>#${f.tag_id} <span class="muted">@ (${f.x.toFixed(2)}, ${f.y.toFixed(2)})</span> · door</h3>
    <label>Name <input data-k="name" value="${existing.name}"></label>
    <label>Tag→handle [x y z] (m) <input data-k="tag_to_handle" value="${existing.tag_to_handle.join(' ')}"></label>
    <div class="row">
      <label>Handle <select data-k="handle_type">
        <option ${existing.handle_type === 'lever' ? 'selected' : ''}>lever</option>
        <option ${existing.handle_type === 'push_bar' ? 'selected' : ''}>push_bar</option>
      </select></label>
      <label>Swing <select data-k="swing">
        <option ${existing.swing === 'pull' ? 'selected' : ''}>pull</option>
        <option ${existing.swing === 'push' ? 'selected' : ''}>push</option>
      </select></label>
      <label>Hinge <select data-k="hinge">
        <option ${existing.hinge === 'right' ? 'selected' : ''}>right</option>
        <option ${existing.hinge === 'left' ? 'selected' : ''}>left</option>
      </select></label>
    </div>
    <label>Nav waypoint <input data-k="nav_waypoint" value="${existing.nav_waypoint || ''}"></label>
    <label>Standoff (m) <input data-k="approach_standoff_m" type="number" step="0.1" value="${existing.approach_standoff_m}"></label>
    <div class="row">
      <button data-action="apply">Apply</button>
      <button data-action="remove" class="delete">Unmark as door</button>
    </div>
  `;
  card.querySelector('[data-action="apply"]').addEventListener('click', () => {
    const get = k => card.querySelector(`[data-k="${k}"]`).value;
    const door = {
      tag_id: f.tag_id,
      name: get('name').trim(),
      tag_to_handle: get('tag_to_handle').split(/\s+/).map(Number),
      handle_type: get('handle_type'),
      swing: get('swing'),
      hinge: get('hinge'),
      nav_waypoint: get('nav_waypoint').trim() || null,
      approach_standoff_m: parseFloat(get('approach_standoff_m')),
    };
    state.annotations.doors = state.annotations.doors.filter(d => d.tag_id !== f.tag_id);
    state.annotations.doors.push(door);
    setStatus(`Updated door #${f.tag_id} (unsaved)`);
  });
  card.querySelector('[data-action="remove"]').addEventListener('click', () => {
    state.annotations.doors = state.annotations.doors.filter(d => d.tag_id !== f.tag_id);
    renderDoors();
    state.map2d?.draw();
    setStatus(`Removed door annotation for #${f.tag_id} (unsaved)`);
  });
  return card;
}
function nearestWaypointName(f) {
  let best = null, bestD = Infinity;
  for (const wp of state.graph.waypoints) {
    const d = Math.hypot(wp.x - f.x, wp.y - f.y);
    if (d < bestD) { bestD = d; best = wp; }
  }
  if (!best) return '';
  const poi = state.annotations.waypoint_pois[best.id];
  return (poi?.name) || best.name || '';
}

// --- Rooms / no-go ---
function renderRooms() { renderPolygonList('rooms-list', state.annotations.rooms, 'rooms'); }
function renderNoGo() { renderPolygonList('nogo-list', state.annotations.no_go_zones, 'no_go_zones'); }
function renderPolygonList(elId, list, key) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  list.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3>${p.name}</h3>
      <label>Name <input value="${p.name}"></label>
      <div class="muted">${p.polygon_seed.length} vertices${p.waypoints ? ` · ${p.waypoints.length} waypoints` : ''}</div>
      <button class="delete">Delete</button>
    `;
    card.querySelector('input').addEventListener('change', e => {
      list[idx].name = e.target.value;
      state.map2d?.draw();
    });
    card.querySelector('.delete').addEventListener('click', () => {
      state.annotations[key].splice(idx, 1);
      renderPolygonList(elId, state.annotations[key], key);
      state.map2d?.draw();
    });
    el.appendChild(card);
  });
}
document.getElementById('room-new').addEventListener('click', () => {
  state.map2d.startPolygon('room');
  setStatus('Click on map to add vertices, double-click to finish.');
});
document.getElementById('nogo-new').addEventListener('click', () => {
  state.map2d.startPolygon('nogo');
  setStatus('Click on map to add vertices, double-click to finish.');
});
function onPolygonClosed(type, vertices) {
  const name = prompt(`Name for this ${type}:`) || `${type}-${Date.now()}`;
  if (type === 'room') {
    const inside = state.graph.waypoints
      .filter(wp => pointInPoly(wp.x, wp.y, vertices))
      .map(wp => wp.id);
    state.annotations.rooms.push({ name, polygon_seed: vertices, waypoints: inside });
    renderRooms();
  } else {
    state.annotations.no_go_zones.push({ name, polygon_seed: vertices });
    renderNoGo();
  }
  state.map2d?.draw();
  setStatus(`Added ${type} (unsaved)`);
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

// --- Top bar ---
document.getElementById('save-btn').addEventListener('click', async () => {
  const r = await api('/annotations', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state.annotations),
  });
  setStatus(r.ok ? 'Saved annotations.json' : 'Save failed');
});
document.getElementById('export-doors-btn').addEventListener('click', async () => {
  // Save first so the server has up-to-date annotations to export.
  await api('/annotations', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state.annotations),
  });
  const r = await api('/export/doors', { method: 'POST' });
  if (!r.ok) { setStatus('Export failed'); return; }
  const j = await r.json();
  setStatus(`Wrote ${j.path} (${j.count} doors)`);
});

async function ensure3D() {
  const c3 = document.getElementById('canvas3d');
  if (!state.map3d) {
    const { Map3D } = await import('./map3d.js');
    state.map3d = new Map3D(c3, state.graph, state, {
      onSelectWaypoint: wp => selectWaypoint(wp),
      onSelectFiducial: f => selectFiducial(f),
      apiBase: () => `/api/graphs/${encodeURIComponent(state.graphName)}`,
    });
    if (state.scansVisible && state.scans) state.map3d.setScans(state.scans);
  } else {
    state.map3d.refit();
  }
}

document.getElementById('scans-toggle').addEventListener('click', async () => {
  const btn = document.getElementById('scans-toggle');
  if (!state.scans) {
    btn.disabled = true;
    btn.textContent = 'Loading scans…';
    setStatus('Fetching point clouds (this may take a moment)…');
    const r = await api('/all_points');
    const buf = await r.arrayBuffer();
    state.scans = new Float32Array(buf);
    btn.disabled = false;
    setStatus(`Loaded ${(state.scans.length/3).toLocaleString()} points`);
  }
  state.scansVisible = !state.scansVisible;
  btn.textContent = state.scansVisible ? 'Hide scans' : 'Show scans';
  state.map2d?.setScans(state.scansVisible ? state.scans : null);
  state.map3d?.setScans(state.scansVisible ? state.scans : null);
  state.map2d?.draw();
});

document.getElementById('view-toggle').addEventListener('click', async () => {
  const c2 = document.getElementById('canvas2d'), c3 = document.getElementById('canvas3d');
  if (state.view === '2d') {
    c2.style.display = 'none'; c3.style.display = 'block';
    state.view = '3d';
    document.getElementById('view-toggle').textContent = 'Switch to 2D';
    await ensure3D();
  } else {
    c3.style.display = 'none'; c2.style.display = 'block';
    state.view = '2d';
    document.getElementById('view-toggle').textContent = 'Switch to 3D';
    state.map2d?.draw();
  }
});

init().catch(err => {
  document.getElementById('status').textContent = `Load error: ${err}`;
  console.error(err);
});
