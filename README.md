# Coin Collector (neo-pkg-coin-collector)

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

A machbase-neo package that **collects real-time spot and futures trades and order-book updates for selected coins on Binance USDT markets and stores them in Machbase**.

- Trades are also stored as minute and hour **rollups** (open, high, low, close, and trading volume), so you can quickly view long-range candlestick charts even after raw data is deleted.
- The same trade data powers **whale detection**: unusually large bursts of buying or selling within one second are recorded and trigger alerts.
- A **paper trading** game lets players compete using actual trade prices.
- The **DB Inside** view shows how data is stored and compares raw-data and rollup query performance.

After installation, the collector immediately starts collecting the top 50 coins by trading volume. You can change the selection at any time in the UI.

![DB Inside — collector status and controls in the side panel on the left, the package tab on the right](docs/images/db-inside.png)

## Requirements

- machbase-neo 8.7.0 or later
- The server must be able to connect to Binance (`stream.binance.com`, `fstream.binance.com`).
- The browser used for collection settings must also be able to access the Binance public APIs (`api.binance.com`, `fapi.binance.com`) to load the coin list.
- Disk space: the default 50-coin configuration generates approximately 17 GB per day. A raw-data retention period of one day (the default) is recommended.

## Installation

1. Download a ZIP file from this repository using **Code → Download ZIP**, or download a ZIP from **Releases**.
2. Place the downloaded ZIP **without extracting it** in the `public/` directory under your machbase-neo installation directory.

   ```text
   <machbase-neo installation directory>/
   ├── machbase-neo
   └── public/
       └── neo-pkg-coin-collector-main.zip   ← place it here
   ```

3. Open the **App Store** in the machbase-neo web UI, refresh the list, and click **Install** for `neo-pkg-coin-collector`.
4. The collection service starts as soon as installation finishes. Use the switch on the App Store card to turn it on or off.

### Updating

Place the new ZIP in `public/` and click **Update** in the App Store. Settings such as selected coins and retention periods, along with collected data, are preserved.
Installation fails if `public/` contains two ZIP files with the same package name and version, so remove the old ZIP.

### Uninstalling

