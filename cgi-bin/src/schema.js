'use strict';
/**
 * 테이블 정의. install.js 와 수집기 시작 시 ensure() 로 만든다.
 * 컬럼명에 Machbase 예약어(MODE, CHAR, SESSION, STAGE, DURATION, INTERVAL …)를 쓰지 않는다 (MACHCLI-ERR-2010).
 *
 * 체결 1건 = CC_TICK 1행 (TAG 테이블. 컬럼을 더할 수 없다: MACHCLI-ERR-2088 "Only the LOG table can be altered")
 *   NAME     거래소.종목   BINANCE.BTCUSDT, BINANCE_F.BTCUSDT (목록은 설정 화면 — lib/markets.js, src/config.js)
 *   VALUE    체결가 (USDT) — SUMMARIZED. TAG 테이블은 SUMMARIZED 컬럼을 하나만 둘 수 있다 (MACHCLI-ERR-2251)
 *   QTY      체결량       매수 체결 +, 매도 체결 -
 *   AMT      거래대금 = 체결가 × |체결량| (USDT)
 *   SAMT     순매수 대금 = 체결가 × 체결량 (매수 +, 매도 −). AMT 와 합치면 매수·매도 대금이 나온다:
 *            매수 = (AMT + SAMT) / 2, 매도 = (AMT − SAMT) / 2
 *   TRADE_ID 바이낸스 체결 ID
 *
 * 롤업 (미리 계산해 두는 분·시 요약). 원본은 1일만 두고 롤업은 계속 둔다 — 원본을 지워도 롤업은 안 지워진다.
 *   가격   WITH ROLLUP (MIN) EXTENSION → _CC_TICK_ROLLUP_MIN·HOUR: 시가(FIRST)·고가·저가·종가(LAST)·체결 수
 *   AMT    _CC_TICK_AMT_MIN → _CC_TICK_AMT_HOUR     SAMT  _CC_TICK_SAMT_MIN → _CC_TICK_SAMT_HOUR
 *   초 단위 롤업은 두지 않는다: 태그 98개 기준 × 86,400초면 체인마다 하루 850만 행인데, 롤업만 기간을 정해 지우는
 *   DELETE … ROLLUP BEFORE 가 기준 이후 구간까지 지워 믿을 수 없었다 (v8.5.13 실측). 분 단위면 하루 약 14만 행.
 *   롤업 쿼리 하나에는 롤업 컬럼을 하나만 쓸 수 있다 (MACHCLI-ERR-2675) — 가격·AMT·SAMT 를 따로 묻는다.
 *
 * 호가 변화 1건 = CC_BOOK 1행 (TAG 테이블). 설정에서 호가를 고른 코인의 depth@100ms 를 가격 단계마다.
 *   NAME     CC_TICK 과 같은 태그 이름 (BINANCE.BTCUSDT, BINANCE_F.BTCUSDT)
 *   VALUE    호가 가격, QTY 그 가격의 새 잔량 (0 이면 사라짐), SIDE 1 매수호가·-1 매도호가
 *   코인 하나에 초당 약 40행(현물)~1,500행(BTC·ETH 선물) — retention 으로 기본 1일만 둔다 (retention.js)
 *
 * 고래 1건 = CC_WHALE 1행 (LOG 테이블). 수집기가 감지해 넣는다 (whale.js).
 *   WHALE_AT 1초 구간 시작 · SIDE 1 매수 -1 매도 · AMOUNT_USD 구간 합계 · RATIO 24시간 평균 초당 거래대금의 몇 배
 *   LOG 테이블은 UPDATE 가 안 된다. "고래 뒤 가격" 은 조회할 때 CC_TICK 에서 구한다.
 *
 * 모의투자 (game.js · engine.js)
 *   CC_GAME_ORDER  (LOG) 주문 기록. ACT = OPEN·CLOSE·LIQ(청산)·END(라운드 끝 정리). 이것만으로 상태를 다시 계산한다
 *   CC_GAME_EQUITY (TAG) 참가자 자산 1초 기록. NAME = R<라운드>.<참가자> — 우승자 자산 곡선
 *   CC_GAME_RESULT (LOG) 라운드 결과
 *
 * 테이블 이름은 모두 CC_ 로 시작한다 — 같은 서버의 다른 테이블과 섞이지 않고, "DB 비우기" 는 CC_TICK·CC_BOOK 만 지운다.
 */
const TABLE = 'CC_TICK';
const BOOK_TABLE = 'CC_BOOK';
const WHALE_TABLE = 'CC_WHALE';
const ORDER_TABLE = 'CC_GAME_ORDER';
const EQUITY_TABLE = 'CC_GAME_EQUITY';
const RESULT_TABLE = 'CC_GAME_RESULT';

