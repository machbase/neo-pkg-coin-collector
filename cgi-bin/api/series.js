'use strict';
/**
 * GET /cgi-bin/api/series?name=BINANCE.BTCUSDT&from=<ms>&to=<ms>&points=600[&src=auto|raw|rollup]
 *
 * 구간을 약 points 개 캔들로. 캔들: [시각, 시가, 고가, 저가, 종가, 체결 수, 매수 대금, 매도 대금] (src/queries.js)
 *
 * src
 *   auto   캔들 간격이 1분 이상이면 롤업, 아니면 원본 (기본)
 *   raw    원본 CC_TICK 을 바로 집계 — 원본은 1일만 둔다
 *   rollup 미리 계산된 분·시 롤업 — 원본이 지워진 구간도 된다. 캔들 간격은 1분 이상
 *
 * 응답에는 화면의 쿼리 인스펙터용으로 실행한 SQL, 원본으로 치면 몇 건인지(represented), 읽은 행 수, 걸린 시간을 담는다.
 * { src, step, rows, represented, readRows, elapsedMs, sql: [...] }
 */
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const markets = require(path.join(ROOT, 'src', 'markets.js'));
const Q = require(path.join(ROOT, 'src', 'queries.js'));

// 캔들 간격 후보(초) — 사람이 읽기 좋은 간격만
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

try {
    const name = cgi.query('name');
    if (!markets.isKnown(name)) throw new Error('unknown name: ' + name);
    const now = Date.now();
    let to = parseInt(cgi.query('to') || '0', 10);
    let from = parseInt(cgi.query('from') || '0', 10);
    if (!(to > 0)) to = now;
    if (!(from > 0) || from >= to) from = to - 15 * 60000;
    let points = parseInt(cgi.query('points') || '600', 10);
    if (!(points > 0) || points > 3000) points = 600;
    let src = cgi.query('src') || 'auto';
    if (['auto', 'raw', 'rollup'].indexOf(src) < 0) src = 'auto';

    const want = (to - from) / 1000 / points;
    let step = STEPS[STEPS.length - 1];
    for (const s of STEPS) if (s >= want) { step = s; break; }
    if (src === 'auto') src = step >= 60 ? 'rollup' : 'raw';
    if (src === 'rollup' && step < 60) step = 60;   // 롤업은 분 단위부터

    // name 은 고정 목록에서 확인했고, from·to·step 은 정수라 문자열 결합해도 안전하다.
    const t0 = Date.now();
    let rows, sql, readRows;
    db.withConn(function (conn) {
        if (src === 'raw') {
            sql = [Q.rawCandles(name, from, to, step)];
            rows = Q.fromRaw(db.rows(conn, sql[0]));
            readRows = null;   // 원본은 represented 만큼 읽는다
        } else {
            const qs = Q.rollupCandles(name, from, to, step);
            sql = [qs.price, qs.amt, qs.samt];
            const p = db.rows(conn, qs.price), a = db.rows(conn, qs.amt), s = db.rows(conn, qs.samt);
            rows = Q.fromRollup(p, a, s);
            readRows = p.length + a.length + s.length;
        }
    });
    const elapsedMs = Date.now() - t0;
    let represented = 0;
    for (const r of rows) represented += r[5];
    if (readRows == null) readRows = represented;
    cgi.ok({ name: name, from: from, to: to, src: src, step: step * 1000, rows: rows,
        represented: represented, readRows: readRows, elapsedMs: elapsedMs, sql: sql });
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