Click **Uninstall** in the App Store to stop the collection service and remove its registration. **Collected tables remain**. If you no longer need them,
drop them manually, for example with `DROP TABLE CC_TICK CASCADE` (see [Stored data](#stored-data) for the table list).

## Views

Use the menu at the top of the package tab to switch between four views. The right sidebar shows collection status and controls.

### DB Inside (default view)

- **Data flow** — current records per second flowing from Binance → collector → tables → rollups.
- **Raw data vs. rollup performance** — run the same query (for example, 5-minute candles over 24 hours) using raw-data aggregation and rollups, and compare elapsed time, rows read, and SQL side by side.
  Choose a coin before running the comparison. Raw-data queries can take tens of seconds, so they run only when you click the button.
- **Storage structure** — row counts for each table and rollup, plus ingestion trends over the past hour.
- **Data lifecycle** — see raw data expire after its retention period while rollups remain.
- **Real-time load** — ingestion rate, table row counts, rollup lag, and query latency.

### Whales

- Trades for the same coin and direction are aggregated over one second. A whale event is recorded when the total is **at least 30 times the 24-hour average trading volume per second and at least $50K**.
  The collector records events even when the view is closed.
- New whale events trigger notifications. Sound alerts are optional.
- Click a chart marker or an event to zoom into one-second intervals from one minute before to two minutes after the event.
- The view also lists individual large trades of $10K or more.

### Paper trading

- Everyone plays in shared 10-minute rounds (:00, :10, …). Each round starts with $10,000; just choose a nickname, with no login required.
- Choose a coin being collected, go long or short, and select 1×, 2×, 5×, or 10× leverage. **Execution prices are actual Binance trade prices received by the collector**.
- Positions are liquidated when losses reach the margin, even if the price only briefly touches the liquidation level before recovering.
- When a whale appears, use the **Follow** button to fill in an order in the same direction.
- At the end of each round, the view shows the podium, the winner's equity curve, and average returns for players who followed whales and those who did not.

### Collection settings

- Binance USDT markets (approximately 500 spot and 520 futures markets) are listed by trading volume. Search for coins or use "Add top N by trading volume".
- Enable **spot trades / spot order book / futures trades / futures order book** separately for each coin. Estimated load (trades and order-book updates per second) appears below.
- Click **Save and apply** to start collecting the new selection within two seconds, without restarting. Previously collected data for removed coins remains.
- **Restore defaults** — restore the initial 50-coin configuration.

### Sidebar

- Collection status, incoming records per second, and table row counts, with **Start / Stop collection** buttons.
- **Raw-data retention** — 1 day, 7 days, 30 days, or forever. The sidebar also estimates daily storage growth at the current rate. Rollups remain regardless of the retention period.
- **Clear data** — delete raw trades, raw order-book data, and their rollups, then recreate empty tables. Collection resumes if it was running;
  if it was stopped, it stays stopped. Clearing hundreds of millions of order-book rows can take several minutes.

## Stored data

| Table | Type | Contents |
|---|---|---|
| `CC_TICK` | TAG | Raw trades. `VALUE`: trade price; `QTY`: quantity (buy +, sell −); `AMT`: trading volume; `SAMT`: net buy volume; `TRADE_ID` |
| `_CC_TICK_ROLLUP_MIN` · `_HOUR` | Rollup | Minute and hour price summaries (open, high, low, close, count) |
| `_CC_TICK_AMT_MIN` · `_HOUR` | Rollup | Minute and hour trading-volume totals |
| `_CC_TICK_SAMT_MIN` · `_HOUR` | Rollup | Minute and hour net buy-volume totals (buy volume = (AMT+SAMT)/2, sell volume = (AMT−SAMT)/2) |
| `CC_BOOK` | TAG | Raw order-book updates. One row per changed price level at 0.1-second intervals. `VALUE`: order price; `QTY`: new quantity (0 means removed); `SIDE`: 1 for buy, −1 for sell |
| `CC_WHALE` | LOG | Whale events (time, coin, direction, USD amount, multiple of normal volume, trade count) |
| `CC_GAME_ORDER` · `CC_GAME_EQUITY` · `CC_GAME_RESULT` | LOG · TAG · LOG | Paper trading orders, participant equity recorded every second, and round results |

Tag names use `BINANCE.BTCUSDT` for spot and `BINANCE_F.BTCUSDT` for futures. Futures contracts denominated in units of 1,000 coins,
such as `1000PEPEUSDT`, are normalized to the same units as spot and stored as `BINANCE_F.PEPEUSDT` (price ÷ 1,000, quantity × 1,000).

```sql
-- One-minute BTC futures candles for the past hour (rollup — no raw-data scan)
SELECT ROLLUP('min', 1, TIME) AS M, FIRST(TIME, VALUE) AS O, MAX(VALUE) AS H, MIN(VALUE) AS L, LAST(TIME, VALUE) AS C
  FROM CC_TICK WHERE NAME = 'BINANCE_F.BTCUSDT' AND TIME >= NOW - 1h GROUP BY M ORDER BY M;

-- Top 10 whale events by amount over the past day
SELECT WHALE_AT, NAME, SIDE, AMOUNT_USD, RATIO FROM CC_WHALE
  WHERE WHALE_AT >= NOW - 1d ORDER BY AMOUNT_USD DESC LIMIT 10;
```

## Configuration files

All configuration files reside in `<machbase-neo installation directory>/public/neo-pkg-coin-collector/cgi-bin/conf.d/` and are preserved during updates.

| File | Contents |
|---|---|
| `markets.json` | Coins to collect. Created by the collection settings view; manual editing is not needed. |
| `whale.json` | Whale thresholds: `{ "ratio": 30, "minUsd": 50000 }`. After changing them, toggle collection off and on using the App Store switch. |
| `db.json` | Only needed to store data in another Machbase instance: `{ "host": "...", "port": 5656, "user": "sys", "password": "..." }`. If absent, data is stored on this server. |

Development and architecture notes are available in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Korean).
