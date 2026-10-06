'use strict';

/**
 * 고래 감지. 수집기가 체결마다 feed() 로 넘기고, 끝난 구간 중 기준을 넘은 것만 돌려받는다.
 *
 * 기준: 같은 종목·같은 방향 체결을 1초(체결 시각 기준) 동안 합산한 금액(USDT)이
 *   - 그 종목의 "24시간 평균 초당 거래대금" 의 RATIO 배 이상이고
 *   - MIN_USD 이상일 때.
 * 고정 금액 하나로는 BTC 에서만 걸리고 작은 코인은 절대 안 걸린다. 배수로 보면 50개 종목이 공정해지고,
 * 최소 금액이 작은 코인의 잔 체결 몰림을 거른다.
 *
 * 24시간 거래대금은 !miniTicker@arr 로 1초마다 들어온다 (setDaily). 그 전에 들어온 체결은 판정하지 않는다.
 *
 * 큰 주문은 잘게 쪼개져 체결되므로 단건 금액으로는 놓친다 — 0.0001 BTC 체결 217건이 1초에 몰린 실측이 있다.
 * 구간은 다음 초의 체결이 오거나(feed), 체결 시각 기준 GRACE_MS 가 지나면(sweep) 닫힌다.
 *
 * JSH 전용 모듈을 쓰지 않는다 — Node 로 단위 테스트한다.
 */

const DEFAULTS = { ratio: 30, minUsd: 50000 };
const WINDOW_MS = 1000;
const GRACE_MS = 2000;     // 거래소 시각이 로컬 시계보다 1초 남짓 앞서는 것을 실측했다 — 여유를 둔다

class WhaleDetector {
    constructor(options) {
        this.rule = Object.assign({}, DEFAULTS, options || {});
        this.buckets = {};       // name|side → 진행 중인 구간
        this.perSec = {};        // name → 24시간 평균 초당 거래대금 (USDT)
    }

    /** 24시간 거래대금(USDT) → 평균 초당 거래대금 */
    setDaily(name, quoteVolume24h) {
        if (quoteVolume24h > 0) this.perSec[name] = quoteVolume24h / 86400;
    }

    /** 체결 1건. t = { name, time, price, qty(부호 = 방향) }. 닫힌 고래 이벤트 배열을 돌려준다. */
    feed(t) {
        if (!(t.qty) || !(t.price > 0)) return [];
        const side = t.qty > 0 ? 1 : -1;
        const qty = Math.abs(t.qty);
        const key = t.name + '|' + side;
        const start = Math.floor(t.time / WINDOW_MS) * WINDOW_MS;
        const out = [];
        let b = this.buckets[key];
        if (b && b.start !== start) {
            if (start < b.start) return [];   // 이미 닫은 구간보다 앞선 체결 — 무시 (거의 없다)
            this._close(key, out);
            b = null;
        }
        if (!b) {
            b = this.buckets[key] = {
                name: t.name, side: side, start: start,
                usd: 0, qty: 0, count: 0, firstPrice: t.price, lastPrice: t.price,
            };
        }
        b.usd += t.price * qty;
        b.qty += qty;
        b.count++;
        b.lastPrice = t.price;
        return out;
    }

    /** 체결이 끊겨도 구간이 닫히도록 주기적으로 부른다. now 는 로컬 시각(ms). */
    sweep(now) {
        const out = [];
        for (const key of Object.keys(this.buckets)) {
            if (this.buckets[key].start + WINDOW_MS + GRACE_MS <= now) this._close(key, out);
        }
        return out;
    }

    _close(key, out) {
        const b = this.buckets[key];
        delete this.buckets[key];
        const base = this.perSec[b.name];
        if (!(base > 0) || b.usd < this.rule.minUsd) return;
        const ratio = b.usd / base;
        if (ratio < this.rule.ratio) return;
        out.push({
            time: b.start,
            name: b.name,
            side: b.side,
            usd: Math.round(b.usd),
            ratio: Math.round(ratio * 10) / 10,
            qty: b.qty,
            count: b.count,
            firstPrice: b.firstPrice,
            lastPrice: b.lastPrice,
        });
    }
}

module.exports = { WhaleDetector, DEFAULTS, WINDOW_MS, GRACE_MS };
