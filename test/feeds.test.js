'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { build, frameText, MAX_STREAMS } = require('../cgi-bin/src/feeds.js');
const markets = require('../cgi-bin/src/markets.js');

// 2026-09-29 실제로 받은 메시지
const TRADE = '{"stream":"btcusdt@trade","data":{"e":"trade","E":1790649901913,"s":"BTCUSDT","t":6720857582,"p":"83034.29000000","q":"0.00062000","T":1790649901913,"m":true,"M":true}}';

const coin = (c, o) => Object.assign({ coin: c, spot: true, spotDepth: false, futures: false, futuresDepth: false, futuresSymbol: '', mult: 1 }, o);
const byName = (list) => Object.fromEntries(list.map((f) => [f.name, f]));

test('기본 구성: 현물 50개 체결·호가, 선물 48개 체결 + BTC·ETH 호가', () => {
    const f = byName(build(markets.DEFAULT_COINS));
    const spotStreams = build(markets.DEFAULT_COINS).filter((x) => x.kind === 'spot').reduce((a, x) => a + x.streams, 0);
    assert.strictEqual(spotStreams, 101);   // 체결 50 + 호가 50 + !miniTicker@arr
    const futures = build(markets.DEFAULT_COINS).filter((x) => x.kind === 'futures');
    assert.strictEqual(futures.reduce((a, x) => a + x.symbols, 0), 48);
    const urls = futures.map((x) => x.url).join('/');
    assert.ok(urls.includes('1000pepeusdt@trade'));
    assert.ok(!urls.includes('tonusdt'));
    assert.deepStrictEqual(urls.match(/[a-z0-9]+@depth@100ms/g), ['btcusdt@depth@100ms', 'ethusdt@depth@100ms']);
    assert.ok(f['spot-1'].url.startsWith('wss://stream.binance.com:9443/stream?streams=!miniTicker@arr/btcusdt@trade/btcusdt@depth@100ms/'));
    assert.ok(f['futures-1'].url.includes('!miniTicker@arr'));
});

test('m=true 는 매도 체결(음수 수량)', () => {
    const [spot] = build([coin('BTC')]);
    const t = spot.parse(JSON.parse(TRADE));
    assert.deepStrictEqual(t, { name: 'BINANCE.BTCUSDT', time: 1790649901913, price: 83034.29, qty: -0.00062, tradeId: 6720857582 });
    assert.strictEqual(spot.parse(JSON.parse(TRADE.replace('"m":true', '"m":false'))).qty, 0.00062);
});

test('목록에 없는 종목 체결·기타 메시지는 무시', () => {
    const [spot] = build([coin('ETH')]);
    assert.strictEqual(spot.parse(JSON.parse(TRADE)), null);
    assert.strictEqual(spot.parse({ result: null, id: 1 }), null);
});

test('고르지 않은 종류는 연결을 만들지 않는다 (현물만 → 선물 연결 없음)', () => {
    const list = build([coin('BTC'), coin('ETH', { spotDepth: true })]);
    assert.deepStrictEqual(list.map((x) => x.name), ['spot-1']);
    assert.strictEqual(list[0].url, 'wss://stream.binance.com:9443/stream?streams=!miniTicker@arr/btcusdt@trade/ethusdt@trade/ethusdt@depth@100ms');
    const fut = build([coin('SOL', { spot: false, futures: true, futuresSymbol: 'SOLUSDT' })]);
    assert.deepStrictEqual(fut.map((x) => x.name), ['futures-1']);
    assert.ok(fut[0].url.startsWith('wss://fstream.binance.com/stream?streams=!miniTicker@arr/solusdt@trade'));
});

