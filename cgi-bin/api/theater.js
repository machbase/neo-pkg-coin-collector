'use strict';
/**
 * GET /cgi-bin/api/theater?id=<질문>&mode=<방식>[&name=<태그>]  — "원본 vs 롤업 속도 비교".
 *   미리 정한 질문만 실행한다 (입력 SQL 은 받지 않는다). 코인을 고르는 질문(coin: true)은 name 으로 태그를 받는다.
 * GET /cgi-bin/api/theater?id=list  질문 목록 + 고를 수 있는 태그 (체결 테이블에 데이터가 있는 태그 ∪ 지금 수집 설정)
 *
 * 질문마다 두 방식으로 풀어 속도를 나란히 보여준다:
 *   day_candles  고른 코인 24시간 5분봉            raw(원본 집계) | rollup(분 롤업)
 *   week_candles 고른 코인 7일 30분봉              raw(원본은 1일뿐 — 그만큼만 나온다) | rollup
 *   top_coins    지난 1시간 코인별 거래대금 TOP 10  raw(원본 전체 GROUP BY NAME) | rollup(롤업 테이블을 직접 읽기)
 *   count        지금 보관 중인 체결 건수          stat(태그 통계 뷰) | count(COUNT(*))
 *   last_second  방금 1초의 고른 코인 원본 체결      raw (태그·시각 인덱스)
 *
 * name 이 없으면 수집 설정(src/config.js)의 첫 번째 코인 (선물을 받으면 선물 태그 — 체결이 많다).
 * name 은 markets.isKnown(태그 모양 BINANCE[_F].<영문·숫자>USDT)을 거친다 — SQL 에 문자열로 붙인다.
 *
 * 롤업 쿼리는 종목별로 묶을 수 없다 (GROUP BY NAME 이면 빈 결과, v8.5.13 실측) — top_coins 의 롤업 방식은 롤업
 * 테이블(_CC_TICK_AMT_MIN)을 태그 메타(_CC_TICK_META)와 조인해 직접 읽는다.
 *
 * 응답: { id, mode, title, kind: candles|bars|table|number, sql: [...], ms, readRows, represented?, data }
 */
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));
const Q = require(path.join(ROOT, 'src', 'queries.js'));
const config = require(path.join(ROOT, 'src', 'config.js'));
const markets = require(path.join(ROOT, 'src', 'markets.js'));

// 지금 수집 설정의 태그 (설정 순서, 선물 먼저). 이름은 markets.normalize 를 거친 영문 대문자·숫자라 SQL 에 붙여도 안전하다
const CONFIG_TAGS = (function () {
    const out = [];
    for (const c of config.load().coins) {
        if (c.futures) out.push(markets.futuresTagOf(c.coin));
        if (c.spot) out.push(markets.tagOf(c.coin));
    }
    return out;
})();
const DEFAULT_TAG = CONFIG_TAGS[0] || 'BINANCE_F.BTCUSDT';
const PICKS = [DEFAULT_TAG, CONFIG_TAGS[1] || DEFAULT_TAG];   // 옛 화면 호환
const label = (tag) => markets.coinOf(tag) + (/^BINANCE_F\./.test(tag) ? ' 선물' : ' 현물');

const T = schema.TABLE;
const HOUR = 3600000, DAY = 86400000;
const since = (fromMs) => 'TIME >= FROM_TIMESTAMP(' + Math.floor(fromMs) + ' * 1000000)';

function candles(conn, name, from, to, step, mode) {
    if (mode === 'raw') {
        const sql = Q.rawCandles(name, from, to, step);
        const data = Q.fromRaw(db.rows(conn, sql));
        return { sql: [sql], data: data, readRows: data.reduce((a, r) => a + r[5], 0) };
    }
    const qs = Q.rollupCandles(name, from, to, step);
    const p = db.rows(conn, qs.price), a = db.rows(conn, qs.amt), s = db.rows(conn, qs.samt);
    return { sql: [qs.price, qs.amt, qs.samt], data: Q.fromRollup(p, a, s), readRows: p.length + a.length + s.length };
}

