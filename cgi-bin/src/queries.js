'use strict';

/**
 * 캔들 쿼리 — 원본(CC_TICK)과 롤업 두 가지. 차트 API(series.js)와 인사이드 탭의 속도 비교(inside.js)이 같이 쓴다.
 *
 * 캔들 한 칸: [시각 ms, 시가, 고가, 저가, 종가, 체결 수, 매수 대금, 매도 대금]
 *   매수·매도 대금은 AMT(거래대금)·SAMT(순매수 대금)로 낸다: 매수 = (AMT + SAMT) / 2, 매도 = (AMT − SAMT) / 2
 *
 * 원본: DATE_TRUNC 버킷 + FIRST/LAST. 1초 단위까지 되고 원본 1일 안에서만 된다.
 * 롤업: ROLLUP() — 가격·AMT·SAMT 를 쿼리 셋으로 (롤업 쿼리 하나엔 롤업 컬럼 하나, MACHCLI-ERR-2675).
 *   분 롤업을 쓴다 — 1시간 캔들도 분 롤업 60개를 합친다. 시간 롤업은 분 롤업을 다시 모은 것이라 한 시간이 지나야
 *   채워진다. 7일이 넘는 구간만 시간 롤업을 쓴다.
 *
 * JSH 는 DATETIME 을 숫자로 못 꺼낸다 — 버킷 시각을 서브쿼리 바깥에서 TO_TIMESTAMP 로 바꾼다 (같은 쿼리에서
 * GROUP BY 식을 감싸면 MACHCLI-ERR-2044).
 * 인자는 모두 호출하는 쪽이 검사한 값이어야 한다 (name 은 markets.isKnown, 시각·간격은 정수).
 */
const schema = require('./schema.js');

const T = schema.TABLE;
const range = (from, to) => ' AND TIME >= FROM_TIMESTAMP(' + from + ' * 1000000) AND TIME < FROM_TIMESTAMP(' + to + ' * 1000000)';

function trunc(step) {
    if (step < 60) return "DATE_TRUNC('second', TIME, " + step + ')';
    if (step < 3600) return "DATE_TRUNC('minute', TIME, " + (step / 60) + ')';
    if (step < 86400) return "DATE_TRUNC('hour', TIME, " + (step / 3600) + ')';
    return "DATE_TRUNC('day', TIME, 1)";
}

/** 원본 캔들. step 초 단위 */
function rawCandles(name, from, to, step) {
    return 'SELECT TO_TIMESTAMP(BK) / 1000000 AS MS, O, H, L, C, N, A, S FROM ('
        + 'SELECT ' + trunc(step) + ' AS BK, FIRST(TIME, VALUE) AS O, MAX(VALUE) AS H, MIN(VALUE) AS L, LAST(TIME, VALUE) AS C,'
        + ' COUNT(*) AS N, SUM(AMT) AS A, SUM(SAMT) AS S FROM ' + T
        + " WHERE NAME = '" + name + "'" + range(from, to) + ' GROUP BY BK) ORDER BY MS';
}

/** 롤업 단위: 기본 분 롤업, 7일 넘는 구간은 시간 롤업 */
function rollupUnit(step, spanMs) {
    if (spanMs > 7 * 86400000 && step % 3600 === 0) return "'hour', " + (step / 3600);
    return "'min', " + Math.max(1, Math.round(step / 60));
}

/** 롤업 캔들 쿼리 셋: 가격(시가·고가·저가·종가·건수), 거래대금, 순매수 대금 */
function rollupCandles(name, from, to, step) {
    const u = rollupUnit(step, to - from);
    const where = " WHERE NAME = '" + name + "'" + range(from, to) + ' GROUP BY M) ORDER BY MS';
    return {
        price: 'SELECT TO_TIMESTAMP(M) / 1000000 AS MS, O, H, L, C, N FROM (SELECT ROLLUP(' + u + ', TIME) AS M,'
            + ' FIRST(TIME, VALUE) AS O, MAX(VALUE) AS H, MIN(VALUE) AS L, LAST(TIME, VALUE) AS C, COUNT(VALUE) AS N FROM ' + T + where,
        amt: 'SELECT TO_TIMESTAMP(M) / 1000000 AS MS, A FROM (SELECT ROLLUP(' + u + ', TIME) AS M, SUM(AMT) AS A FROM ' + T + where,
        samt: 'SELECT TO_TIMESTAMP(M) / 1000000 AS MS, S FROM (SELECT ROLLUP(' + u + ', TIME) AS M, SUM(SAMT) AS S FROM ' + T + where,
    };
}

/** 원본 결과 행 → 캔들 */
function fromRaw(rows) {
    return rows.map((r) => candle(r.MS, r.O, r.H, r.L, r.C, r.N, r.A, r.S));
}

/** 롤업 결과 셋 → 캔들 (시각으로 맞춘다) */
function fromRollup(price, amt, samt) {
    const a = {}, s = {};
    for (const r of amt) a[Math.round(Number(r.MS))] = Number(r.A);
    for (const r of samt) s[Math.round(Number(r.MS))] = Number(r.S);
    return price.map((r) => {
        const t = Math.round(Number(r.MS));
        return candle(t, r.O, r.H, r.L, r.C, r.N, a[t] || 0, s[t] || 0);
    });
}

function candle(ms, o, h, l, c, n, amt, samt) {
    amt = Number(amt) || 0; samt = Number(samt) || 0;
    return [Math.round(Number(ms)), Number(o), Number(h), Number(l), Number(c), Number(n),
        Math.round((amt + samt) / 2), Math.round((amt - samt) / 2)];
}

module.exports = { rawCandles, rollupCandles, rollupUnit, fromRaw, fromRollup };
