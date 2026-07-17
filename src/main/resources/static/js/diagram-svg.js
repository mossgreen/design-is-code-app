// Shared sequence-diagram SVG renderer, fed by the server's DiagramModel JSON
// ({participants:[...], steps:[{kind,from,to,label}]}) — no puml parsing.
// Used by the wizard's Step-3 before-view and the code-diff dev harness.
// Deliberately tiny: lifelines, solid call arrows, dashed typed returns, one
// level of alt frame. `[*]` renders as the system-caller boundary dot.
function renderSeqSvg(model, container, accent, theme) {
  const CH = 6.8, ROW = 28, TOP = 48, PAD = 14;
  const names = model.participants;
  const half = names.map(n => n === '[*]' ? 10 : Math.max(28, n.length * CH / 2 + 12));

  // adjacent-lifeline gaps widened so arrow labels fit between their endpoints
  const idx = {}; names.forEach((n, i) => idx[n] = i);
  const gaps = new Array(Math.max(0, names.length - 1)).fill(46);
  for (const s of model.steps) {
    if (s.kind !== 'call' && s.kind !== 'return') continue;
    const a = idx[s.from], b = idx[s.to];
    if (a == null || b == null || a === b) continue;
    const i = Math.min(a, b), j = Math.max(a, b);
    const need = ((s.label || '').length * CH + 28) / (j - i);
    for (let g = i; g < j; g++) gaps[g] = Math.max(gaps[g], need);
  }
  const x = [];
  names.forEach((n, i) => {
    x[i] = i === 0 ? PAD + half[0] : x[i - 1] + half[i - 1] + gaps[i - 1] + half[i];
  });
  const width = Math.ceil(x[names.length - 1] + half[names.length - 1] + PAD);
  const height = TOP + model.steps.length * ROW + 18;

  const NS = 'http://www.w3.org/2000/svg';
  const el = (t, at) => { const e = document.createElementNS(NS, t); for (const k in at) e.setAttribute(k, at[k]); return e; };
  const txt = (s, at) => { const e = el('text', at); e.textContent = s; return e; };
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`,
    'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '11.5' });
  // Default palette matches the dark dev-harness page; the light-themed
  // wizard passes its own via `theme`.
  const t = theme || {};
  const LINE = t.line || '#475569', INK = t.ink || '#e2e8f0',
        MUTED = t.muted || '#94a3b8', BOX = t.box || '#1e293b';

  names.forEach((n, i) => {
    svg.appendChild(el('line', { x1: x[i], y1: TOP - 10, x2: x[i], y2: height - 8,
      stroke: LINE, 'stroke-dasharray': '3,3' }));
    if (n === '[*]') {
      svg.appendChild(el('circle', { cx: x[i], cy: 21, r: 7, fill: INK }));
    } else {
      svg.appendChild(el('rect', { x: x[i] - half[i], y: 8, width: half[i] * 2, height: 26,
        rx: 6, fill: BOX, stroke: LINE }));
      svg.appendChild(txt(n, { x: x[i], y: 25, fill: INK, 'text-anchor': 'middle', 'font-weight': '600' }));
    }
  });

  const frameX1 = PAD + 2, frameX2 = width - PAD - 2;
  let y = TOP + 12, altY0 = null;
  const arrow = (s) => {
    const x1 = x[idx[s.from]], x2 = x[idx[s.to]];
    const isReturn = s.kind === 'return';
    svg.appendChild(el('line', { x1, y1: y, x2, y2: y,
      stroke: isReturn ? MUTED : INK, 'stroke-dasharray': isReturn ? '5,4' : 'none' }));
    const dir = x2 >= x1 ? -1 : 1; // head points along travel direction
    svg.appendChild(el('polygon', {
      points: `${x2},${y} ${x2 + dir * 8},${y - 4} ${x2 + dir * 8},${y + 4}`,
      fill: isReturn ? BOX : INK, stroke: isReturn ? MUTED : INK }));
    svg.appendChild(txt(s.label || '', { x: (x1 + x2) / 2, y: y - 6,
      fill: isReturn ? MUTED : INK, 'text-anchor': 'middle' }));
  };
  for (const s of model.steps) {
    if (s.kind === 'alt-start') {
      altY0 = y - 12;
      svg.appendChild(txt(`alt  [${s.label}]`, { x: frameX1 + 8, y: y + 2, fill: accent, 'font-weight': '700' }));
    } else if (s.kind === 'alt-else') {
      svg.appendChild(el('line', { x1: frameX1, y1: y - 10, x2: frameX2, y2: y - 10,
        stroke: accent, 'stroke-dasharray': '6,4' }));
      svg.appendChild(txt(`[${s.label}]`, { x: frameX1 + 8, y: y + 4, fill: accent, 'font-weight': '700' }));
    } else if (s.kind === 'alt-end') {
      svg.appendChild(el('rect', { x: frameX1, y: altY0, width: frameX2 - frameX1, height: y - 8 - altY0,
        rx: 4, fill: 'none', stroke: accent }));
      altY0 = null;
    } else {
      arrow(s);
    }
    y += ROW;
  }
  container.replaceChildren(svg);
}
