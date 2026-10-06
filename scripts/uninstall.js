'use strict';

/**
 * pkg run uninstall
 *
 * 수집 서비스(와 남아 있을 수 있는 일회성 비우기 서비스)를 멈추고 등록을 지운다. 테이블(CC_TICK·CC_BOOK, 롤업)은 남긴다 —
 * 쌓은 데이터를 패키지 재설치 한 번에 날리면 안 된다. 필요하면 직접 DROP TABLE 한다. retention 정책도 테이블과 함께 남는다.
 */
const service = require('service');

const NAMES = ['neo-pkg-coin-collector-svc', 'neo-pkg-coin-collector-clear'];

function remove(i) {
    if (i >= NAMES.length) { console.println('neo-pkg-coin-collector uninstalled. Tables were left intact.'); return; }
    const name = NAMES[i];
    service.status(name, function (missing) {
        if (missing) { remove(i + 1); return; }
        service.stop(name, function (stopErr) {
            if (stopErr) console.println('WARN stop', name + ':', stopErr.message);
            service.uninstall(name, function (err) {
                if (err) console.println('WARN uninstall', name + ':', err.message);
                else console.println('service uninstalled:', name);
                remove(i + 1);
            });
        });
    });
}
remove(0);
