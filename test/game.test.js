'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../cgi-bin/src/game.js');

const R = 2984417;                       // 아무 라운드
const T = g.roundStart(R) + 60000;       // 라운드 시작 1분 뒤
const BTC = 'BINANCE.BTCUSDT', DOGE = 'BINANCE.DOGEUSDT';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' ≠ ' + b);

test('롱 손익·청산가', () => {
    const pos = { side: 1, lev: 10, margin: 100, entry: 100 };
    near(g.pnl(pos, 101), 10);                 // 1% × 10배 × 100
    assert.ok(Math.abs(g.liqPrice(pos) - 90) < 1e-9);        // 10% 하락이면 증거금 전부
    assert.strictEqual(g.touchedLiq(pos, 90.5, 101), false);
    assert.strictEqual(g.touchedLiq(pos, 89.9, 101), true);  // 찍고 돌아와도 청산
});

test('숏 손익·청산가', () => {
    const pos = { side: -1, lev: 5, margin: 200, entry: 50 };
    near(g.pnl(pos, 45), 100);                 // 10% 하락 × 5배 × 200
    assert.ok(Math.abs(g.liqPrice(pos) - 60) < 1e-9);        // 20% 상승이면 청산
    assert.strictEqual(g.touchedLiq(pos, 40, 59.9), false);
    assert.strictEqual(g.touchedLiq(pos, 40, 60), true);
});

test('주문 기록을 다시 돌리면 현금·포지션·실현손익이 나온다', () => {
    const players = g.replay([
        { at: T, player: 'a', nick: '가', name: BTC, act: 'OPEN', side: 1, lev: 10, margin: 1000, price: 100 },
        { at: T + 1, player: 'a', name: DOGE, act: 'OPEN', side: -1, lev: 2, margin: 500, price: 0.1, follow: 1 },
        { at: T + 2, player: 'a', name: BTC, act: 'CLOSE', price: 102 },          // +20% → +200
        { at: T + 3, player: 'b', nick: '나', name: BTC, act: 'OPEN', side: 1, lev: 10, margin: 3000, price: 100 },
        { at: T + 4, player: 'b', name: BTC, act: 'LIQ', price: 90 },             // 청산 → 증거금 전부
    ]);
    near(players.a.cash, 10000 - 1000 - 500 + 1200);
    near(players.a.realized, 200);
    assert.deepStrictEqual(Object.keys(players.a.positions), [DOGE]);
    assert.strictEqual(players.a.follows, 1);
    assert.strictEqual(players.b.cash, 7000);
    assert.strictEqual(players.b.liquidations, 1);
    assert.strictEqual(players.b.nick, '나');
});

test('자산은 현금 + 포지션 평가액, 순위는 자산순', () => {
    const players = g.replay([
        { at: T, player: 'a', nick: '가', name: BTC, act: 'OPEN', side: 1, lev: 2, margin: 1000, price: 100 },
        { at: T, player: 'b', nick: '나', name: BTC, act: 'OPEN', side: -1, lev: 2, margin: 1000, price: 100 },
    ]);
    const prices = { [BTC]: 110 };
    near(g.equity(players.a, prices), 9000 + 1200);
    near(g.equity(players.b, prices), 9000 + 800);
    const r = g.ranking(players, prices);
    assert.deepStrictEqual(r.map((x) => x.id), ['a', 'b']);
    assert.ok(Math.abs(r[0].returnPct - 2) < 1e-9);
});

test('진입 검사', () => {
    const players = g.replay([{ at: T, player: 'a', name: BTC, act: 'OPEN', side: 1, lev: 1, margin: 9000, price: 1 }]);
    const ok = { name: DOGE, side: 1, lev: 5, margin: 500 };
    assert.strictEqual(g.checkOpen(players.a, ok, T), null);
    assert.match(g.checkOpen(players.a, { ...ok, margin: 2000 }, T), /현금이 모자라요/);
    assert.match(g.checkOpen(players.a, { ...ok, name: BTC }, T), /이미 이 코인/);
    assert.match(g.checkOpen(players.a, { ...ok, lev: 3 }, T), /레버리지/);
    assert.match(g.checkOpen(players.a, { ...ok, margin: 5 }, T), /최소/);
    assert.match(g.checkOpen(null, ok, g.roundEnd(R) - 1000), /곧 끝나요/);
    assert.strictEqual(g.checkOpen(null, ok, T), null);                        // 처음 들어온 사람
});

test('라운드는 시계 기준 10분', () => {
    assert.strictEqual(g.roundOf(g.roundStart(R)), R);
    assert.strictEqual(g.roundOf(g.roundEnd(R) - 1), R);
    assert.strictEqual(g.roundOf(g.roundEnd(R)), R + 1);
});

test('라운드 끝 정리(END)는 정리(CLOSE)와 같이 돈을 돌려준다', () => {
    const players = g.replay([
        { at: T, player: 'a', nick: '가', name: BTC, act: 'OPEN', side: -1, lev: 5, margin: 1000, price: 100 },
        { at: T + 1, player: 'a', name: BTC, act: 'END', price: 98 },            // 2% 하락 × 5배 → +100
    ]);
    near(players.a.cash, 10100);
    assert.deepStrictEqual(players.a.positions, {});
});
