'use strict';
/**
 * 모의투자 주문.
 *
 * POST /cgi-bin/api/game
 *   { action: "open",  player, nick, name, side: 1|-1, lev, margin, follow: 0|1 }
 *   { action: "close", player, name }
 * GET  /cgi-bin/api/game?curve=<라운드>&player=<id>
 *   그 라운드 참가자의 자산 곡선 (CC_GAME_EQUITY, 1초 기록을 5초 단위로 모아) — 라운드 결과 화면의 우승자 곡선
 *
 * 체결 가격은 수집기가 1초마다 쓰는 요약판(data/live.json)의 최신 체결가 — 화면에 보인 가격이 아니다.
 * 화면의 가격은 1.5초쯤 늦으므로 "미래 가격을 보고 주문" 하는 꼼수가 안 된다. 요약판이 5초 넘게 안 바뀌었으면
 * (수집기가 멈췄으면) 주문을 받지 않는다.
 *
 * 상태는 CC_GAME_ORDER 에 INSERT 만 한다. 청산·라운드 정산·순위는 수집기의 게임 엔진(src/engine.js)이 한다.
 * 참가자 id 는 브라우저가 만들어 localStorage 에 두는 무작위 문자열이다 — 로그인이 없는 게임이다.
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const markets = require(path.join(ROOT, 'src', 'markets.js'));
const g = require(path.join(ROOT, 'src', 'game.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));
const { loadOrders, insertOrder } = require(path.join(ROOT, 'src', 'engine.js'));

const STALE_MS = 5000;

function livePrice(name, now) {
    const f = path.join(db.DATA_DIR, 'live.json');
    let b = null;
    try { b = JSON.parse(fs.readFileSync(f)); } catch (_) {}
    if (!b || now - b.at > STALE_MS) throw new Error('가격 정보가 멈췄어요. 수집기 상태를 확인하세요.');
    const s = b.symbols[name];
    if (!s || !(s.price > 0)) throw new Error('이 코인은 지금 수집하지 않거나 아직 가격이 없어요.');
    return s.price;
}

function curve() {
    const round = parseInt(cgi.query('curve'), 10);
    const player = cgi.query('player');
    if (!(round > 0) || !/^[a-z0-9]{8,32}$/.test(player)) throw new Error('잘못된 요청');
    // 태그 이름은 검사한 정수·id 로만 만든다
    const tag = 'R' + round + '.' + player;
    const sql = 'SELECT TO_TIMESTAMP(BK) / 1000000 AS MS, V FROM (SELECT DATE_TRUNC(\'second\', TIME, 5) AS BK, AVG(VALUE) AS V'
        + ' FROM ' + schema.EQUITY_TABLE + " WHERE NAME = '" + tag + "' GROUP BY BK) ORDER BY MS";
    const rows = db.withConn((conn) => db.rows(conn, sql)).map((r) => [Math.round(Number(r.MS)), Math.round(Number(r.V) * 100) / 100]);
    cgi.ok({ round: round, player: player, rows: rows });
}

function order() {
    const body = cgi.readBody();
    const player = String(body.player || '');
    if (!/^[a-z0-9]{8,32}$/.test(player)) throw new Error('잘못된 참가자 id');
    const name = String(body.name || '');
    // 지금 수집하는 태그만 (요약판에 가격이 있어야 체결된다 — livePrice 가 다시 확인한다)
    if (!markets.isKnown(name)) throw new Error('모르는 코인: ' + name);
    const now = Date.now();
    const round = g.roundOf(now);

    const out = db.withConn(function (conn) {
        const mine = loadOrders(conn, round).filter((o) => o.player === player);
        const me = g.replay(mine)[player] || null;

        if (body.action === 'open') {
            const nick = cgi.clean(body.nick, 16).trim() || '익명';
            const order = { name: name, side: Number(body.side), lev: Number(body.lev), margin: Math.floor(Number(body.margin) * 100) / 100 };
            const why = g.checkOpen(me, order, now);
            if (why) throw new Error(why);
            const price = livePrice(name, now);
            insertOrder(conn, { at: now, round: round, player: player, nick: nick, name: name, act: 'OPEN',
                side: order.side, lev: order.lev, margin: order.margin, price: price, follow: body.follow ? 1 : 0 });
            return { act: 'OPEN', name: name, price: price, liq: g.liqPrice({ entry: price, side: order.side, lev: order.lev }) };
        }
        if (body.action === 'close') {
            const pos = me && me.positions[name];
            if (!pos) throw new Error('정리할 포지션이 없어요. (이미 청산됐을 수 있어요)');
            const price = livePrice(name, now);
            insertOrder(conn, { at: now, round: round, player: player, nick: me.nick, name: name, act: 'CLOSE', price: price });
            return { act: 'CLOSE', name: name, price: price, pnl: g.pnl(pos, price) };
        }
        throw new Error('unknown action');
    });
    cgi.ok(out);
}

try {
    if (cgi.method() === 'GET') curve();
    else if (cgi.method() === 'POST') order();
    else throw new Error('GET or POST only');
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
