'use strict';

/**
 * 모의투자 게임 엔진. 수집기(service/collector.js) 안에서 돈다 — 모든 체결을 실시간으로 보는 곳이 여기라서.
 *
 * 1초마다 tick():
 *   1) 이번 라운드 주문(CC_GAME_ORDER)을 읽어 참가자 상태를 다시 계산 (game.replay)
 *   2) 포지션마다 진입 이후 최저·최고가로 청산 판정 → 청산이면 LIQ 주문을 넣는다.
 *      최저·최고가는 onTrade() 가 체결마다 갱신한다. 처음 보는 포지션은 진입 시각부터 DB 에서 한 번 구해 시작한다
 *      (주문이 들어온 뒤 엔진이 보기까지 최대 1초 사이의 체결도 놓치지 않게).
 *   3) 참가자 자산을 CC_GAME_EQUITY 에 1행씩
 *   4) 순위·포지션·최근 이벤트를 data/game.json 으로 (화면은 live API 로 받는다)
 * 라운드가 바뀌면 settle(): 남은 포지션을 마지막 가격으로 정리(END), 결과를 CC_GAME_RESULT 에.
 *
 * 주문 CGI 와 엔진은 CC_GAME_ORDER 로만 이어진다. 상태 파일을 같이 쓰지 않는다 (프로세스가 달라 경합이 난다).
 */
const g = require('./game.js');
const schema = require('./schema.js');

const EVENT_KEEP = 40;

function rowsOf(conn, sql, args) {
    const it = args && args.length ? conn.query.apply(conn, [sql].concat(args)) : conn.query(sql);
    const out = [];
    for (const r of it) out.push(r);
    return out;
}

function loadOrders(conn, round) {
    // 시각은 JSH 에서 숫자로 꺼내려고 epoch ms 로 바꾼다. round 는 정수라 결합해도 안전하다.
    return rowsOf(conn, 'SELECT TO_TIMESTAMP(AT) / 1000000 AS MS, PLAYER, NICK, NAME, ACT, SIDE, LEV, MARGIN, PRICE, FOLLOW'
        + ' FROM ' + schema.ORDER_TABLE + ' WHERE ROUND_NO = ' + Number(round) + ' ORDER BY AT').map((r) => ({
        at: Math.round(Number(r.MS)), player: r.PLAYER, nick: r.NICK, name: r.NAME, act: r.ACT,
        side: Number(r.SIDE), lev: Number(r.LEV), margin: Number(r.MARGIN), price: Number(r.PRICE), follow: Number(r.FOLLOW) || 0,
    }));
}

