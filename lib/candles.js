'use strict';
/**
 * series API 응답 → PriceChart 입력, 그리고 쿼리 인스펙터(실행한 SQL 보기).
 * main.html(DB 인사이드)·whales.html·game.html 이 같이 쓴다.
 *
 * 캔들 행: [시각, 시가, 고가, 저가, 종가, 체결 수, 매수 대금, 매도 대금] (cgi-bin/src/queries.js)
 */
(function (global) {
  const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  // 체결강도(금액 기준)는 캔들마다 내면 체결이 몇 건 없는 칸에서 0 이나 300 으로 튄다 — 최근 1분(캔들 3개 이상) 누적
  function rollingStrength(rows, step) {
    const n = Math.max(3, Math.round(60000 / step));
    const out = [];
    let buy = 0, sell = 0;
    rows.forEach((r, i) => {
      buy += r[6]; sell += r[7];
      if (i >= n) { buy -= rows[i - n][6]; sell -= rows[i - n][7]; }
      out.push({ t: r[0] + step / 2, v: sell > 1e-9 ? buy / sell * 100 : null });
    });
    return out;
  }

  function toChart(d) {
    return {
      points: d.rows.map((r) => ({ t: r[0], w: d.step, o: r[1], hi: r[2], lo: r[3], v: r[4] })),
      bars: d.rows.map((r) => ({ t: r[0], w: d.step, buy: r[6], sell: r[7], buyQty: r[6], sellQty: r[7] })),
      strength: rollingStrength(d.rows, d.step),
    };
  }

  function big(n) {
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '억';
    if (n >= 1e4) return nf(0).format(Math.round(n / 1e4)) + '만';
    return nf(0).format(n);
  }

  /** 차트 위 한 줄: [롤업] 원본 1.2억 건 분량 → 144행 읽음 · 12ms  SQL */
  function badge(d) {
    const src = d.src === 'rollup'
      ? '<span class="qsrc rollup">롤업</span>'
      : '<span class="qsrc raw">원본</span>';
    const read = d.src === 'rollup'
      ? `원본 <b>${big(d.represented)}</b>건 분량 → <b>${nf(0).format(d.readRows)}</b>행만 읽음`
      : `원본 <b>${big(d.represented)}</b>건 스캔`;
    return `${src} ${read} · <b>${d.elapsedMs}ms</b> <a href="#" class="qsql">SQL</a>`;
  }

  // ── 쿼리 인스펙터: 실행한 SQL 을 보여주는 창 ──
  let modal = null;
  function ensureModal() {
    if (modal) return modal;
    const style = document.createElement('style');
    style.textContent = `
      .qsrc { display: inline-block; font-size: 11px; font-weight: 500; padding: 0 7px; border-radius: 4px; margin-right: 4px; }
      .qsrc.rollup { background: rgba(109, 139, 255, .12); color: #8ea4ff; border: 1px solid rgba(109, 139, 255, .35); }
      .qsrc.raw { background: rgba(255, 255, 255, .05); color: #c4c4c4; border: 1px solid rgba(255, 255, 255, .12); }
      a.qsql { color: #a3a3a3; margin-left: 6px; font-size: 11px; text-decoration: none; border: 1px solid rgba(255,255,255,.2); border-radius: 5px; padding: 1px 6px; }
      a.qsql:hover { color: #f1f1f1; border-color: #626263; }
      .qmodal { position: fixed; inset: 0; background: rgba(5, 7, 10, .72); display: none; align-items: center; justify-content: center; z-index: 30; padding: 16px; }
      .qmodal.show { display: flex; }
      .qmodal .card { background: #2c2c2c; border: 1px solid rgba(255,255,255,.13); border-radius: 12px; width: min(820px, 100%); max-height: 86vh; overflow: auto; padding: 18px 20px; color: #f1f1f1; }
      .qmodal h3 { margin: 0 0 4px; font-size: 16px; }
      .qmodal .meta { color: #a3a3a3; font-size: 12px; margin-bottom: 12px; }
      .qmodal pre { background: #1e1e1e; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 12px; font: 12px/1.6 "D2Coding", ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: #c4c4c4; margin: 0 0 10px; }
      .qmodal button { background: #2c2c2c; color: #f1f1f1; border: 1px solid rgba(255,255,255,.13); border-radius: 6px; padding: 6px 12px; cursor: pointer; float: right; }`;
    document.head.appendChild(style);
    modal = document.createElement('div');
    modal.className = 'qmodal';
    modal.innerHTML = '<div class="card"><button>닫기</button><h3></h3><div class="meta"></div><div class="body"></div></div>';
    modal.onclick = (e) => { if (e.target === modal || e.target.tagName === 'BUTTON') modal.classList.remove('show'); };
    document.body.appendChild(modal);
    return modal;
  }

  /** SQL 을 사람이 읽기 좋게 줄바꿈 */
  function pretty(sql) {
    return String(sql)
      .replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|AND|LIMIT)\s+/g, '\n  $1 ')
      .replace(/\(SELECT /g, '(\n  SELECT ');
  }

  function showSql(title, meta, sqls) {
    const m = ensureModal();
    m.querySelector('h3').textContent = title;
    m.querySelector('.meta').innerHTML = meta;
    m.querySelector('.body').innerHTML = '';
    for (const q of sqls) {
      const pre = document.createElement('pre');
      pre.textContent = pretty(q);
      m.querySelector('.body').appendChild(pre);
    }
    m.classList.add('show');
  }

  /** badge() 를 넣은 요소에 SQL 링크를 연결한다 */
  function wireBadge(el, d, title) {
    ensureModal();
    const a = el.querySelector('.qsql');
    if (!a) return;
    a.onclick = (e) => {
      e.preventDefault();
      const why = d.src === 'rollup'
        ? '롤업: 미리 계산된 분·시 요약을 읽는다. 롤업 쿼리 하나엔 롤업 컬럼 하나라 가격·거래대금·순매수 대금을 따로 묻는다.'
        : '원본: CC_TICK 을 바로 집계한다. 원본은 1일만 보관한다.';
      showSql(title || '이 차트의 쿼리', `${why}<br>원본 ${big(d.represented)}건 분량 · 읽은 행 ${nf(0).format(d.readRows)} · ${d.elapsedMs}ms`, d.sql || []);
    };
  }

  global.CoinCandles = { toChart, rollingStrength, badge, wireBadge, showSql, big };
})(window);
