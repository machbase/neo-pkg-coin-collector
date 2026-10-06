'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { WhaleDetector } = require('../cgi-bin/src/whale.js');

const T0 = 1790650000000;   // 초 경계
const DAY = 86400;

// 평균 초당 거래대금이 10 인 종목: 24시간 거래대금 864,000
function detector(rule) {
    const d = new WhaleDetector(Object.assign({ ratio: 10, minUsd: 50 }, rule || {}));
    d.setDaily('BINANCE.XUSDT', 10 * DAY);
    return d;
}

test('평균의 N배 이상 몰리면 구간이 닫힐 때 한 번 알린다', () => {
    const d = detector();
    assert.deepStrictEqual(d.feed({ name: 'BINANCE.XUSDT', time: T0 + 10, price: 10, qty: 6 }), []);
    assert.deepStrictEqual(d.feed({ name: 'BINANCE.XUSDT', time: T0 + 900, price: 11, qty: 5 }), []);
    const out = d.feed({ name: 'BINANCE.XUSDT', time: T0 + 1000, price: 11, qty: 1 });   // 다음 초 → 앞 구간 닫힘
    assert.deepStrictEqual(out, [{
        time: T0, name: 'BINANCE.XUSDT', side: 1, usd: 115, ratio: 11.5, qty: 11, count: 2,
        firstPrice: 10, lastPrice: 11,
    }]);
});

test('배수가 모자라면 버린다', () => {
    const d = detector();
    d.feed({ name: 'BINANCE.XUSDT', time: T0, price: 9, qty: 10 });            // 90 = 9배
    assert.deepStrictEqual(d.sweep(T0 + 10000), []);
});

test('배수가 커도 최소 금액보다 작으면 버린다 — 작은 코인의 잔 체결 몰림', () => {
    const d = new WhaleDetector({ ratio: 10, minUsd: 1000 });
    d.setDaily('BINANCE.XUSDT', 1 * DAY);                                        // 평균 1/초
    d.feed({ name: 'BINANCE.XUSDT', time: T0, price: 1, qty: 500 });            // 500배지만 500 < 1000
    assert.deepStrictEqual(d.sweep(T0 + 10000), []);
});

test('매수·매도는 따로 합산한다', () => {
    const d = detector();
    d.feed({ name: 'BINANCE.XUSDT', time: T0, price: 10, qty: 6 });
    d.feed({ name: 'BINANCE.XUSDT', time: T0 + 1, price: 10, qty: -6 });
    assert.deepStrictEqual(d.sweep(T0 + 10000), []);                            // 각각 60 = 6배
});

test('24시간 거래대금을 모르는 종목은 판정하지 않는다', () => {
    const d = new WhaleDetector({ ratio: 1, minUsd: 1 });
    d.feed({ name: 'BINANCE.YUSDT', time: T0, price: 100, qty: 100 });
    assert.deepStrictEqual(d.sweep(T0 + 10000), []);
});

test('체결이 끊기면 sweep 이 유예 시간 뒤에 닫는다', () => {
    const d = detector();
    d.feed({ name: 'BINANCE.XUSDT', time: T0, price: 100, qty: -2 });
    assert.deepStrictEqual(d.sweep(T0 + 2999), []);          // 1초 창 + 2초 유예 전
    const out = d.sweep(T0 + 3000);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].side, -1);
    assert.strictEqual(out[0].usd, 200);
    assert.strictEqual(out[0].ratio, 20);
    assert.deepStrictEqual(d.sweep(T0 + 9000), []);          // 한 번만
});
