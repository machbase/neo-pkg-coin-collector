'use strict';
/**
 * GET /cgi-bin/api/range?name=BINANCE.BTCUSDT&from=<ms>&to=<ms>
 *
 * 되감기용. 구간의 원본 체결을 밀리초 단위 그대로 시각순으로 돌려준다.
 * 최대 MAX_SPAN_MS 구간, MAX_ROWS 행 — 넘으면 truncated.
 *
 * 응답: { rows: [[t, price, qty]], truncated, elapsedMs }
 */
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));
const markets = require(path.join(ROOT, 'src', 'markets.js'));

const MAX_SPAN_MS = 30 * 60000;
const MAX_ROWS = 300000;

try {
    const name = cgi.query('name');
    if (!markets.isKnown(name)) throw new Error('unknown name: ' + name);
    const from = parseInt(cgi.query('from') || '0', 10);
    let to = parseInt(cgi.query('to') || '0', 10);
    if (!(from > 0)) throw new Error('from is required');
    if (!(to > from)) to = from + 60000;
    if (to - from > MAX_SPAN_MS) to = from + MAX_SPAN_MS;

    // name 은 고정 목록에서 확인했고, from·to 는 정수라 문자열 결합해도 안전하다.
    const sql = 'SELECT TO_TIMESTAMP(TIME) / 1000000 AS MS, VALUE, QTY FROM ' + schema.TABLE
        + " WHERE NAME = '" + name + "'"
        + ' AND TIME >= FROM_TIMESTAMP(' + from + ' * 1000000) AND TIME < FROM_TIMESTAMP(' + to + ' * 1000000)'
        + ' ORDER BY TIME LIMIT ' + MAX_ROWS;

    const t0 = Date.now();
    const rows = db.withConn((conn) => db.rows(conn, sql));
    const elapsedMs = Date.now() - t0;
    const out = rows.map((r) => [Math.round(Number(r.MS)), Number(r.VALUE), Number(r.QTY)]);
    cgi.ok({ name: name, from: from, to: to, rows: out, truncated: out.length >= MAX_ROWS, elapsedMs: elapsedMs });
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
