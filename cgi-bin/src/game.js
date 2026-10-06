'use strict';

/**
 * 모의투자 게임 규칙. 주문 CGI(cgi-bin/api/game.js)와 게임 엔진(수집기)이 같이 쓴다.
 * JSH 전용 모듈을 쓰지 않는다 — Node 로 단위 테스트한다.
 *
 * 라운드: 시계 기준 10분 (ROUND_MS). 번호 = floor(epoch ms / ROUND_MS). 모두가 같은 라운드를 한다 —
 *   서버에 게임 루프를 따로 두지 않아도 된다. 라운드마다 START_CASH 로 새로 시작한다.
 * 포지션: 코인마다 하나. 롱(+1)·숏(-1), 레버리지 LEVERAGES, 증거금 margin.
 *   손익 = 방향 × (현재가 ÷ 진입가 − 1) × 레버리지 × 증거금
 *   청산가 = 진입가 × (1 − 방향 ÷ 레버리지)  — 손실이 증거금과 같아지는 가격
 * 주문 기록(CC_GAME_ORDER)만 있으면 누구의 현금·포지션이든 다시 계산된다 (replay). 상태 파일을 따로 두지 않는다 —
 *   CGI 는 요청마다 다른 프로세스라 파일을 같이 쓰면 경합이 생긴다. INSERT 만 하는 LOG 테이블이 안전하다.
 */

const ROUND_MS = 10 * 60000;
const START_CASH = 10000;
const LEVERAGES = [1, 2, 5, 10];
const MIN_MARGIN = 10;
const LOCK_BEFORE_END_MS = 5000;   // 라운드 끝 5초 전부터는 새로 진입할 수 없다

const roundOf = (t) => Math.floor(t / ROUND_MS);
const roundStart = (r) => r * ROUND_MS;
const roundEnd = (r) => (r + 1) * ROUND_MS;

function pnl(pos, price) {
    return pos.side * (price / pos.entry - 1) * pos.lev * pos.margin;
}

function liqPrice(pos) {
    return pos.entry * (1 - pos.side / pos.lev);
}

/** 가격 구간 [lo, hi] 에서 청산가를 건드렸나 — 1초 사이에 찍고 돌아와도 청산이다 */
function touchedLiq(pos, lo, hi) {
    const liq = liqPrice(pos);
    return pos.side > 0 ? lo <= liq : hi >= liq;
}

/**
 * 한 라운드의 주문 기록 → 참가자별 상태. 주문은 시각순이어야 한다.
 * order: { at, player, nick, name, act: 'OPEN'|'CLOSE'|'END'|'LIQ', side, lev, margin, price, follow }
 */
function replay(orders) {
    const players = {};
    for (const o of orders) {
        const p = players[o.player] = players[o.player]
            || { id: o.player, nick: o.nick, cash: START_CASH, realized: 0, positions: {}, trades: 0, liquidations: 0, follows: 0 };
        if (o.nick) p.nick = o.nick;
        if (o.act === 'OPEN') {
            p.cash -= o.margin;
            p.positions[o.name] = { name: o.name, side: o.side, lev: o.lev, margin: o.margin, entry: o.price, openAt: o.at, follow: !!o.follow };
            p.trades++;
            if (o.follow) p.follows++;
        } else if (o.act === 'CLOSE' || o.act === 'END' || o.act === 'LIQ') {   // END = 라운드 끝 정리
            const pos = p.positions[o.name];
            if (!pos) continue;
            // 돌려받는 돈은 센트 단위로 — 부동소수점 찌꺼기가 현금에 쌓이지 않게
            const got = o.act === 'LIQ' ? 0 : Math.round(Math.max(0, pos.margin + pnl(pos, o.price)) * 100) / 100;
            p.cash += got;
            p.realized += got - pos.margin;
            if (o.act === 'LIQ') p.liquidations++;
            delete p.positions[o.name];
        }
    }
    return players;
}

/** 자산 = 현금 + 포지션마다 (증거금 + 손익, 0 아래로는 안 내려감) */
function equity(player, prices) {
    let e = player.cash;
    for (const name in player.positions) {
        const pos = player.positions[name];
        const px = prices[name];
        e += Math.max(0, pos.margin + (px ? pnl(pos, px) : 0));
    }
    return e;
}

/** 진입 주문 검사. 문제가 없으면 null, 있으면 사람이 읽을 이유 */
function checkOpen(player, order, now) {
    const r = roundOf(now);
    if (roundEnd(r) - now < LOCK_BEFORE_END_MS) return '라운드가 곧 끝나요. 다음 라운드에 진입하세요.';
    if (LEVERAGES.indexOf(order.lev) < 0) return '레버리지는 ' + LEVERAGES.join('·') + '배만 돼요.';
    if (order.side !== 1 && order.side !== -1) return '롱 또는 숏을 고르세요.';
    if (!(order.margin >= MIN_MARGIN)) return '최소 $' + MIN_MARGIN + ' 부터 진입할 수 있어요.';
    const cash = player ? player.cash : START_CASH;
    if (order.margin > cash + 1e-9) return '현금이 모자라요. (가진 현금 $' + cash.toFixed(2) + ')';
    if (player && player.positions[order.name]) return '이미 이 코인 포지션이 있어요. 먼저 정리하세요.';
    return null;
}

/** 순위표. 자산 내림차순 */
function ranking(players, prices) {
    return Object.keys(players).map((id) => {
        const p = players[id];
        const eq = equity(p, prices);
        return { id: id, nick: p.nick, equity: eq, returnPct: (eq / START_CASH - 1) * 100,
            open: Object.keys(p.positions).length, trades: p.trades, liquidations: p.liquidations, follows: p.follows };
    }).sort((a, b) => b.equity - a.equity);
}

module.exports = {
    ROUND_MS, START_CASH, LEVERAGES, MIN_MARGIN, LOCK_BEFORE_END_MS,
    roundOf, roundStart, roundEnd, pnl, liqPrice, touchedLiq, replay, equity, checkOpen, ranking,
};
