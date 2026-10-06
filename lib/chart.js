'use strict';
/**
 * 가격 차트 (캔버스). main.html·whales.html·game.html 이 쓴다. 외부 라이브러리 없음 — 인터넷이 없는
 * 현장 서버에서도 그려져야 한다.
 *
 *   const c = new PriceChart(canvas, { format: (v) => v.toFixed(2) });
 *   c.set({ points, whales, from, to, until });
 *
 *   points  [{ t, v, lo?, hi? }]  시각순. lo/hi 가 있으면 구간 범위를 옅게 칠한다.
 *                                  원본 체결(수만 개)도 그대로 넣어도 된다 — 픽셀 단위로 모아 그린다.
 *           [{ t, w, o, hi, lo, v }]  o(시가)·w(캔들 폭 ms)가 있으면 캔들로 그린다 (t = 캔들 시작, v = 종가).
 *                                  캔들 폭이 3px 보다 좁으면 선으로 그린다.
 *   whales  [{ t, v, usd, side }] 고래. 크기는 금액, 색은 방향. 클릭하면 options.onWhale(w)
 *   bars    [{ t, w, buy, sell }] (선택) 가격 아래 거래대금 막대. t 버킷 시작, w 버킷 폭(ms), 금액은 USDT
 *   strength [{ t, v }]           (선택) 체결강도 선 (매수량 ÷ 매도량 × 100). 막대 영역에 100 기준선과 함께
 *   lines   [{ v, label, color, fit }] (선택) 가로선 (진입가·청산가 등). fit 이면 세로축 범위에 넣고, 아니면 범위 밖일 때
 *                                  위·아래 끝에 방향과 값만 적는다 — 먼 청산가 때문에 가격선이 납작해지지 않게
 *   from/to 가로축 범위(ms).       until 이 있으면 그 시각까지만 그리고 세로선을 긋는다.
 */
