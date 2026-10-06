'use strict';
/**
 * GET /cgi-bin/api/whales?since=<epoch ms>&limit=50
 * GET /cgi-bin/api/whales?from=<ms>&to=<ms>&name=BINANCE.BTCUSDT   (차트·되감기용 구간 조회)
 *
 * 수집기가 감지해 CC_WHALE 에 넣은 고래를 최신순으로 돌려준다.
 * since 가 없으면 최근 limit 건. 그리드는 처음에 목록을 받고, 이후엔 since 로 새 것만 받는다.
 */
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));
const markets = require(path.join(ROOT, 'src', 'markets.js'));

try {
    let limit = parseInt(cgi.query('limit') || '50', 10);
    if (!(limit > 0) || limit > 500) limit = 50;
    const since = parseInt(cgi.query('since') || '0', 10);
    const from = parseInt(cgi.query('from') || '0', 10);
    const to = parseInt(cgi.query('to') || '0', 10);
    const name = cgi.query('name');
    if (name && !markets.isKnown(name)) throw new Error('unknown name: ' + name);

    // since·from·to·limit 은 정수로 파싱한 값이고 name 은 태그 모양(markets.isKnown)을 확인했다 — 문자열 결합해도 안전하다.
    // WHALE_AT 은 JSH 에서 숫자로 못 꺼내 SQL 에서 epoch ms 로 바꿔 받는다.
    const where = [];
    if (since > 0) where.push('WHALE_AT > FROM_TIMESTAMP(' + since + ' * 1000000)');
    if (from > 0) where.push('WHALE_AT >= FROM_TIMESTAMP(' + from + ' * 1000000)');
    if (to > 0) where.push('WHALE_AT < FROM_TIMESTAMP(' + to + ' * 1000000)');
    if (name) where.push("NAME = '" + name + "'");
    const sql = 'SELECT TO_TIMESTAMP(WHALE_AT) / 1000000 AS MS, NAME, SIDE, AMOUNT_USD, RATIO, QTY, TRADE_CNT,'
        + ' FIRST_PRICE, LAST_PRICE FROM ' + schema.WHALE_TABLE
        + (where.length ? ' WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY WHALE_AT DESC LIMIT ' + limit;

    const rows = db.withConn((conn) => db.rows(conn, sql)).map((r) => ({
        time: Math.round(Number(r.MS)),
        name: r.NAME,
        side: Number(r.SIDE),
        usd: Number(r.AMOUNT_USD),
        ratio: Number(r.RATIO),
        qty: Number(r.QTY),
        count: Number(r.TRADE_CNT),
        firstPrice: Number(r.FIRST_PRICE),
        lastPrice: Number(r.LAST_PRICE),
    }));
    cgi.ok(rows);
} catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.indexOf('does not exist') >= 0) cgi.ok([]);
    else cgi.fail(msg);
}
