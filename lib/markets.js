/**
 * 수집 종목 — 서버(JSH·Node)와 브라우저가 같이 쓰는 한 곳.
 *   서버: cgi-bin/src/markets.js 가 require 한다
 *   브라우저: <script src="lib/markets.js"> → window.COIN_MARKETS
 * cgi-bin 아래에 두면 브라우저가 받을 때 CGI 로 실행돼 버려 lib/ 에 둔다.
 *
 * 무엇을 받을지는 설정 화면(settings.html)이 정해 cgi-bin/conf.d/markets.json 에 저장한다 (cgi-bin/src/config.js).
 * 설정이 없으면 DEFAULT_COINS — 거래대금 상위로 고른 50개 구성.
 *
 * 코인 하나 = { coin, spot, spotDepth, futures, futuresDepth, futuresSymbol, mult }
 *   coin           태그 이름에 쓰는 코인 이름 (BTC, PEPE …)
 *   spot           현물 <coin>USDT 체결을 받나          spotDepth     현물 호가 변화(depth@100ms)도 받나
 *   futures        USDⓈ-M 무기한 체결을 받나            futuresDepth  선물 호가 변화도 받나
 *   futuresSymbol  선물 심볼 (1000PEPEUSDT 처럼 현물과 다를 수 있다)
 *   mult           선물 1계약의 코인 수 (1000PEPE → 1000). 현물 단위로 맞추려고 가격 ÷ mult, 수량 × mult
 */
