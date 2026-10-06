# 개발 노트 — neo-pkg-coin-collector

사용법·설치는 [README](../README.md). 여기는 구조와 machbase-neo(JSH) 실측 메모다.

## 테스트·패키징

```sh
node --test test/*.test.js     # 파서·연결 나누기·설정·요약판·고래 감지·게임 규칙
./pack.sh                      # dist/neo-pkg-coin-collector-<version>.tar.gz (앱스토어용 아카이브)
```

웹소켓·append·서비스·CGI 는 실제 machbase-neo 에서 확인한다. 화면은 실서버를 헤드리스 브라우저로 열지 말 것 — 아래 서버 버그.

## 고래·모의투자

- 고래: `cgi-bin/src/whale.js`. 같은 태그·같은 방향 체결을 1초 합산, 24시간 평균 초당 거래대금(종류마다 첫 연결의
  `!miniTicker@arr`)의 ratio 배 이상이고 minUsd 이상이면 `CC_WHALE` 에 넣는다. 현물·선물 모두 판정한다.
- 실시간 요약판: `cgi-bin/src/board.js` → `data/live.json` (1초). 태그는 수집 설정을 따른다.
- 모의투자: 규칙 `cgi-bin/src/game.js`, 엔진 `cgi-bin/src/engine.js` (수집기 안에서 1초마다 청산 판정·자산 기록·라운드 정산
  → `data/game.json`). 주문 CGI `cgi-bin/api/game.js` 는 `CC_GAME_ORDER` 에 INSERT 만 한다 — 상태는 주문 기록으로 다시 계산.
- 화면 폴링: `cgi-bin/api/live.js` 하나 (요약판·새 고래·게임 상태).

## 서버 버그 (machbase-neo v8.5.13)

**CGI 응답 도중 브라우저가 요청을 끊으면(탭 닫기·새로고침) 서버 프로세스 전체가 죽는다.**
`mods/server/http_public.go` 가 요청 취소 시 바로 return 하는데, CGI 자식 프로세스의 출력을 응답에 복사하는 고루틴은
계속 살아 이미 끝난 HTTP 응답에 쓰다가 nil 참조 → Machbase 엔진 시그널 핸들러가 abort (2026-09-29 실측, 크래시 리포트
`CgiBinWriter.Write → http.(*response).write`).

- 이 패키지는 확률을 낮추려고 화면 폴링을 줄였다 (인사이드 3초에 CGI 하나, 사이드 패널 5초). 막지는 못한다.
- 서버가 죽으면 서비스 프로세스(jsh)들이 고아로 남아 **서버 포트(5656)를 물려받은 채 잡고 있다** — 다시 켜기 전에 종료해야 한다.
- 헤드리스 브라우저로 화면을 검증할 때는 타이머를 끊고 요청이 끝난 뒤 페이지를 닫는다. 가능하면 격리 인스턴스에서 한다.

## 구성

