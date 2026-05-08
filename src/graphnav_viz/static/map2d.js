// 2D top-down canvas renderer with pan/zoom, click hit-test, polygon draw mode.

// Cool→warm colormap, returning [r,g,b] in 0..255, scaled down so additive
// blending against the dark background reads as cyan-yellow-red height tint.
function colormap(t) {
  t = Math.max(0, Math.min(1, t));
  // Three-stop ramp: blue → green → red, brightness 70.
  const r = 70 * Math.min(1, Math.max(0, 2 * t - 1));
  const g = 70 * Math.max(0, 1 - Math.abs(2 * t - 1));
  const b = 70 * Math.min(1, Math.max(0, 1 - 2 * t));
  return [r | 0, g | 0, b | 0];
}

export const FIDUCIAL_COLORS = {
  localization:      '#f56565',  // red
  dock:              '#4fd1c5',  // teal
  dock_station:      '#38b2ac',  // dark teal
  mission_interrupt: '#ed8936',  // orange
  unknown:           '#a0aec0',  // gray
};

export class Map2D {
  constructor(canvas, graph, state, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.graph = graph;
    this.state = state;        // shared annotations + selection
    this.cb = callbacks;       // { onSelectWaypoint, onSelectFiducial, onPolygonClosed }

    // World-frame center to canvas. Initial fit:
    const b = graph.bounds;
    this.center = { x: (b.min_x + b.max_x) / 2, y: (b.min_y + b.max_y) / 2 };
    this._fit();

    this.dragLast = null;
    this.polygonMode = null;     // null | { type: 'room' | 'nogo', vertices: [] }
    this.scans = null;           // Float32Array (3N) in seed frame

    this._handlers = {
      down: e => this._onDown(e),
      move: e => this._onMove(e),
      up: () => (this.dragLast = null),
      wheel: e => this._onWheel(e),
      dblclick: e => this._onDblClick(e),
      resize: () => { this._resize(); this.draw(); },
    };
    canvas.addEventListener('mousedown', this._handlers.down);
    canvas.addEventListener('mousemove', this._handlers.move);
    window.addEventListener('mouseup', this._handlers.up);
    canvas.addEventListener('wheel', this._handlers.wheel, { passive: false });
    canvas.addEventListener('dblclick', this._handlers.dblclick);
    window.addEventListener('resize', this._handlers.resize);
    this._resize();
  }

  destroy() {
    if (!this._handlers) return;
    this.canvas.removeEventListener('mousedown', this._handlers.down);
    this.canvas.removeEventListener('mousemove', this._handlers.move);
    window.removeEventListener('mouseup', this._handlers.up);
    this.canvas.removeEventListener('wheel', this._handlers.wheel);
    this.canvas.removeEventListener('dblclick', this._handlers.dblclick);
    window.removeEventListener('resize', this._handlers.resize);
    this._handlers = null;
    this.graph = null;
    this.scans = null;
  }

