'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const markets = require('../lib/markets.js');
const config = require('../cgi-bin/src/config.js');

test('기본 구성: 50개, 중복 없음, normalize 를 그대로 통과', () => {
    assert.strictEqual(markets.DEFAULT_COINS.length, 50);
    assert.deepStrictEqual(markets.normalize(markets.DEFAULT_COINS), markets.DEFAULT_COINS);
    const s = markets.summary(markets.DEFAULT_COINS);
    assert.deepStrictEqual(s, { coins: 50, spot: 50, spotDepth: 50, futures: 48, futuresDepth: 2, streams: 150 });
    const pepe = markets.DEFAULT_COINS.find((c) => c.coin === 'PEPE');
    assert.strictEqual(pepe.futuresSymbol, '1000PEPEUSDT');
    assert.strictEqual(pepe.mult, 1000);
});

test('normalize: 대문자로, 꺼진 시장의 호가·심볼은 지우고, 받을 게 없는 코인은 뺀다', () => {
    const out = markets.normalize([
        { coin: 'btc', spot: true, spotDepth: true, futures: false, futuresDepth: true, futuresSymbol: 'BTCUSDT', mult: 1 },
        { coin: 'ETH', spot: false, spotDepth: true, futures: true, futuresSymbol: 'ethusdt' },
        { coin: 'XRP', spot: false, futures: false },
    ]);
    assert.deepStrictEqual(out, [
        { coin: 'BTC', spot: true, spotDepth: true, futures: false, futuresDepth: false, futuresSymbol: '', mult: 1 },
        { coin: 'ETH', spot: false, spotDepth: false, futures: true, futuresDepth: false, futuresSymbol: 'ETHUSDT', mult: 1 },
    ]);
});

test('normalize: SQL 에 들어갈 수 있는 이상한 이름·중복·잘못된 배수는 거절', () => {
    assert.throws(() => markets.normalize([{ coin: "BTC'; DROP", spot: true }]), /bad coin name/);
    assert.throws(() => markets.normalize([{ coin: 'BTC', spot: true }, { coin: 'btc', spot: true }]), /duplicate/);
    assert.throws(() => markets.normalize([{ coin: 'BTC', futures: true, futuresSymbol: 'BTC/USDT' }]), /bad futures symbol/);
    assert.throws(() => markets.normalize([{ coin: 'BTC', futures: true, futuresSymbol: 'BTCUSDT', mult: 0.5 }]), /bad multiplier/);
    assert.throws(() => markets.normalize({}), /array/);
});

test('isKnown: 태그 모양만 받는다 (설정에서 뺀 코인도 조회 가능)', () => {
    assert.ok(markets.isKnown('BINANCE.BTCUSDT'));
    assert.ok(markets.isKnown('BINANCE_F.ZZZUSDT'));
    assert.ok(!markets.isKnown("BINANCE.BTCUSDT' OR '1'='1"));
    assert.ok(!markets.isKnown('CC_TICK'));
});

test('config: 파일이 없으면 기본, 저장·다시 읽기, 깨진 파일은 기본으로 돌고 이유를 남긴다, reset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-collector-'));
    const file = path.join(dir, 'conf.d', 'markets.json');
    assert.strictEqual(config.load(file).source, 'default');
    assert.strictEqual(config.version(file), 'default');

    const saved = config.save([{ coin: 'sol', spot: true }], file);
    assert.deepStrictEqual(saved.coins.map((c) => c.coin), ['SOL']);
    const loaded = config.load(file);
    assert.strictEqual(loaded.source, 'file');
    assert.deepStrictEqual(loaded.coins, saved.coins);
    assert.notStrictEqual(config.version(file), 'default');
    assert.ok(!fs.existsSync(file + '.tmp'));

    assert.throws(() => config.save([], file), /하나 이상/);
    fs.writeFileSync(file, '{ broken');
    const bad = config.load(file);
    assert.strictEqual(bad.source, 'default');
    assert.match(bad.error, /markets.json ignored/);

    assert.strictEqual(config.reset(file).source, 'default');
    assert.ok(!fs.existsSync(file));
    fs.rmSync(dir, { recursive: true });
});