(function (global) {
  // neo-web 다크 팔레트에 맞춘다 (design-system/tokens/_colors.scss). 상승 빨강·하락 파랑은 국내 관례
  const UP = '#f0454f', DOWN = '#3b82f6', LINE = '#f1f1f1', FLAT = '#626263', GRID = 'rgba(255, 255, 255, .08)', MUTED = '#a3a3a3', WHALE = '#8ea4ff';   // 고래 표시·체결강도 선 — lib/graphite.css 의 톤
  // 십자선과 축 위 값 표시 — lib/graphite.css 의 톤
  const CROSS = 'rgba(241, 241, 241, .45)', AXIS_TAG = '#4a5aa8';

  function niceTimeStep(spanMs, maxTicks) {
    const steps = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5];
    for (const s of steps) if (spanMs / s <= maxTicks) return s;
    return steps[steps.length - 1];
  }
  function niceValueStep(span, maxTicks) {
    const raw = span / maxTicks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
    return 10 * mag;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function timeLabel(t, step) {
    const d = new Date(t);
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return step < 6e4 ? hm + ':' + pad2(d.getSeconds()) : hm;
  }

  class PriceChart {
    constructor(canvas, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opt = Object.assign({ format: (v) => String(v), height: 260, volumeHeight: 90 }, options || {});
      this.state = { points: [], whales: [], bars: null, strength: null, lines: null, from: 0, to: 1, until: null };
      this.hoverWhale = null;
      this.hover = null;
      const ro = new ResizeObserver(() => this.draw());
      ro.observe(canvas.parentElement);
      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.draw();
      });
      canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
      canvas.addEventListener('click', () => { if (this.hoverWhale && this.opt.onWhale) this.opt.onWhale(this.hoverWhale); });
    }

    set(patch) {
      Object.assign(this.state, patch);
      this.draw();
    }

    draw() {
      const { canvas, ctx } = this;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.parentElement.clientWidth, H = this.opt.height;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const s = this.state;
      const L = 8, R = 78, T = 12, B = 24, GAP = 12;
      const hasVol = !!(s.bars && s.bars.length);
      const vh = hasVol ? this.opt.volumeHeight : 0;
      const pw = W - L - R, ph = H - T - B - (hasVol ? vh + GAP : 0);
      const VT = T + ph + GAP;   // 막대 영역 위쪽
      const end = s.until != null ? Math.min(s.until, s.to) : s.to;
      const pts = s.points.filter((p) => p.t >= s.from && p.t <= end);
      const whales = s.whales.filter((w) => w.t >= s.from && w.t <= end);

      if (pts.length === 0) {
        ctx.fillStyle = MUTED; ctx.font = '13px -apple-system, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('데이터 없음', W / 2, H / 2);
        return;
      }

      // 세로축: 보이는 데이터 전체(재생 중이면 전체 구간) 기준으로 고정해 흔들리지 않게
      const scope = s.until != null ? s.points.filter((p) => p.t >= s.from && p.t <= s.to) : pts;
      let lo = Infinity, hi = -Infinity;
      for (const p of scope) { lo = Math.min(lo, p.lo != null ? p.lo : p.v); hi = Math.max(hi, p.hi != null ? p.hi : p.v); }
      for (const w of whales) { lo = Math.min(lo, w.v); hi = Math.max(hi, w.v); }
      for (const l of s.lines || []) if (l.fit) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); }
      if (hi === lo) { hi += Math.abs(hi) * 0.0005 || 1; lo -= Math.abs(lo) * 0.0005 || 1; }
      const padV = (hi - lo) * 0.12; lo -= padV; hi += padV;

      const X = (t) => L + (t - s.from) / (s.to - s.from) * pw;
      const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * ph;

      // 격자·축
      ctx.font = '11px -apple-system, sans-serif';
      ctx.lineWidth = 1;
      const vs = niceValueStep(hi - lo, 5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (let v = Math.ceil(lo / vs) * vs; v <= hi; v += vs) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
        ctx.fillStyle = MUTED; ctx.fillText(this.opt.format(v), L + pw + 8, y);
      }
      const ts = niceTimeStep(s.to - s.from, Math.max(2, Math.floor(pw / 90)));
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const bottom = hasVol ? VT + vh : T + ph;
      for (let t = Math.ceil(s.from / ts) * ts; t <= s.to; t += ts) {
        const x = Math.round(X(t)) + 0.5;
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, bottom); ctx.stroke();
        ctx.fillStyle = MUTED; ctx.fillText(timeLabel(t, ts), x, bottom + 6);
      }
      if (hasVol) this.drawVolume(s, X, L, pw, VT, vh, end);

      const first = pts[0].o != null ? pts[0].o : pts[0].v, lastV = pts[pts.length - 1].v;
      const trend = lastV > first ? UP : lastV < first ? DOWN : FLAT;
      const candleW = pts[0].o != null && pts[0].w ? X(s.from + pts[0].w) - X(s.from) : 0;
      let hoverCandle = null;
      if (candleW >= 3) {
        // 캔들: 꼬리(고가~저가) + 몸통(시가~종가). 종가가 시가 이상이면 빨강, 아니면 파랑 (국내 관례)
        const bw = Math.max(1, Math.min(candleW * 0.7, candleW - 1));
        for (const p of pts) {
          const cx = X(p.t + p.w / 2);
          const color = p.v >= p.o ? UP : DOWN;
          ctx.strokeStyle = color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, Y(p.hi)); ctx.lineTo(Math.round(cx) + 0.5, Y(p.lo)); ctx.stroke();
          const y1 = Y(Math.max(p.o, p.v)), y2 = Y(Math.min(p.o, p.v));
          ctx.fillStyle = color;
          ctx.fillRect(cx - bw / 2, y1, bw, Math.max(1, y2 - y1));
          if (this.hover && Math.abs(this.hover.x - cx) <= candleW / 2) hoverCandle = p;
        }
      } else {
      // 픽셀 열마다 모은다 — 원본 체결 수만 개도 한 번에 그린다
      const cols = new Map();
      for (const p of pts) {
        const x = Math.round(X(p.t));
        let c = cols.get(x);
        if (!c) cols.set(x, c = { lo: Infinity, hi: -Infinity, last: p.v });
        c.lo = Math.min(c.lo, p.lo != null ? p.lo : p.v);
        c.hi = Math.max(c.hi, p.hi != null ? p.hi : p.v);
        c.last = p.v;
      }
      const xs = [...cols.keys()].sort((a, b) => a - b);

      ctx.fillStyle = 'rgba(241, 241, 241, 0.10)';
      for (const x of xs) {
        const c = cols.get(x);
        const y1 = Y(c.hi), y2 = Y(c.lo);
        if (y2 - y1 >= 1) ctx.fillRect(x - 0.5, y1, 1.5, y2 - y1);
      }
      ctx.strokeStyle = trend === FLAT ? LINE : trend;
      ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
      ctx.beginPath();
      xs.forEach((x, i) => { const y = Y(cols.get(x).last); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      }

      // 가로선 (진입가·청산가)
      for (const l of s.lines || []) {
        const color = l.color || LINE;
        ctx.font = '11px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
        if (l.v >= lo && l.v <= hi) {
          const y = Math.round(Y(l.v)) + 0.5;
          ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.setLineDash([]);
          const text = l.label + ' ' + this.opt.format(l.v);
          const tw = ctx.measureText(text).width + 10;
          ctx.fillStyle = 'rgba(37, 37, 37, .9)'; ctx.fillRect(L + 4, y - 9, tw, 18);
          ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(text, L + 9, y);
        } else {
          const above = l.v > hi;
          const text = l.label + ' ' + (above ? '↑ ' : '↓ ') + this.opt.format(l.v);
          const tw = ctx.measureText(text).width + 10;
          const y = above ? T + 10 : T + ph - 10;
          ctx.fillStyle = 'rgba(37, 37, 37, .9)'; ctx.fillRect(L + 4, y - 9, tw, 18);
          ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(text, L + 9, y);
        }
      }

      // 현재가 표시
      // 박스 색은 추세로 정한다 — ctx.strokeStyle 을 쓰면 앞에서 그린 가로선(흰색) 색이 남아 흰 박스에 흰 글씨가 된다
      const ly = Y(lastV);
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = trend;
      ctx.fillRect(L + pw + 2, ly - 9, R - 4, 18);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(this.opt.format(lastV), L + pw + 6, ly);

      // 고래
      let hoverWhale = null;
      for (const w of whales) {
        const x = X(w.t), y = Y(w.v);
        const r = Math.min(22, 5 + Math.sqrt(w.usd / 4e4) * 4);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = w.side > 0 ? 'rgba(240, 69, 79, .35)' : 'rgba(59, 130, 246, .35)';
        ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = WHALE; ctx.stroke();
        if (this.hover && Math.hypot(this.hover.x - x, this.hover.y - y) <= r + 3) hoverWhale = w;
      }

      this.hoverWhale = hoverWhale;
      canvas.style.cursor = hoverWhale && this.opt.onWhale ? 'pointer' : 'default';

      // 재생 위치
      if (s.until != null && s.until <= s.to) {
        const x = Math.round(X(s.until)) + 0.5;
        ctx.strokeStyle = WHALE; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 마우스 위치 — 십자선: 세로선(가격·막대 영역 전체)과 가로선(가격 영역), 축에 그 위치의 시각·가격
      if (this.hover && this.hover.x >= L && this.hover.x <= L + pw) {
        const hx = Math.round(hoverCandle ? X(hoverCandle.t + hoverCandle.w / 2) : this.hover.x) + 0.5;
        ctx.save();
        ctx.strokeStyle = CROSS; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(hx, T); ctx.lineTo(hx, bottom); ctx.stroke();
        const inPrice = this.hover.y >= T && this.hover.y <= T + ph;
        const hy = Math.round(this.hover.y) + 0.5;
        if (inPrice) { ctx.beginPath(); ctx.moveTo(L, hy); ctx.lineTo(L + pw, hy); ctx.stroke(); }
        ctx.setLineDash([]);
        ctx.font = '11px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
        if (inPrice) {
          const v = lo + (1 - (this.hover.y - T) / ph) * (hi - lo);
          ctx.fillStyle = AXIS_TAG; ctx.fillRect(L + pw + 2, hy - 9, R - 4, 18);
          ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(this.opt.format(v), L + pw + 6, hy);
        }
        const ht = hoverCandle ? hoverCandle.t : s.from + (hx - L) / pw * (s.to - s.from);
        const tl = timeLabel(ht, hoverCandle ? hoverCandle.w : 1000);   // 선이면 초까지 — 툴팁 시각과 같게
        const tw = ctx.measureText(tl).width + 12;
        const tx = Math.min(Math.max(hx - tw / 2, L), L + pw - tw);
        ctx.fillStyle = AXIS_TAG; ctx.fillRect(tx, bottom + 2, tw, 18);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(tl, tx + tw / 2, bottom + 11);
        ctx.restore();
        let text;
        if (hoverWhale) {
          const f = this.opt.formatMoney || ((v) => String(Math.round(v)));
          text = '고래 ' + f(hoverWhale.usd) + ' ' + (hoverWhale.side > 0 ? '매수' : '매도') + ' · ' + timeLabel(hoverWhale.t, 1000)
            + (this.opt.onWhale ? ' · 클릭해서 확대' : '');
        } else if (hoverCandle) {
          const p = hoverCandle, f = this.opt.format;
          text = timeLabel(p.t, p.w) + ' · 시 ' + f(p.o) + ' 고 ' + f(p.hi) + ' 저 ' + f(p.lo) + ' 종 ' + f(p.v);
          const bar = hasVol ? s.bars.find((b) => b.t === p.t) : null;
          if (bar) {
            const fm = this.opt.formatMoney || ((v) => String(Math.round(v)));
            text += ' · 거래대금 ' + fm(bar.buy + bar.sell);
          }
        } else {
          const t = s.from + (this.hover.x - L) / pw * (s.to - s.from);
          let best = null;
          for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
          if (best) {
            text = timeLabel(best.t, 1000) + ' · ' + this.opt.format(best.v);
            const bar = hasVol ? s.bars.find((b) => best.t >= b.t && best.t < b.t + b.w) : null;
            if (bar) {
              const f = this.opt.formatMoney || ((v) => String(Math.round(v)));
              text += ' · 거래대금 ' + f(bar.buy + bar.sell) + (bar.sell > 0 ? ' · 체결강도 ' + Math.round(bar.buyQty / bar.sellQty * 100) : '');
            }
          }
        }
        if (text) {
          ctx.font = '12px -apple-system, sans-serif';
          const tw = ctx.measureText(text).width + 16;
          const bx = Math.min(Math.max(this.hover.x + 12, L), L + pw - tw);
          ctx.fillStyle = 'rgba(30, 30, 30, .96)'; ctx.strokeStyle = 'rgba(255, 255, 255, .13)';
          ctx.fillRect(bx, T + 4, tw, 24); ctx.strokeRect(bx + 0.5, T + 4.5, tw - 1, 23);
          ctx.fillStyle = LINE; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(text, bx + 8, T + 16);
        }
      }
    }
  }

  // 거래대금 막대(매수 빨강 아래·매도 파랑 위로 쌓음)와 체결강도 선. 체결강도는 0~300 으로 자르고 100 에 기준선.
  PriceChart.prototype.drawVolume = function (s, X, L, pw, VT, vh, end) {
    const ctx = this.ctx;
    const bars = s.bars.filter((b) => b.t + b.w > s.from && b.t <= end);
    let max = 0;
    for (const b of bars) max = Math.max(max, b.buy + b.sell);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, VT + vh + 0.5); ctx.lineTo(L + pw, VT + vh + 0.5); ctx.stroke();
    ctx.font = '11px -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = MUTED; ctx.fillText('거래대금', L + 4, VT);
    if (max > 0) {
      const f = this.opt.formatMoney || ((v) => String(Math.round(v)));
      ctx.fillText(f(max), L + pw + 8, VT);
      for (const b of bars) {
        const x1 = X(b.t), x2 = X(b.t + b.w);
        const w = Math.max(1, x2 - x1 - (x2 - x1 > 3 ? 1 : 0));
        const hb = b.buy / max * vh, hs = b.sell / max * vh;
        ctx.fillStyle = 'rgba(240, 69, 79, .75)'; ctx.fillRect(x1, VT + vh - hb, w, hb);
        ctx.fillStyle = 'rgba(59, 130, 246, .75)'; ctx.fillRect(x1, VT + vh - hb - hs, w, hs);
      }
    }
    const st = (s.strength || []).filter((p) => p.t >= s.from && p.t <= end && p.v != null);
    if (st.length) {
      const SY = (v) => VT + vh - Math.min(300, v) / 300 * vh;
      ctx.setLineDash([3, 4]); ctx.strokeStyle = MUTED;
      ctx.beginPath(); ctx.moveTo(L, SY(100) + 0.5); ctx.lineTo(L + pw, SY(100) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = WHALE; ctx.textBaseline = 'middle'; ctx.fillText('체결강도 100', L + pw + 8, SY(100));
      ctx.strokeStyle = WHALE; ctx.lineWidth = 1.4;
      ctx.beginPath();
      st.forEach((p, i) => (i ? ctx.lineTo(X(p.t), SY(p.v)) : ctx.moveTo(X(p.t), SY(p.v))));
      ctx.stroke();
    }
  };

  global.PriceChart = PriceChart;
})(window);