const DDL = [
    [TABLE,
     'CREATE TAG TABLE ' + TABLE + ' ('
     + ' NAME VARCHAR(40) PRIMARY KEY,'
     + ' TIME DATETIME BASETIME,'
     + ' VALUE DOUBLE SUMMARIZED,'
     + ' QTY DOUBLE,'
     + ' AMT DOUBLE,'
     + ' SAMT DOUBLE,'
     + ' TRADE_ID LONG)'
     + ' WITH ROLLUP (MIN) EXTENSION'],
    [BOOK_TABLE,
     'CREATE TAG TABLE ' + BOOK_TABLE + ' ('
     + ' NAME VARCHAR(40) PRIMARY KEY,'
     + ' TIME DATETIME BASETIME,'
     + ' VALUE DOUBLE SUMMARIZED,'
     + ' QTY DOUBLE,'
     + ' SIDE INTEGER)'],
    [WHALE_TABLE,
     'CREATE TABLE ' + WHALE_TABLE + ' ('
     + ' WHALE_AT DATETIME, NAME VARCHAR(40), SIDE INTEGER, AMOUNT_USD DOUBLE, RATIO DOUBLE,'
     + ' QTY DOUBLE, TRADE_CNT INTEGER, FIRST_PRICE DOUBLE, LAST_PRICE DOUBLE)'],
    [ORDER_TABLE,
     'CREATE TABLE ' + ORDER_TABLE + ' ('
     + ' AT DATETIME, ROUND_NO LONG, PLAYER VARCHAR(32), NICK VARCHAR(24), NAME VARCHAR(40), ACT VARCHAR(8),'
     + ' SIDE INTEGER, LEV INTEGER, MARGIN DOUBLE, PRICE DOUBLE, FOLLOW INTEGER)'],
    [EQUITY_TABLE,
     'CREATE TAG TABLE ' + EQUITY_TABLE + ' ('
     + ' NAME VARCHAR(48) PRIMARY KEY,'
     + ' TIME DATETIME BASETIME,'
     + ' VALUE DOUBLE SUMMARIZED)'],
    [RESULT_TABLE,
     'CREATE TABLE ' + RESULT_TABLE + ' ('
     + ' AT DATETIME, ROUND_NO LONG, PLAYER VARCHAR(32), NICK VARCHAR(24), EQUITY DOUBLE, RANK_NO INTEGER,'
     + ' TRADES INTEGER, LIQS INTEGER, FOLLOWS INTEGER)'],
];

/** 사용자 정의 롤업 (가격 롤업은 테이블과 함께 생긴다). [이름, 생성문] — 만든 순서대로, 지울 땐 거꾸로 */
const ROLLUPS = [
    ['_' + TABLE + '_AMT_MIN', 'CREATE ROLLUP _' + TABLE + '_AMT_MIN ON ' + TABLE + '(AMT) INTERVAL 1 MIN'],
    ['_' + TABLE + '_AMT_HOUR', 'CREATE ROLLUP _' + TABLE + '_AMT_HOUR ON _' + TABLE + '_AMT_MIN INTERVAL 1 HOUR'],
    ['_' + TABLE + '_SAMT_MIN', 'CREATE ROLLUP _' + TABLE + '_SAMT_MIN ON ' + TABLE + '(SAMT) INTERVAL 1 MIN'],
    ['_' + TABLE + '_SAMT_HOUR', 'CREATE ROLLUP _' + TABLE + '_SAMT_HOUR ON _' + TABLE + '_SAMT_MIN INTERVAL 1 HOUR'],
];
/** 화면·API 가 이름으로 부르는 롤업 테이블 전부 */
const ROLLUP_TABLES = ['_' + TABLE + '_ROLLUP_MIN', '_' + TABLE + '_ROLLUP_HOUR'].concat(ROLLUPS.map((r) => r[0]));

function exists(conn, name) {
    let found = false;
    try { for (const _ of conn.query('SELECT NAME FROM M$SYS_TABLES WHERE NAME = ?', name)) found = true; } catch (_) {}
    return found;
}

function ensure(conn) {
    const out = { created: [], existed: [], failed: [], altered: [] };
    for (let i = 0; i < DDL.length; i++) {
        const name = DDL[i][0];
        if (exists(conn, name)) { out.existed.push(name); continue; }
        try { conn.exec(DDL[i][1]); out.created.push(name); }
        catch (e) { out.failed.push(name + ': ' + (e && e.message ? e.message : String(e))); }
    }
    if (exists(conn, TABLE)) {
        for (const [name, ddl] of ROLLUPS) {
            if (exists(conn, name)) continue;
            try { conn.exec(ddl); out.created.push(name); }
            catch (e) { out.failed.push(name + ': ' + (e && e.message ? e.message : String(e))); }
        }
    }
    return out;
}

module.exports = { TABLE, ROLLUPS, ROLLUP_TABLES, BOOK_TABLE, WHALE_TABLE, ORDER_TABLE, EQUITY_TABLE, RESULT_TABLE, DDL, ensure };
