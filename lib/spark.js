'use strict';
/**
 * 스파크라인 — neo-web 새 탭(ServerPulse)과 같은 모양. 고래·모의투자 화면이 쓴다 (main.html 에도 같은 함수가 있다).
 *   drawSparks(box, series)  box 안의 canvas.spark 마다 series[i] 를 그린다.
 *   series[i] = [[ms, 값], …] 또는 { pts: [[ms, 값], …], zero: false }  (zero:false 면 0 이 아니라 최솟값~최댓값으로)
 */
function drawSparks(box, series) {
  box.querySelectorAll('canvas.spark').forEach((c, i) => {
    const item = series[i] || [];
    const sr = Array.isArray(item) ? item : item.pts || [];
    const zero = Array.isArray(item) || item.zero !== false;   // false 면 최솟값~최댓값으로 (변화가 작을 때)
    const W = c.clientWidth, H = c.clientHeight, dpr = devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    if (sr.length < 2) {
      g.fillStyle = '#727272'; g.font = '11px Pretendard, sans-serif'; g.textBaseline = 'middle';
      g.fillText('데이터를 모으는 중', 0, H / 2); return;
    }
    const t0 = sr[0][0], t1 = sr[sr.length - 1][0];
    let max = -Infinity, min = Infinity, sum = 0; for (const p of sr) { max = Math.max(max, p[1]); min = Math.min(min, p[1]); sum += p[1]; }
    let lo = 0, hi = max * 1.15 || 1;
    if (!zero) { const pad = (max - min) * 0.2 || Math.abs(max) * 0.001 || 1; lo = min - pad; hi = max + pad; }
    const X = (t) => 2 + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - 6), Y = (v) => H - 3 - (v - lo) / (hi - lo) * (H - 8);
    const avg = Y(sum / sr.length);
    g.strokeStyle = 'rgba(255, 255, 255, .08)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, Math.round(avg) + 0.5); g.lineTo(W, Math.round(avg) + 0.5); g.stroke();
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(109, 139, 255, .32)'); grad.addColorStop(1, 'rgba(109, 139, 255, 0)');
    g.beginPath(); g.moveTo(X(sr[0][0]), H);
    for (const p of sr) g.lineTo(X(p[0]), Y(p[1]));
    g.lineTo(X(t1), H); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); sr.forEach((p, k) => (k ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
    g.strokeStyle = '#8ea4ff'; g.lineWidth = 1.5; g.lineJoin = 'round'; g.stroke();
    g.beginPath(); g.arc(X(t1), Y(sr[sr.length - 1][1]), 3, 0, Math.PI * 2); g.fillStyle = '#a9b8ff'; g.fill();
  });
}
window.drawSparks = drawSparks;
