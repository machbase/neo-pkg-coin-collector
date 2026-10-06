'use strict';

/**
 * 바이낸스 웹소켓 정의와 메시지 파서. JSH 전용 모듈을 쓰지 않는다 — Node 로 단위 테스트한다.
 *
 * build(coins) 가 설정(lib/markets.js 형식)으로 연결 목록을 만든다. combined stream 으로
 *   spot     <심볼>@trade, (고른 코인만) <심볼>@depth@100ms
 *   futures  USDⓈ-M 무기한 <심볼>@trade, (고른 코인만) <심볼>@depth@100ms
 * 종류마다 첫 연결에 !miniTicker@arr (그 종류 전 심볼의 24시간 요약, 1초마다) — 고래 기준(24시간 평균 초당 거래대금)과
 * 24시간 등락률에 쓴다 (현물·선물 모두 — 선물 고래도 판정한다).
 * 연결 하나에 스트림 MAX_STREAMS 개까지 — 넘으면 spot-1, spot-2 … 로 나눈다.
 * (바이낸스 한도: 선물 연결당 200 스트림, 현물 1024. 주소가 너무 길어지지 않게 둘 다 200 으로 자른다.)
 *
 * 파서 반환값
 *   체결   { name, time, price, qty, tradeId }       qty 부호: 매수 체결 +, 매도 체결 -
 *   호가   { book: [[name, time, price, qty, side], …] }   side 1 매수호가·-1 매도호가, qty 0 은 그 가격대가 사라짐
 *   요약   { refs: [{ name, open, close, quoteVolume }] }   고른 심볼만, 가격은 현물 단위
 *   그 외  null
 * 선물 1000배 계약(1000PEPEUSDT 등)은 현물 단위로 바꾼다: 가격 ÷ 배수, 수량 × 배수.
 */
const markets = require('./markets.js');

const SPOT_HOST = 'wss://stream.binance.com:9443';
const FUTURES_HOST = 'wss://fstream.binance.com';
const MAX_STREAMS = 200;

function parseTrade(d, known) {
    const k = known[d.s];
    if (!k) return null;
    if (d.X && d.X !== 'MARKET') return null;   // 선물의 보험기금·ADL 체결은 시장 체결이 아니다
    // m: 매수자가 maker 면 시장가 매도가 먹은 체결
    const qty = Number(d.q) * k.mult;
    return { name: k.tag, time: Number(d.T), price: Number(d.p) / k.mult, qty: d.m ? -qty : qty, tradeId: Number(d.t) };
}

function parseDepth(d, known) {
    const k = known[d.s];
    if (!k) return null;
    const time = Number(d.T || d.E);            // 선물은 체결 시각 T, 현물은 이벤트 시각 E 뿐
    const rows = [];
    for (const [p, q] of d.b || []) rows.push([k.tag, time, Number(p) / k.mult, Number(q) * k.mult, 1]);
    for (const [p, q] of d.a || []) rows.push([k.tag, time, Number(p) / k.mult, Number(q) * k.mult, -1]);
    return rows.length ? { book: rows } : null;
}

function parseRefs(arr, known) {
    const refs = [];
    for (const x of arr) {
        const k = known[x.s];
        if (k) refs.push({ name: k.tag, open: Number(x.o) / k.mult, close: Number(x.c) / k.mult, quoteVolume: Number(x.q) });
    }
    return refs.length ? { refs: refs } : null;
}

function parser(known, all) {
    return function (msg) {
        const d = msg && msg.data;
        if (!d) return null;
        if (Array.isArray(d)) return all ? parseRefs(d, all) : null;
        if (d.e === 'trade') return parseTrade(d, known);
        if (d.e === 'depthUpdate') return parseDepth(d, known);
        return null;
    };
}

/** 심볼 목록을 스트림 MAX_STREAMS 개씩 연결로 나눈다. 첫 연결에는 !miniTicker@arr 를 하나 더 */
function chunk(kind, host, items) {
    const out = [];
    const all = {};
    for (const it of items) all[it.symbol] = { tag: it.tag, mult: it.mult || 1 };
    let cur = null;
    for (const it of items) {
        const streams = [it.symbol.toLowerCase() + '@trade'];
        if (it.depth) streams.push(it.symbol.toLowerCase() + '@depth@100ms');
        if (!cur || cur.streams.length + streams.length > MAX_STREAMS) {
            cur = { streams: out.length ? [] : ['!miniTicker@arr'], known: {}, all: out.length ? null : all };
            out.push(cur);
        }
        cur.streams = cur.streams.concat(streams);
        cur.known[it.symbol] = { tag: it.tag, mult: it.mult || 1 };
    }
    return out.map((c, i) => ({
        name: kind + '-' + (i + 1),
        kind: kind,
        url: host + '/stream?streams=' + c.streams.join('/'),
        streams: c.streams.length,
        symbols: Object.keys(c.known).length,
        parse: parser(c.known, c.all),
    }));
}

/** 설정 → 연결 목록 [{ name, kind: spot|futures, url, streams, symbols, parse }] */
function build(coins) {
    const p = markets.plan(coins);
    return chunk('spot', SPOT_HOST, p.spot).concat(chunk('futures', FUTURES_HOST, p.futures));
}

/**
 * 웹소켓 프레임 데이터를 문자열로. JSH 는 바이너리 프레임을 바이트 배열(Go []byte → JS 배열)로,
 * 브라우저·Node 는 ArrayBuffer 로 넘긴다. 바이낸스는 텍스트 프레임이라 보통 문자열이 온다.
 */
function frameText(data) {
    if (typeof data === 'string') return data;
    if (data == null) return '';
    let bytes = data;
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    let out = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, bytes.length);
        const part = [];
        for (let j = i; j < end; j++) part.push(bytes[j]);
        out += String.fromCharCode.apply(null, part);
    }
    return out;
}

module.exports = { build, frameText, MAX_STREAMS };