| 경로 | 역할 |
|---|---|
| `service/collector.js` | 수집 서비스(JSH). 바이낸스 웹소켓 → 1초마다 체결 `CC_TICK`·호가 `CC_BOOK` append. 2초마다 설정 파일을 보고 바뀌면 웹소켓을 다시 연다 |
| `lib/graphite.css` | 세 화면 공통 스타일 — neo-web 새 탭(`newBoard/index.scss`)의 Graphite 톤 그대로 (바탕 #252525·위젯 #2c2c2c·색 있는 상태는 #6d8bff 한 톤) |
| `lib/markets.js` | 기본 구성(50개), 설정 형식 검사(`normalize`), 태그 이름 규칙 — 서버와 브라우저가 같이 쓴다 |
| `cgi-bin/src/config.js` | 설정 파일 `cgi-bin/conf.d/markets.json` 읽기·쓰기 |
| `cgi-bin/src/feeds.js` | 설정 → 웹소켓 연결 목록 (연결당 스트림 200개까지), 메시지 파서 |
| `cgi-bin/api/markets.js` | `GET` 설정·수집기 반영 상태, `POST {coins}` 저장, `POST {reset:true}` 기본 구성으로 |
| `cgi-bin/api/series.js` | `GET ?name=&from=&to=&points=&src=auto\|raw\|rollup` — 캔들. 1분 이상이면 롤업 |
| `cgi-bin/api/range.js` | `GET ?name=&from=&to=` — 원본 체결 (최대 30분·30만 건) |
| `cgi-bin/api/stats.js` | `GET` — 태그별 누적 건수 (TAG 통계 뷰) |
| `cgi-bin/api/inside.js`, `theater.js` | 인사이드 탭 상태, 속도 비교 (원본 vs 롤업) |
| `cgi-bin/api/status.js`, `control.js`, `retention.js` | 수집기 상태 + 테이블 행 수(TAG 통계 뷰), 수집 시작·중지·DB 비우기, 보관 기간 |
| `cgi-bin/api/health.js` | 앱스토어 실행 스위치용 서비스 상태 (neo-web `pkgHealth.ts` 형식) |
| `main.html` | **DB 인사이드** — 앱 탭 화면 (neo-web 은 `main.html` 이 있어야 패키지 탭을 연다): 데이터 흐름도, 속도 비교, 저장 구조, 데이터 수명, 실시간 부하 |
| `settings.html` | 수집 종목 설정 (인사이드 상단 메뉴·사이드 패널에서 연다) |
| `side.html` | 사이드 패널: 수집 상태·수집 종목 요약·보관 기간·수집 시작/중지·DB 비우기 |

수집기는 `cgi-bin` 밖에 둔다. `cgi-bin` 안에 두면 HTTP 요청 한 번에 수집기가 하나 더 뜬다.

## DB 비우기

사이드 패널의 "데이터 비우기" 는 `CC_TICK`(+롤업)·`CC_BOOK` 을 DROP 후 다시 만든다 (`cgi-bin/src/clear.js`). HTTP 요청 안에서
지우지 않는다 — 호가 수억 행 DROP 은 수 분이라 그사이 브라우저가 끊으면 서버가 죽는다.

| 요청할 때 수집기 | 누가 지우나 | 끝난 뒤 |
|---|---|---|
| 수집 중 | 수집기가 2초 안에 요청 파일을 가져가 적재를 멈추고 지운다 | 이어서 수집 |
| 멈춤 | 일회성 서비스 `neo-pkg-coin-collector-clear` (`service/clear.js`) — 수집기 서비스는 켜지 않는다 | 스스로 등록 해제. 수집은 멈춘 그대로 |

요청 파일(`data/clear.json`)은 가져가는 쪽이 이름을 바꿔(`clear.running.json`) 두 번 처리되지 않는다.

## 수집 종목 설정

`settings.html` 은 브라우저에서 바이낸스 공개 API(CORS 허용)를 바로 불러 목록을 만든다:

- 현물: `api/v3/ticker/24hr?type=MINI&symbolStatus=TRADING` (약 400KB) 중 `…USDT` — 약 500개, 24시간 거래대금·체결 수
- 선물: `fapi/v1/exchangeInfo` (약 1MB) 의 USDT 무기한·거래 중 — 약 520개, `fapi/v1/ticker/24hr` 로 거래대금·체결 수

코인마다 **현물 체결 / 현물 호가 / 선물 체결 / 선물 호가** 를 따로 켠다. 새로 고른 코인은 있는 시장의 체결만 켜진다 (호가는 양이
많아 직접 켠다). 하단에 스트림 수·웹소켓 수·예상 초당 체결(24시간 체결 수 ÷ 86,400)·호가 어림(현물 코인당 40, 선물 300)을 보여 준다.

선물 `1000PEPEUSDT` 처럼 이름 앞에 10 의 거듭제곱이 붙은 계약은, 현물에 그 이름이 없고 뗀 이름(`PEPE`)이 있으면 같은 코인으로
묶고 배수(`mult`)를 저장한다 — 가격 ÷ 배수, 수량 × 배수로 현물 단위에 맞춘다. 태그는 `BINANCE_F.PEPEUSDT`.

```json
// cgi-bin/conf.d/markets.json
{ "coins": [
  { "coin": "BTC", "spot": true, "spotDepth": true, "futures": true, "futuresDepth": true, "futuresSymbol": "BTCUSDT", "mult": 1 },
  { "coin": "PEPE", "spot": true, "spotDepth": false, "futures": true, "futuresDepth": false, "futuresSymbol": "1000PEPEUSDT", "mult": 1000 }
], "updatedAt": 1791252614610 }
```

- 이름·심볼은 영문 대문자·숫자만 받는다 (`lib/markets.js normalize`) — 태그 이름이 SQL 문자열에 들어간다.
- 저장하면 수집기가 2초 안에 새 목록으로 웹소켓을 다시 연다. 서비스 재시작은 하지 않는다 (stop 은 SIGKILL 이라 버퍼의 1초치를 잃는다).
  화면은 `data/status.json` 의 `markets.appliedAt` 이 저장 시각 뒤로 바뀌면 "반영됨" 을 띄운다.
- 설정에서 뺀 코인의 지난 데이터는 테이블에 남고, API(`series`·`range`)는 태그 모양만 맞으면 조회한다.
- 파일이 깨졌으면 기본 구성으로 돌고 이유를 상태에 남긴다. `conf.d` 는 앱스토어 업데이트에서 유지된다.
- 연결당 스트림 200개 — 바이낸스 선물 한도(연결당 200)에 맞췄다. 현물(1024)도 주소가 길어지지 않게 같이 자른다.
- 인사이드 속도 비교의 캔들·1초 질문은 설정의 첫 번째·두 번째 코인을 쓴다 (선물을 받으면 선물 태그).

## 롤업

체결 원본은 1일만 두고, 분·시 롤업은 지우지 않는다 — 원본이 지워진 구간도 캔들(시·고·저·종·건수·매수/매도 대금)로 볼 수
있다. 매수 대금 = (AMT + SAMT) / 2, 매도 대금 = (AMT − SAMT) / 2 라 롤업 SUM 두 개로 체결강도까지 나온다.


v8.5.13 실측 제약:

- `SUMMARIZED` 컬럼은 테이블에 하나 (`ERR-2251`). 요약 컬럼이 아닌 AMT·SAMT 에도 `CREATE ROLLUP` 은 된다.
- 롤업 쿼리 하나엔 롤업 컬럼 하나 (`ERR-2675`) — 가격·AMT·SAMT 를 세 번 묻는다 (`src/queries.js`).
- `ROLLUP('min', 60)`·`120` 처럼 시간의 배수는 시 롤업으로 가서 그 시간이 끝나기 전엔 비어 있다. 캔들 간격이 7일 넘는 구간의
  시 단위일 때만 `'hour'` 를 쓴다.
- 롤업 쿼리에 `GROUP BY NAME` 을 붙이면 에러 없이 빈 결과, `NAME IN (...)` 은 합쳐진다. 종목별 집계는 롤업 테이블
  (`_CC_TICK_AMT_MIN`)을 태그 메타(`_CC_TICK_META`, `_ID`↔`NAME`)와 조인해 직접 읽는다.
- 롤업은 끝난 분까지만 들어 있다 — 원본보다 최근 1~2분이 빠진다 (인사이드 탭의 "롤업 반영").
- 원본 retention 은 롤업을 지우지 않는다. 초 단위 롤업은 `DELETE … ROLLUP BEFORE` 동작이 일정하지 않아 쓰지 않았다.
- `V$ROLLUP` 의 `LAST_WAKEUP_TIME`·`NEXT_WAKEUP_TIME` 도 DATETIME 이라 `TO_TIMESTAMP()` 로 꺼낸다.

## 화면 색

neo-web 은 패키지 화면을 iframe 으로 띄우고 테마를 넘기지 않아 neo-web 새 탭의 Graphite 값을 `lib/graphite.css` 에 옮겨 적었다.
바탕 #252525, 위젯 #2c2c2c, 아주 옅은 선, 색 있는 상태는 #6d8bff 한 톤 (빨강은 오류에만, 캔들의 상승 빨강·하락 파랑은 시세 관례).
섹션 제목은 카드 밖에 대문자 11.5px, 숫자는 굵기 500. 글꼴 Pretendard·D2Coding.

## JSH 실측 메모 (machbase-neo v8.5.13)

- **서비스 등록은 곧 시작이다.** `enable: true` 로 `service.install` 하면 컨트롤러가 바로 띄운다.
  이어서 `service.start` 를 부르면 "starting" 상태를 막지 않아 수집기가 두 개 뜨고 모든 체결이 두 번 들어간다.
  한쪽은 컨트롤러가 추적을 잃어 uninstall 뒤에도 고아 프로세스로 남는다. install.js 는 새로 등록할 때 start 를 부르지 않는다.
- **서비스 stop 은 SIGKILL 이다.** `process.addShutdownHook` 이 돌지 않는다. 아직 append 안 된 최대 1초치 체결은 잃는다.
- **DATETIME 은 JS Date 로 오지 않는다.** Go 시간 객체라 `getTime()` 이 없고 `Number()` 는 NaN.
  `TO_TIMESTAMP(TIME) / 1000000` 으로 epoch ms 를 받아 쓴다. append 할 때는 JS `Date` 를 넘기면 된다.
- **ws 바이너리 프레임은 JS 배열로 온다** (바이트 값 배열). `frameText()` 가 문자열로 푼다.
- **`/proc/share/db.json` 은 CGI·서비스·pkg run 모두에서 보이고 그 서버 자신을 가리킨다.** 그래서 접속 기본값을
  고정 포트(5656)로 두지 않는다 — 다른 포트로 띄운 서버에 설치하면 같은 머신의 다른 서버에 쓰게 된다.
- **`DATE_TRUNC` 는 초 단위부터 쓴다.** 초 미만(`msec`)은 버킷이 합쳐지지 않는다. 버킷 시각을 epoch ms 로 꺼내려고
  같은 쿼리에서 `TO_TIMESTAMP(DATE_TRUNC(...))` 로 감싸면 `MACHCLI-ERR-2044` — 서브쿼리로 나눈다 (series.js).
- **누적 건수는 `V$CC_TICK_STAT` 로 센다.** `COUNT(*)` 와 값이 같고 원본을 스캔하지 않는다.
  **단, 삭제가 있는 TAG 테이블에서는 `ROW_COUNT` 가 실제와 달라진다** (0.1.3 부하 테스트에서 실측).
- **append 의 DATETIME 은 JS `Date` 만 받는다.** 숫자(나노초)를 넘기면 `unsupported datetime type float64`.
- **retention 정책의 단위는 HOUR·DAY·MONTH.** `MINUTE`·`SECOND` 는 문법 오류. `M$RETENTION` 의 `DURATION`·`INTERVAL`
  은 예약어라 컬럼으로 적으면 문법 오류 — `SELECT *` 로 읽는다.
- **여러 프로세스가 동시에 `CREATE TAG TABLE` 하면 `MACHCLI-ERR-2031 (Resource busy)`.**
- **JSH append 는 프로세스 하나로 약 48만 건/초** (M 시리즈 10코어, 0.1.3 부하 테스트). 4개 합 약 132만. 1건 약 17바이트.
- **TQL·앱스토어의 `/work` 는 서버를 실행한 현재 폴더다** (`--file` 이 아니다). 격리 인스턴스를 띄울 때는
  `--file` 로 준 폴더에서 실행해야 앱스토어가 `public/` 의 압축 파일을 찾는다.
- **TAG 테이블 `DROP … CASCADE` 도중 클라이언트가 끊기면 엔진이 되돌리지 않는다** (2026-10-06 실측). 롤업과 데이터 파티션은
  지워지고 테이블 항목만 남아, 그 뒤로 `DROP`·append·`V$<테이블>_STAT` 모두 `MACHCLI-ERR-2031 Resource busy` — 서버를 다시
  켜도 그대로였다. trace(`machbase_home/trc/machbase.trc`)에 `DDL FAILURE (The session is canceled.)` 가 남는다.
  원인은 CGI 가 `service.start` 를 기다리는 동안 요청이 끊겨(`Interrupted: context canceled`) 막 켜진 수집기가 2초 만에 죽은 것으로
  보인다. 그래서 수집기·일회성 비우기 서비스는 켜진 뒤 5초 동안 DROP 을 하지 않고, 비우는 중에는 수집 중지를 막는다.
