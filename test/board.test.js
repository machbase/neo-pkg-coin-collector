'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LiveBoard, TAPE_MIN_USD } = require('../cgi-bin/src/board.js');

const T0 = 1790649900000;
const trade = (name, sec, price, qty) => ({ name, time: T0 + sec * 1000, price, qty, tradeId: sec });

test('설정한 태그만 요약하고, 1분 거래대금·체결강도·등락률을 낸다', () => {
    const b = new LiveBoard(['BINANCE.BTCUSDT', 'BINANCE_F.ETHUSDT']);
    b.feed(trade('BINANCE.BTCUSDT', 0, 100, 2));     // 매수 2
    b.feed(trade('BINANCE.BTCUSDT', 10, 110, -1));   // 매도 1
    b.feed(trade('BINANCE.XRPUSDT', 10, 1, 5));      // 설정에 없음 — 무시
    const s = b.snapshot(T0 + 20000);
    assert.deepStrictEqual(Object.keys(s.symbols).sort(), ['BINANCE.BTCUSDT', 'BINANCE_F.ETHUSDT']);
    const btc = s.symbols['BINANCE.BTCUSDT'];
    assert.strictEqual(btc.price, 110);
    assert.strictEqual(btc.usd1m, 310);
    assert.strictEqual(btc.count1m, 2);
    assert.strictEqual(btc.strength, 200);
    assert.strictEqual(btc.chg1m, 10);
    assert.strictEqual(s.symbols['BINANCE_F.ETHUSDT'].price, null);
});

test('1분이 지난 체결은 빠지고, 24시간 요약으로 등락률·첫 가격을 채운다', () => {
    const b = new LiveBoard(['BINANCE.BTCUSDT']);
    b.setRef({ name: 'BINANCE.BTCUSDT', open: 100, close: 105, quoteVolume: 1e9 });
    assert.strictEqual(b.snapshot(T0).symbols['BINANCE.BTCUSDT'].price, 105);
    b.feed(trade('BINANCE.BTCUSDT', 0, 110, 1));
    const s = b.snapshot(T0 + 120000).symbols['BINANCE.BTCUSDT'];
    assert.strictEqual(s.count1m, 0);
    assert.strictEqual(s.chg24, 10);
    assert.strictEqual(s.quoteVolume, 1e9);
});

test('큰 체결 목록, 설정에서 뺀 태그는 상태와 목록에서 지운다', () => {
    const b = new LiveBoard(['BINANCE.BTCUSDT', 'BINANCE.ETHUSDT']);
    b.feed(trade('BINANCE.BTCUSDT', 0, TAPE_MIN_USD, 1));
    b.feed(trade('BINANCE.ETHUSDT', 0, TAPE_MIN_USD, -2));
    b.feed(trade('BINANCE.ETHUSDT', 1, 1, 1));       // 작은 체결 — 목록에 안 남는다
    assert.strictEqual(b.snapshot(T0 + 2000).tape.length, 2);
    b.setTags(['BINANCE.BTCUSDT', 'BINANCE.SOLUSDT']);
    const s = b.snapshot(T0 + 2000);
    assert.deepStrictEqual(Object.keys(s.symbols).sort(), ['BINANCE.BTCUSDT', 'BINANCE.SOLUSDT']);
    assert.strictEqual(s.symbols['BINANCE.BTCUSDT'].price, TAPE_MIN_USD);   // 남은 태그는 상태 유지
    assert.deepStrictEqual(s.tape.map((r) => r[0]), ['BINANCE.BTCUSDT']);
});