const QUESTIONS = {
    day_candles: {
        title: (n) => label(n) + ' 24시간 5분봉', kind: 'candles', modes: ['raw', 'rollup'], coin: true,
        run: (conn, mode, now, n) => candles(conn, n, now - DAY, now, 300, mode),
    },
    week_candles: {
        title: (n) => label(n) + ' 7일 30분봉', kind: 'candles', modes: ['raw', 'rollup'], coin: true,
        run: (conn, mode, now, n) => candles(conn, n, now - 7 * DAY, now, 1800, mode),
    },
    top_coins: {
        title: '지난 1시간 코인별 거래대금 TOP 10', kind: 'bars', modes: ['raw', 'rollup'],
        run: (conn, mode, now) => {
            const sql = mode === 'raw'
                ? 'SELECT NAME, SUM(AMT) AS V, COUNT(*) AS N FROM ' + T + ' WHERE ' + since(now - HOUR) + ' GROUP BY NAME ORDER BY V DESC LIMIT 10'
                : 'SELECT M.NAME AS NAME, SUM(R.SUM) AS V, SUM(R.COUNT) AS N FROM _' + T + '_AMT_MIN R, _' + T + '_META M'
                  + ' WHERE R._ID = M._ID AND R.' + since(now - HOUR) + ' GROUP BY M.NAME ORDER BY V DESC LIMIT 10';
            const rows = db.rows(conn, sql);
            const data = rows.map((r) => [r.NAME, Number(r.V), Number(r.N)]);
            let represented = 0; for (const r of data) represented += r[2];
            return { sql: [sql], data: data, represented: represented };
        },
    },
    count: {
        title: '지금 보관 중인 체결 건수', kind: 'number', modes: ['stat', 'count'],
        run: (conn, mode) => {
            const sql = mode === 'stat' ? 'SELECT SUM(ROW_COUNT) AS N FROM V$' + T + '_STAT' : 'SELECT COUNT(*) AS N FROM ' + T;
            const n = Number(db.rows(conn, sql)[0].N);
            return { sql: [sql], data: n };
        },
    },
    last_second: {
        title: (n) => '방금 1초의 ' + label(n) + ' 원본 체결', kind: 'table', modes: ['raw'], coin: true,
        run: (conn, mode, now, n) => {
            const from = Math.floor((now - 3000) / 1000) * 1000;
            const sql = 'SELECT TO_TIMESTAMP(TIME) / 1000000 AS MS, VALUE, QTY, AMT FROM ' + T
                + " WHERE NAME = '" + n + "' AND " + since(from) + ' AND TIME < FROM_TIMESTAMP(' + (from + 1000) + ' * 1000000) ORDER BY TIME';
            const data = db.rows(conn, sql).map((r) => [Math.round(Number(r.MS)), Number(r.VALUE), Number(r.QTY), Number(r.AMT)]);
            return { sql: [sql], data: data };
        },
    },
};

const titleOf = (q, n) => (typeof q.title === 'function' ? q.title(n) : q.title);

/** 고를 수 있는 태그: 체결 테이블에 데이터가 있는 태그(통계 뷰 — 원본을 세지 않아 바로 온다) ∪ 지금 수집 설정. 행 수 많은 순 */
function tagList() {
    const rows = {};
    try {
        db.withConn(function (conn) {
            for (const r of db.rows(conn, 'SELECT NAME, ROW_COUNT FROM V$' + T + '_STAT')) {
                if (markets.isKnown(r.NAME)) rows[r.NAME] = Number(r.ROW_COUNT) || 0;
            }
        });
    } catch (_) {}
    for (const t of CONFIG_TAGS) if (!(t in rows)) rows[t] = 0;
    return Object.keys(rows).sort((a, b) => rows[b] - rows[a] || a.localeCompare(b))
        .map((t) => ({ tag: t, label: label(t), rows: rows[t], collecting: CONFIG_TAGS.indexOf(t) >= 0 }));
}

function run(id) {
    if (id === 'list') {
        const list = {};
        for (const k in QUESTIONS) list[k] = { title: titleOf(QUESTIONS[k], DEFAULT_TAG), modes: QUESTIONS[k].modes, coin: !!QUESTIONS[k].coin };
        return { questions: list, picks: PICKS, defaultTag: DEFAULT_TAG, tags: tagList() };
    }
    const q = QUESTIONS[id];
    if (!q) throw new Error('unknown question: ' + id);
    let mode = cgi.query('mode') || q.modes[0];
    if (q.modes.indexOf(mode) < 0) mode = q.modes[0];
    let name = null;
    if (q.coin) {
        name = cgi.query('name') || DEFAULT_TAG;
        if (!markets.isKnown(name)) throw new Error('unknown name: ' + name);
    }
    const now = Date.now();
    const t0 = Date.now();
    const res = db.withConn((conn) => q.run(conn, mode, now, name));
    const elapsed = Date.now() - t0;
    return Object.assign({ id: id, mode: mode, modes: q.modes, title: titleOf(q, name), kind: q.kind, ms: elapsed, name: name, picks: PICKS }, res);
}

try {
    cgi.ok(run(cgi.query('id')));
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