function insertOrder(conn, o) {
    conn.exec('INSERT INTO ' + schema.ORDER_TABLE
        + ' (AT, ROUND_NO, PLAYER, NICK, NAME, ACT, SIDE, LEV, MARGIN, PRICE, FOLLOW) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        new Date(o.at), o.round, o.player, o.nick || '', o.name, o.act, o.side || 0, o.lev || 0, o.margin || 0, o.price, o.follow || 0);
}

class GameEngine {
    constructor(log) {
        this.log = log || function () {};
        this.round = null;
        this.ext = {};          // 포지션 키 → { lo, hi }  진입 이후 최저·최고가
        this.byCoin = {};       // 코인 → [포지션 키]
        this.events = [];
        this.last = null;       // 직전 라운드 결과
        this.snapshot = null;
    }

    /** 체결마다 — 열린 포지션들의 최저·최고가 갱신 */
    onTrade(t) {
        const keys = this.byCoin[t.name];
        if (!keys) return;
        for (const k of keys) {
            const e = this.ext[k];
            if (!e) continue;
            if (t.price < e.lo) e.lo = t.price;
            if (t.price > e.hi) e.hi = t.price;
        }
    }

    event(e) {
        this.events.unshift(e);
        if (this.events.length > EVENT_KEEP) this.events.length = EVENT_KEEP;
    }

    tick(conn, prices, now) {
        const r = g.roundOf(now);
        if (this.round !== null && r !== this.round) this.settle(conn, this.round, prices, now);
        // 막 켜졌을 때: 라운드가 바뀌는 순간 수집기가 꺼져 있었다면 직전 라운드가 정산되지 않고 남아 있다
        if (this.round === null && !this.hasResult(conn, r - 1) && loadOrders(conn, r - 1).length) this.settle(conn, r - 1, prices, now);
        this.round = r;

        let orders = loadOrders(conn, r);
        let players = g.replay(orders);

        // 청산 판정
        const liveKeys = {}, byCoin = {};
        let liquidated = false;
        for (const id in players) {
            const p = players[id];
            for (const name in p.positions) {
                const pos = p.positions[name];
                const key = id + '|' + name + '|' + pos.openAt;
                liveKeys[key] = true;
                (byCoin[name] = byCoin[name] || []).push(key);
                if (!this.ext[key]) this.ext[key] = this.initExt(conn, pos);
                const e = this.ext[key];
                if (g.touchedLiq(pos, e.lo, e.hi)) {
                    const liq = g.liqPrice(pos);
                    insertOrder(conn, { at: now, round: r, player: id, nick: p.nick, name: name, act: 'LIQ', price: liq });
                    this.event({ at: now, type: 'LIQ', nick: p.nick, name: name, side: pos.side, lev: pos.lev, margin: pos.margin });
                    this.log('info', 'game liquidation', { player: id, name: name, lev: pos.lev, margin: pos.margin });
                    liquidated = true;
                }
            }
        }
        for (const k in this.ext) if (!liveKeys[k]) delete this.ext[k];
        this.byCoin = byCoin;
        if (liquidated) { orders = loadOrders(conn, r); players = g.replay(orders); }

        // 새로 들어온 진입·정리 주문을 이벤트로 (지난 tick 이후 것만)
        const since = this.lastTick || now - 1500;
        for (const o of orders) {
            if (o.at <= since || o.at > now || o.act === 'LIQ') continue;
            if (o.act === 'OPEN') this.event({ at: o.at, type: 'OPEN', nick: o.nick, name: o.name, side: o.side, lev: o.lev, margin: o.margin, follow: !!o.follow });
        }
        this.lastTick = now;

        // 자산 기록·순위
        const rank = g.ranking(players, prices);
        for (const x of rank) {
            conn.exec('INSERT INTO ' + schema.EQUITY_TABLE + ' (NAME, TIME, VALUE) VALUES (?, ?, ?)',
                'R' + r + '.' + x.id, new Date(now), Math.round(x.equity * 100) / 100);
        }
        this.snapshot = {
            round: r, startsAt: g.roundStart(r), endsAt: g.roundEnd(r), now: now,
            startCash: g.START_CASH, leverages: g.LEVERAGES, lockBeforeEndMs: g.LOCK_BEFORE_END_MS,
            players: rank.map((x) => {
                const p = players[x.id];
                return Object.assign(x, {
                    cash: Math.round(p.cash * 100) / 100,
                    positions: Object.keys(p.positions).map((name) => {
                        const pos = p.positions[name];
                        const px = prices[name];
                        return { name: name, side: pos.side, lev: pos.lev, margin: pos.margin, entry: pos.entry,
                            openAt: pos.openAt, follow: pos.follow, liq: g.liqPrice(pos), pnl: px ? g.pnl(pos, px) : 0 };
                    }),
                });
            }),
            events: this.events,
            last: this.last,
        };
        return this.snapshot;
    }

    initExt(conn, pos) {
        let lo = pos.entry, hi = pos.entry;
        try {
            const r = rowsOf(conn, 'SELECT MIN(VALUE) AS LO, MAX(VALUE) AS HI FROM ' + schema.TABLE
                + ' WHERE NAME = ? AND TIME >= FROM_TIMESTAMP(' + Math.floor(pos.openAt) + ' * 1000000)', [pos.name])[0];
            if (r && r.LO != null) { lo = Math.min(lo, Number(r.LO)); hi = Math.max(hi, Number(r.HI)); }
        } catch (_) {}
        return { lo: lo, hi: hi };
    }

    hasResult(conn, round) {
        return rowsOf(conn, 'SELECT COUNT(*) AS N FROM ' + schema.RESULT_TABLE + ' WHERE ROUND_NO = ' + Number(round))
            .some((x) => Number(x.N) > 0);
    }

    /** 라운드 끝: 남은 포지션을 마지막 가격으로 정리하고 결과를 남긴다 */
    settle(conn, round, prices, now) {
        const at = Math.min(now, g.roundEnd(round) - 1);
        let players = g.replay(loadOrders(conn, round));
        for (const id in players) {
            for (const name in players[id].positions) {
                const px = prices[name] || players[id].positions[name].entry;
                insertOrder(conn, { at: at, round: round, player: id, nick: players[id].nick, name: name, act: 'END', price: px });
            }
        }
        players = g.replay(loadOrders(conn, round));
        const rank = g.ranking(players, prices);
        if (!rank.length) { this.last = null; return; }
        rank.forEach((x, i) => {
            conn.exec('INSERT INTO ' + schema.RESULT_TABLE
                + ' (AT, ROUND_NO, PLAYER, NICK, EQUITY, RANK_NO, TRADES, LIQS, FOLLOWS) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                new Date(at), round, x.id, x.nick || '', Math.round(x.equity * 100) / 100, i + 1, x.trades, x.liquidations, x.follows);
        });
        const avg = (xs) => xs.length ? xs.reduce((a, x) => a + x.returnPct, 0) / xs.length : null;
        const followers = rank.filter((x) => x.follows > 0), others = rank.filter((x) => x.follows === 0 && x.trades > 0);
        this.last = {
            round: round, endedAt: g.roundEnd(round),
            podium: rank.slice(0, 3).map((x) => ({ id: x.id, nick: x.nick, equity: x.equity, returnPct: x.returnPct })),
            players: rank.length,
            liquidations: rank.reduce((a, x) => a + x.liquidations, 0),
            followers: { count: followers.length, avgReturnPct: avg(followers) },
            others: { count: others.length, avgReturnPct: avg(others) },
        };
        this.event({ at: now, type: 'END', round: round, winner: rank[0].nick, returnPct: rank[0].returnPct });
        this.log('info', 'game round settled', { round: round, players: rank.length, winner: rank[0].nick });
    }
}

module.exports = { GameEngine, loadOrders, insertOrder };