test('스트림이 많으면 연결을 나눈다 — 연결당 최대 MAX_STREAMS, 한 코인의 체결·호가는 같은 연결', () => {
    const coins = [];
    for (let i = 0; i < 150; i++) coins.push(coin('C' + i, { spotDepth: true }));   // 300 스트림
    const list = build(coins);
    assert.deepStrictEqual(list.map((x) => x.name), ['spot-1', 'spot-2']);
    for (const f of list) assert.ok(f.streams <= MAX_STREAMS);
    assert.strictEqual(list[0].streams + list[1].streams, 301);   // + 첫 연결의 !miniTicker@arr
    // 두 번째 연결의 파서는 자기 심볼만 안다
    const msg = (s) => ({ data: { e: 'trade', s: s, t: 1, p: '1', q: '1', T: 1, m: false } });
    assert.strictEqual(list[0].parse(msg('C0USDT')).name, 'BINANCE.C0USDT');
    assert.strictEqual(list[0].parse(msg('C149USDT')), null);
    // 24시간 요약은 첫 연결이 받아 그 종류의 고른 심볼 전부를 낸다 — 두 번째 연결의 심볼도
    const refs = list[0].parse({ data: [{ s: 'C149USDT', o: '1', c: '2', q: '300' }, { s: 'ZZZUSDT', o: '1', c: '1', q: '1' }] });
    assert.deepStrictEqual(refs, { refs: [{ name: 'BINANCE.C149USDT', open: 1, close: 2, quoteVolume: 300 }] });
    assert.strictEqual(list[1].parse({ data: [{ s: 'C149USDT', o: '1', c: '2', q: '300' }] }), null);
    assert.strictEqual(list[1].parse(msg('C149USDT')).name, 'BINANCE.C149USDT');
});

test('선물 1000배 계약 체결은 현물 단위로 바꾼다', () => {
    const [f] = build([coin('PEPE', { spot: false, futures: true, futuresSymbol: '1000PEPEUSDT', mult: 1000 })]);
    assert.deepStrictEqual(f.parse({ data: [{ s: '1000PEPEUSDT', o: '0.004', c: '0.005', q: '7' }] }),
        { refs: [{ name: 'BINANCE_F.PEPEUSDT', open: 0.000004, close: 0.000005, quoteVolume: 7 }] });
    const t = f.parse({ stream: '1000pepeusdt@trade', data: { e: 'trade', s: '1000PEPEUSDT', t: 9, p: '0.004200', q: '2000', T: 1790649901913, m: false, X: 'MARKET' } });
    assert.deepStrictEqual(t, { name: 'BINANCE_F.PEPEUSDT', time: 1790649901913, price: 0.0000042, qty: 2000000, tradeId: 9 });
    // 보험기금 체결은 시장 체결이 아니다
    assert.strictEqual(f.parse({ data: { e: 'trade', s: '1000PEPEUSDT', t: 1, p: '1', q: '1', T: 1, m: false, X: 'INSURANCE_FUND' } }), null);
});

test('호가 변화는 가격 단계마다 한 행 (매수 1·매도 -1, 수량 0 은 사라짐)', () => {
    const list = byName(build([coin('BTC', { spotDepth: true }), coin('ETH', { spot: false, futures: true, futuresDepth: true, futuresSymbol: 'ETHUSDT' })]));
    const r = list['spot-1'].parse({ stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', E: 1790649901000, s: 'BTCUSDT', U: 1, u: 2,
        b: [['83000.10', '0.5'], ['82999.00', '0']], a: [['83001.00', '1.25']] } });
    assert.deepStrictEqual(r, { book: [
        ['BINANCE.BTCUSDT', 1790649901000, 83000.1, 0.5, 1],
        ['BINANCE.BTCUSDT', 1790649901000, 82999, 0, 1],
        ['BINANCE.BTCUSDT', 1790649901000, 83001, 1.25, -1],
    ] });
    // 선물은 체결 시각 T 를 쓴다
    const f = list['futures-1'].parse({ data: { e: 'depthUpdate', E: 5, T: 4, s: 'ETHUSDT', b: [['2600', '3']], a: [] } });
    assert.deepStrictEqual(f, { book: [['BINANCE_F.ETHUSDT', 4, 2600, 3, 1]] });
});

test('frameText: 문자열, ArrayBuffer, 바이트 배열(JSH) 모두 같은 문자열', () => {
    const bytes = Array.from(Buffer.from(TRADE));
    assert.strictEqual(frameText(TRADE), TRADE);
    assert.strictEqual(frameText(new Uint8Array(bytes).buffer), TRADE);
    assert.strictEqual(frameText(bytes), TRADE);
    const big = 'x'.repeat(20000);
    assert.strictEqual(frameText(Array.from(Buffer.from(big))), big);
});
