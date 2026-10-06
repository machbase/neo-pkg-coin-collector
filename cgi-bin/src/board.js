'use strict';

/**
 * 실시간 요약판. 수집기가 체결마다 feed() 하고 1초마다 snapshot() 을 data/live.json 에 쓴다.
 * 고래·모의투자 화면은 이 파일을 CGI 한 번으로 받는다 (live API) — 원본 체결을 화면마다 따로 읽지 않는다.
 *
 * 종목은 수집 설정을 따른다 (setTags — 설정이 바뀌면 수집기가 다시 부른다). 태그마다
 *   price, time       마지막 체결
 *   chg24             24시간 등락률 (%) — 바이낸스 miniTicker 의 24시간 전 시가 기준
 *   chg1m             최근 1분 등락률 (%) — 1분 전 첫 체결가 기준
 *   usd1m, count1m    최근 1분 거래대금(USDT)·체결 수
 *   strength          체결강도 = 매수 체결량 ÷ 매도 체결량 × 100 (최근 1분). 100 보다 크면 사는 쪽이 세다
 *   quoteVolume       24시간 거래대금 (miniTicker)
 * tape: 단건 TAPE_MIN_USD 이상 큰 체결 최근 TAPE_SIZE 건 [태그, 시각, 가격, 수량(부호=방향), 금액]
 *
 * JSH 전용 모듈을 쓰지 않는다 — Node 로 단위 테스트한다.
 */

const WINDOW_SEC = 60;
const TAPE_MIN_USD = 10000;
const TAPE_SIZE = 100;

class LiveBoard {
    constructor(tags) {
        this.sym = {};
        this.tape = [];
        this.setTags(tags || []);
    }

    /** 요약할 태그. 빠진 태그는 지우고 새 태그는 빈 상태로 */
    setTags(tags) {
        const keep = {};
        for (const t of tags) keep[t] = this.sym[t] || { price: null, time: 0, open: null, quoteVolume: null, secs: [] };
        this.sym = keep;
        this.tape = this.tape.filter((r) => keep[r[0]]);
    }

    setRef(ref) {
        const s = this.sym[ref.name];
        if (!s) return;
        s.open = ref.open;
        s.quoteVolume = ref.quoteVolume;
        if (s.price == null) s.price = ref.close;
    }

    feed(t) {
        const s = this.sym[t.name];
        if (!s) return;
        const qty = Math.abs(t.qty), usd = t.price * qty, buy = t.qty > 0;
        s.price = t.price;
        s.time = t.time;
        const sec = Math.floor(t.time / 1000);
        const lastB = s.secs.length ? s.secs[s.secs.length - 1] : null;
        let b;
        if (lastB && lastB.sec === sec) b = lastB;
        else if (lastB && sec < lastB.sec) b = s.secs.find((x) => x.sec === sec) || lastB;   // 늦게 온 체결 (드물다)
        else {
            b = { sec: sec, count: 0, buyQty: 0, sellQty: 0, buyUsd: 0, sellUsd: 0, first: t.price };
            s.secs.push(b);
        }
        b.count++;
        if (buy) { b.buyQty += qty; b.buyUsd += usd; } else { b.sellQty += qty; b.sellUsd += usd; }
        if (usd >= TAPE_MIN_USD) {
            this.tape.push([t.name, t.time, t.price, t.qty, Math.round(usd)]);
            if (this.tape.length > TAPE_SIZE) this.tape.splice(0, this.tape.length - TAPE_SIZE);
        }
    }

    snapshot(now) {
        const cutoff = Math.floor(now / 1000) - WINDOW_SEC;
        const symbols = {};
        for (const name in this.sym) {
            const s = this.sym[name];
            while (s.secs.length && s.secs[0].sec <= cutoff) s.secs.shift();
            let count = 0, buyQty = 0, sellQty = 0, buyUsd = 0, sellUsd = 0;
            for (const b of s.secs) { count += b.count; buyQty += b.buyQty; sellQty += b.sellQty; buyUsd += b.buyUsd; sellUsd += b.sellUsd; }
            const first = s.secs.length ? s.secs[0].first : null;
            symbols[name] = {
                price: s.price,
                time: s.time,
                chg24: s.open && s.price != null ? round2((s.price / s.open - 1) * 100) : null,
                chg1m: first && s.price != null ? round2((s.price / first - 1) * 100) : null,
                usd1m: Math.round(buyUsd + sellUsd),
                count1m: count,
                strength: sellQty > 0 ? Math.round(buyQty / sellQty * 100) : null,   // 매도가 없으면 정의되지 않는다
                quoteVolume: s.quoteVolume,
            };
        }
        return { at: now, symbols: symbols, tape: this.tape.slice() };
    }
}

function round2(v) { return Math.round(v * 100) / 100; }

module.exports = { LiveBoard, WINDOW_SEC, TAPE_MIN_USD };
