// The cash-plan chart on the Inventory page, drawn on the server as SVG (no script needed –
// the CSP allows only our own scripts): supplier payments per week as bars, cash at week end as a
// line, the cash floor (RM10k) as a dashed red line. Colours come from the page's CSS (classes).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rmShort = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

function niceMax(v) {
  if (v <= 0) return 10000;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = [1, 2, 2.5, 5, 10].find((m) => m * p >= v);
  return n * p;
}

function cashChartSvg(cash, { width = 640, height = 260 } = {}) {
  const weeks = cash.weeks || [];
  if (!weeks.length) return '';
  const left = 44; const right = 10; const top = 12; const bottom = 30;
  const max = niceMax(Math.max(cash.floor, ...weeks.map((w) => Math.max(w.supplierOut, w.cashEnd))) * 1.08);
  const y = (v) => top + (height - top - bottom) * (1 - v / max);
  const step = (width - left - right) / weeks.length;
  const bw = step * 0.55;
  const cx = (i) => left + step * i + step / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const parts = [];
  parts.push(`<svg class="inv-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Supplier payments and cash at week end, by week" xmlns="http://www.w3.org/2000/svg">`);
  for (const t of ticks) {
    parts.push(`<line class="inv-grid" x1="${left}" x2="${width - right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`);
    parts.push(`<text class="inv-axis" x="${left - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${t === 0 ? '0' : rmShort(t)}</text>`);
  }
  weeks.forEach((w, i) => {
    const h = y(0) - y(w.supplierOut);
    parts.push(`<rect class="inv-bar" x="${(cx(i) - bw / 2).toFixed(1)}" y="${y(w.supplierOut).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3"><title>${esc(w.week)}: suppliers RM${Math.round(w.supplierOut).toLocaleString('en-US')}</title></rect>`);
    parts.push(`<text class="inv-axis" x="${cx(i).toFixed(1)}" y="${height - 10}" text-anchor="middle">${esc(w.week.split('–')[0])}</text>`);
  });
  parts.push(`<line class="inv-floor" x1="${left}" x2="${width - right}" y1="${y(cash.floor).toFixed(1)}" y2="${y(cash.floor).toFixed(1)}"/>`);
  parts.push(`<polyline class="inv-line" points="${weeks.map((w, i) => `${cx(i).toFixed(1)},${y(w.cashEnd).toFixed(1)}`).join(' ')}"/>`);
  weeks.forEach((w, i) => {
    parts.push(`<circle class="inv-dot${w.short ? ' is-short' : ''}" cx="${cx(i).toFixed(1)}" cy="${y(w.cashEnd).toFixed(1)}" r="4"><title>${esc(w.week)}: cash at week end RM${Math.round(w.cashEnd).toLocaleString('en-US')}</title></circle>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

module.exports = { cashChartSvg };