(function (root) {
'use strict';

/*
 * 기본 구성: 바이낸스 USDT 마켓 24시간 거래대금 순위(2026-09-29)로 고른 50개.
 * 현물은 체결·호가 모두, 선물은 체결만(TON·NFP 는 선물 없음), 선물 호가는 BTC·ETH 만 — 합계 하루 평균 초당 약 5,000 행.
 */
const DEFAULT_LIST = ['BTC', 'ETH', 'SOL', 'XRP', 'LINK', 'BNB', 'XLM', 'ADA', 'LTC', 'TRX',
    'NEAR', 'HBAR', 'SUI', 'AVAX', 'ALGO', 'SEI', 'ICP', 'INJ', 'APT', 'TON',
    'UNI', 'ONDO', 'ENA', 'HYPE', 'AAVE', 'CRV', 'JUP', 'LDO', 'PENDLE', 'DYDX',
    'WLD', 'TAO', 'FET', 'VIRTUAL', 'RENDER', 'GRT', 'ARKM', 'IO', 'NFP', 'AIXBT',
    'DOGE', 'PUMP', 'PEPE', 'MUBARAK', 'TRUMP', 'PENGU', 'SHIB', 'BONK', 'WIF', 'FLOKI'];
const DEFAULT_MULT = { PEPE: 1000, SHIB: 1000, BONK: 1000, FLOKI: 1000 };
const DEFAULT_NO_FUTURES = ['TON', 'NFP'];
const DEFAULT_FUTURES_DEPTH = ['BTC', 'ETH'];

const DEFAULT_COINS = DEFAULT_LIST.map(function (c) {
    const fut = DEFAULT_NO_FUTURES.indexOf(c) < 0;
    const mult = DEFAULT_MULT[c] || 1;
    return {
        coin: c, spot: true, spotDepth: true,
        futures: fut, futuresDepth: fut && DEFAULT_FUTURES_DEPTH.indexOf(c) >= 0,
        futuresSymbol: fut ? (mult > 1 ? mult : '') + c + 'USDT' : '', mult: mult,
    };
});

/** 한 번에 고를 수 있는 코인 수. 선물 USDT 무기한·현물 USDT 를 합쳐도 이 안에 든다 */
const MAX_COINS = 800;

/** 태그 이름: 현물 BINANCE.<코인>USDT, 선물 BINANCE_F.<코인>USDT (체결 CC_TICK·호가 CC_BOOK 둘 다 같은 이름) */
const tagOf = (coin) => 'BINANCE.' + coin + 'USDT';
const futuresTagOf = (coin) => 'BINANCE_F.' + coin + 'USDT';
const coinOf = (name) => String(name).replace(/^BINANCE(_F)?\./, '').replace(/USDT$/, '');

const COIN_RE = /^[A-Z0-9]{1,24}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,32}USDT$/;
const TAG_RE = /^BINANCE(_F)?\.[A-Z0-9]{1,24}USDT$/;

/**
 * API 가 받아도 되는 태그 이름인가 — SQL 에 문자열로 붙이기 전에 반드시 거친다.
 * 설정에서 뺀 코인도 테이블엔 남아 있으므로 지금 목록이 아니라 이름 모양으로 확인한다 (따옴표·공백이 들어갈 수 없다).
 */
function isKnown(name) {
    return TAG_RE.test(String(name));
}

/**
 * 설정 한 벌을 검사해 정리한다. 잘못된 항목이 있으면 던진다 — 반쯤 맞는 설정을 조용히 저장하지 않는다.
 * 받을 것이 하나도 없는 코인은 뺀다.
 */
function normalize(list) {
    if (!Array.isArray(list)) throw new Error('coins must be an array');
    const out = [];
    const seen = {};
    for (const x of list) {
        const coin = String((x && x.coin) || '').toUpperCase();
        if (!COIN_RE.test(coin)) throw new Error('bad coin name: ' + coin);
        if (seen[coin]) throw new Error('duplicate coin: ' + coin);
        seen[coin] = true;
        const spot = !!x.spot;
        const futures = !!x.futures && !!x.futuresSymbol;
        const c = {
            coin: coin, spot: spot, spotDepth: spot && !!x.spotDepth,
            futures: futures, futuresDepth: futures && !!x.futuresDepth,
            futuresSymbol: futures ? String(x.futuresSymbol).toUpperCase() : '',
            mult: futures ? Number(x.mult) || 1 : 1,
        };
        if (futures && !SYMBOL_RE.test(c.futuresSymbol)) throw new Error('bad futures symbol: ' + c.futuresSymbol);
        if (!(c.mult >= 1 && c.mult <= 1e9 && Math.round(c.mult) === c.mult)) throw new Error('bad multiplier for ' + coin + ': ' + x.mult);
        if (!spot && !futures) continue;
        out.push(c);
    }
    if (out.length > MAX_COINS) throw new Error('too many coins: ' + out.length + ' (max ' + MAX_COINS + ')');
    return out;
}

/** 설정 → 받을 심볼 목록. spot: [{ symbol, tag, depth }], futures: [{ symbol, tag, mult, depth }] */
function plan(coins) {
    const spot = [], futures = [];
    for (const c of coins) {
        if (c.spot) spot.push({ symbol: c.coin + 'USDT', tag: tagOf(c.coin), depth: !!c.spotDepth });
        if (c.futures) futures.push({ symbol: c.futuresSymbol, tag: futuresTagOf(c.coin), mult: c.mult || 1, depth: !!c.futuresDepth });
    }
    return { spot: spot, futures: futures };
}

/** 화면 요약용 개수 */
function summary(coins) {
    const s = { coins: coins.length, spot: 0, spotDepth: 0, futures: 0, futuresDepth: 0 };
    for (const c of coins) {
        if (c.spot) s.spot++;
        if (c.spotDepth) s.spotDepth++;
        if (c.futures) s.futures++;
        if (c.futuresDepth) s.futuresDepth++;
    }
    s.streams = s.spot + s.spotDepth + s.futures + s.futuresDepth;
    return s;
}

const api = { DEFAULT_COINS, MAX_COINS, tagOf, futuresTagOf, coinOf, isKnown, normalize, plan, summary };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.COIN_MARKETS = api;
})(typeof window !== 'undefined' ? window : this);