  _fit() {
    const b = this.graph.bounds;
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
    const dx = b.max_x - b.min_x, dy = b.max_y - b.min_y;
    this.scale = 0.85 * Math.min(w / Math.max(dx, 0.1), h / Math.max(dy, 0.1));
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // World ↔ screen
  w2s(x, y) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [w / 2 + (x - this.center.x) * this.scale,
            h / 2 - (y - this.center.y) * this.scale];   // flip Y so +y is up
  }
  s2w(sx, sy) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [(sx - w / 2) / this.scale + this.center.x,
            -(sy - h / 2) / this.scale + this.center.y];
  }

  setScans(arr) { this.scans = arr; }

  startPolygon(type) {
    this.polygonMode = { type, vertices: [] };
    this.draw();
  }
  cancelPolygon() {
    this.polygonMode = null;
    this.draw();
  }

  _onDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

    if (this.polygonMode) {
      const [wx, wy] = this.s2w(sx, sy);
      this.polygonMode.vertices.push([wx, wy]);
      this.draw();
      return;
    }

    if (e.button === 0) {
      // Hit-test waypoints (radius 8 px) and fiducials (10 px)
      for (const f of this.graph.fiducials) {
        const [fx, fy] = this.w2s(f.x, f.y);
        if (Math.hypot(fx - sx, fy - sy) < 12) {
          this.cb.onSelectFiducial?.(f);
          return;
        }
      }
      for (const wp of this.graph.waypoints) {
        const [wx, wy] = this.w2s(wp.x, wp.y);
        if (Math.hypot(wx - sx, wy - sy) < 9) {
          this.cb.onSelectWaypoint?.(wp);
          return;
        }
      }
      this.dragLast = { sx, sy };
    }
  }
  _onMove(e) {
    if (!this.dragLast) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    this.center.x -= (sx - this.dragLast.sx) / this.scale;
    this.center.y += (sy - this.dragLast.sy) / this.scale;
    this.dragLast = { sx, sy };
    this.draw();
  }
  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const [wxBefore, wyBefore] = this.s2w(sx, sy);
    this.scale *= e.deltaY < 0 ? 1.15 : (1 / 1.15);
    const [wxAfter, wyAfter] = this.s2w(sx, sy);
    this.center.x += wxBefore - wxAfter;
    this.center.y += wyBefore - wyAfter;
    this.draw();
  }
  _onDblClick(e) {
    if (this.polygonMode && this.polygonMode.vertices.length >= 3) {
      const closed = this.polygonMode;
      this.polygonMode = null;
      this.cb.onPolygonClosed?.(closed.type, closed.vertices);
      this.draw();
    }
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Scans (point-cloud underlay), colored by z. Drawn first so everything else
    // sits on top.
    if (this.scans && this.scans.length) {
      const b = this.graph.bounds;
      const zmin = b.min_z, zspan = Math.max(1e-3, b.max_z - b.min_z);
      const img = ctx.getImageData(0, 0, Math.max(1, w | 0), Math.max(1, h | 0));
      const data = img.data;
      const cx0 = w / 2, cy0 = h / 2;
      for (let i = 0; i < this.scans.length; i += 3) {
        const x = this.scans[i], y = this.scans[i + 1], z = this.scans[i + 2];
        const sx = ((cx0 + (x - this.center.x) * this.scale) | 0);
        const sy = ((cy0 - (y - this.center.y) * this.scale) | 0);
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const t = (z - zmin) / zspan;
        const [r, g, bl] = colormap(t);
        const idx = (sy * w + sx) * 4;
        // Additive write so density shows; alpha stays 255.
        data[idx]     = Math.min(255, data[idx]     + r);
        data[idx + 1] = Math.min(255, data[idx + 1] + g);
        data[idx + 2] = Math.min(255, data[idx + 2] + bl);
        data[idx + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }

    // Rooms
    ctx.fillStyle = 'rgba(72, 187, 120, 0.15)';
    ctx.strokeStyle = 'rgba(72, 187, 120, 0.6)';
    ctx.lineWidth = 1.5;
    for (const r of this.state.annotations.rooms) {
      this._fillPoly(r.polygon_seed);
      this._labelPoly(r.polygon_seed, r.name, '#48bb78');
    }
    // No-go
    ctx.fillStyle = 'rgba(229, 62, 62, 0.15)';
    ctx.strokeStyle = 'rgba(229, 62, 62, 0.7)';
    for (const z of this.state.annotations.no_go_zones) {
      this._fillPoly(z.polygon_seed);
      this._labelPoly(z.polygon_seed, z.name, '#fc8181');
    }

    // Edges
    ctx.strokeStyle = 'rgba(160, 174, 192, 0.45)';
    ctx.lineWidth = 1;
    const wpById = Object.fromEntries(this.graph.waypoints.map(w => [w.id, w]));
    ctx.beginPath();
    for (const e of this.graph.edges) {
      const a = wpById[e.from], b = wpById[e.to];
      if (!a || !b) continue;
      const [ax, ay] = this.w2s(a.x, a.y);
      const [bx, by] = this.w2s(b.x, b.y);
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // Waypoints
    for (const wp of this.graph.waypoints) {
      const [x, y] = this.w2s(wp.x, wp.y);
      const poi = this.state.annotations.waypoint_pois[wp.id];
      const tagged = poi && (poi.name || poi.tags?.length);
      ctx.fillStyle = (this.state.selectedWaypointId === wp.id) ? '#f6ad55'
        : tagged ? '#63b3ed' : '#a0aec0';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fiducials, colored by category. Doors (those in annotations.doors) get
    // an outlined ring on top of the localization color.
    ctx.font = '11px ui-monospace, monospace';
    const doorTagIds = new Set((this.state.annotations.doors || []).map(d => d.tag_id));
    for (const f of this.graph.fiducials) {
      const [x, y] = this.w2s(f.x, f.y);
      ctx.fillStyle = FIDUCIAL_COLORS[f.category] || FIDUCIAL_COLORS.unknown;
      ctx.fillRect(x - 6, y - 6, 12, 12);
      if (doorTagIds.has(f.tag_id)) {
        ctx.strokeStyle = '#f6e05e';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 9, y - 9, 18, 18);
      }
      ctx.fillStyle = '#fff';
      const tag = `#${f.tag_id}`;
      const cat = doorTagIds.has(f.tag_id) ? 'door' : (f.category || 'unknown');
      ctx.fillText(`${tag} ${cat}`, x + 11, y - 4);
    }

    // In-progress polygon
    if (this.polygonMode) {
      ctx.strokeStyle = this.polygonMode.type === 'room' ? '#48bb78' : '#fc8181';
      ctx.fillStyle = this.polygonMode.type === 'room'
        ? 'rgba(72,187,120,0.1)' : 'rgba(252,129,129,0.1)';
      ctx.setLineDash([5, 4]);
      this._fillPoly(this.polygonMode.vertices, true);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.fillText(`drawing ${this.polygonMode.type} (double-click to finish)`, 12, 22);
    }
  }

  _fillPoly(pts, openOk = false) {
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [sx, sy] = this.w2s(x, y);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    });
    if (!openOk || pts.length >= 3) ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  _labelPoly(pts, label, color) {
    if (!pts.length) return;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const [sx, sy] = this.w2s(cx, cy);
    this.ctx.fillStyle = color;
    this.ctx.font = 'bold 12px ui-sans-serif, system-ui';
    this.ctx.fillText(label, sx, sy);
  }
}
