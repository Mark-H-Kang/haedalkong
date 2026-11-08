# Iris 연결 및 복구

## 기존 환경 조사

기존 Windows 브리지에서 확인한 Iris 회원 이벤트 판별 규칙을 해달콩의 파서와 이력 모듈에 적용했습니다.

| 이벤트 | Iris `json.v.origin` | `msg.feedType` | 회원 필드 |
| --- | --- | --- | --- |
| 입장 | `NEWMEM` | 4 | `members[]` |
| 자발 퇴장 | `DELMEM` | 2 | `member` |
| 강제 퇴장 | `KICKMEM` | 6 | `member` |

시스템 행의 `json.type`은 0입니다. 행 `id`는 중복 식별, `_id`는 정렬 및 복구에 사용합니다. [Iris 공개 문서의 프레임 및 응답 구조](https://github.com/dolidolih/Iris#api-%EB%A0%88%ED%8D%BC%EB%9F%B0%EC%8A%A4)

Iris의 공개 WebSocket 계약은 채팅 로그 프레임을 설명합니다. 방별 구성원 조회는 현재 이름을 반환하며, 공개 Iris 봇 예제는 닉네임을 주기적으로 조회해 변화를 비교합니다. 신뢰할 수 있는 독립 닉네임 변경 이벤트는 이 자료에서 확인되지 않았습니다. 해달콩은 입퇴장 프레임의 확인된 이름만 기록합니다. [Iris WebSocket 계약](https://github.com/dolidolih/Iris#websocket-%EC%97%94%EB%93%9C%ED%8F%AC%EC%9D%B8%ED%8A%B8) · [Iris 닉네임 비교 예제](https://github.com/dolidolih/iris_bot/blob/main/bots/detect_nickname_change.py#L327-L437)

배포된 Iris의 기존 `/reply` 권한은 운영 본방에 고정되어 있습니다. 해달콩 후보는 별도의 `/reply/haedalkong`과 Windows 전용 접수 서버를 사용합니다. 기존 경로와 토큰을 유지하며, 새 경로에는 해달콩 방 지문·프로필 참조·승인 기록·별도 토큰이 필요합니다.

## 상시 관찰과 발송 후보

- `node src/cli.mjs observe`는 `liveEnabled: false` 상태에서 확인한 단일 방만 관찰합니다. `observe-status`로 체크포인트와 집계를 확인합니다. `var/observe.sqlite`에 저장하며 발송 접수를 하지 않습니다.
- WebSocket은 즉시 조회 신호로 쓰고, 같은 방의 원본 행만 조회해 기존 체크포인트와 대조합니다. 재연결 시 원본으로 확인한 입퇴장은 이력에 반영하되 발송하지 않습니다. 체크포인트가 사라지거나 한 번에 1,000건을 초과하면 안전 중단합니다. 일반 채팅 본문은 조회하지 않습니다.
- 배포 검증 후 `gateway --live`와 `relay --live`를 별도 작업으로 관리합니다. `CHILGAP_MAIN_BINDING`과 `CHILGAP_GLOBAL_STOP`에는 기존 본방 바인딩과 STOP의 절대 경로를 지정합니다. 해달콩은 이 파일을 읽습니다. 해달콩만 멈출 때는 해달콩의 `var/STOP`을 사용합니다.
- `HAEDALKONG_GATEWAY_PORT`는 Windows 루프백 접수 포트, `HAEDALKONG_IRIS_PORT`는 기존 Iris 포트입니다. `OPENCHAT_WRITER_TOKEN`은 릴레이→접수용, `HAEDALKONG_IRIS_TOKEN`은 접수→Iris 및 Iris→발송 직전 확인용입니다. 모두 별도로 생성하고 보호된 실행 환경에서 주입합니다.
- Iris 후보에는 `IRIS_HAEDALKONG_TOKEN`, `IRIS_HAEDALKONG_ROOM`, `IRIS_HAEDALKONG_ROOM_SHA256`, `IRIS_HAEDALKONG_PROFILE`, `IRIS_HAEDALKONG_PROOF`, `IRIS_HAEDALKONG_CALLBACK_PORT`가 필요합니다. 콜백은 전용 ADB reverse 매핑을 통해 Windows 루프백 서버에만 도달합니다. 콜백은 SQLite의 발송 클레임을 한 번만 승인하고 STOP, 만료, 방과 승인 기록을 다시 확인합니다. Gateway는 한 번에 한 건씩 제출하고 Iris 공용 큐의 발송 간격을 따릅니다. 원본 이벤트의 110초 유효시간이 지나면 대기 알림은 `expired`로 기록됩니다.
- `var/live.sqlite`는 회원 이력과 봇 Outbox, `var/writer.sqlite`는 접수와 Iris 발송 시도의 상태를 담습니다. `submitted`는 Android 발송 요청이 제출됐다는 뜻입니다. 카카오톡 수신은 별도 계정에서 확인합니다. 불명확한 요청은 재전송하지 않으며, 이어지는 발송은 상태를 확인할 때까지 보류됩니다.
- 첫 시험 발송은 `liveEnabled: false` 상태에서 `gateway-probe`로 제한할 수 있습니다. `HAEDALKONG_PROBE_KEY`와 `HAEDALKONG_PROBE_TEXT`에 승인된 시험 키와 문구를 고정합니다. 시험 전용 `var/probe-writer.sqlite`가 그 키를 보존하며, 일반 회원 알림은 발송하지 않습니다.

후보 반영 전 기존 APK와 운영 SQLite·Outbox 백업을 검증합니다. 기존 작성기는 Iris WebSocket 재접속 횟수가 제한되어 있으므로, Iris 교체·복구와 함께 기존 작성기의 재연결 또는 재가동 절차까지 리허설해야 합니다. 실장비에서는 양쪽 토큰의 교차 발송 차단을 먼저 확인하고, 별도 계정의 실제 수신과 발신 프로필, STOP, 기존 응답과 토너 스케줄러를 확인한 뒤 해달콩 자동 발송을 켭니다.

## 공용 환경 연결 계약

1. 동일 Windows, LDPlayer9, Iris 인스턴스의 재사용을 검토합니다. 운영 본방과 겹치지 않는 신규 오픈채팅방에서 승인받은 계정의 새 오픈프로필을 설정하고 방 ID와 실제 발신 프로필을 확인합니다.
2. 승인된 읽기 릴레이에서 방 ID를 먼저 검사합니다. 확인된 방의 멤버십 프레임만 원본 JSON 형태의 JSONL로 전달합니다. 별도의 카카오 로그인, 직접 DB 접근, 운영 DB 쓰기 없이 기존 관찰 경로를 사용합니다. 푸시만으로 누락 여부를 알 수 없으므로 방별 체크포인트 기준의 원본 조회와 재연결 후 순서 복구가 필요합니다. 누락 범위를 입증할 수 없으면 신규 발송을 보류합니다.
3. 공용 발송 관리기는 아래 요청을 별도 자격 증명으로 받고 신규 봇 전용 Outbox로 접수해야 합니다. 관리기에서 신규 방 ID, 프로필, 확인 기록, 메시지 크기, 키의 네임스페이스, 만료를 검증합니다. 기존 전역 STOP, 기존 발송량 제한과 새 봇의 `var/STOP`을 접수 시점과 실제 발송 시점 모두 확인합니다. `key`로 영속 중복 제거하고, 동일 키와 다른 본문 또는 대상은 충돌로 처리합니다. 접수와 발송 결과는 별도 상태로 관리합니다.
4. 설정의 `profileRef`에는 관리기가 등록한 신규 오픈프로필 식별자, `verificationRef`에는 방과 실제 발신 프로필을 대조한 승인 기록의 참조값을 넣습니다. DB가 이 연결을 기억하므로 기존 방의 연결이 바뀌면 검증된 이전 절차가 필요합니다. 신규 방에서만 관측과 실제 발신 확인을 마친 뒤 `liveEnabled`를 켭니다.

전용 접수 요청은 `POST /v1/haedalkong/enqueue`이며 루프백 HTTP 주소와 해달콩 전용 Bearer 토큰을 사용합니다. 요청 필드는 `key`, `roomId`, `profileRef`, `verificationRef`, `text`, `expiresAt`(Unix 초)입니다. 키는 `haedalkong-v1:`으로 시작합니다. 관리기는 내구성 있는 접수 후 HTTP 202와 `{ "status": "accepted", "key": "...", "roomId": "...", "profileRef": "...", "receipt": "..." }`를 반환합니다. 접수 영수증은 카카오톡 발송 확인과 별도로 기록합니다. 해달콩은 Iris `/reply`를 직접 호출하지 않습니다.

## 활성화 후 명령

`migrate`를 제외한 `--live` 명령에는 운영을 활성화한 검증된 `config.local.json`이 필요합니다. 운영 입력 파일이나 표준 입력은 접근 권한이 제한된 승인 릴레이에서만 받습니다. 승인되지 않은 채팅방의 전체 피드를 로컬 파일로 덤프하지 않습니다.

```powershell
node src/cli.mjs ingest --live approved-frames.jsonl
node src/cli.mjs status --live
node src/cli.mjs dispatch --live
```

`dispatch`는 환경 변수 `OPENCHAT_WRITER_URL`과 `OPENCHAT_WRITER_TOKEN`을 읽습니다. 값은 운영 계정의 비밀 저장 경로에서 주입합니다. 신규 방과 기존 방의 경계, 발신 오픈프로필, 관리기 인증, 중복 접수, STOP과 발송량 제한을 실장비에서 확인하는 작업은 남아 있습니다.

## 장애 시 절차

1. 신규 프로젝트의 `var/STOP`을 만들고 신규 입력 릴레이와 발송 작업을 멈춥니다. 이미 접수된 작업은 공용 발송 관리기에서 신규 봇 큐만 보류합니다. 진행 중인 요청이 종료됐는지 확인합니다.
2. `status --live`로 체크포인트와 미확정 접수를 확인합니다. 관리기의 영수증과 큐 상태를 조회해 `node src/cli.mjs resolve --live <key> accepted` 또는 `discarded`로 기록합니다. 결과를 입증할 수 없으면 보류하고, 같은 키를 자동 재전송하지 않습니다.
3. 승인된 원본에서 누락된 프레임을 확보한 뒤 `node src/cli.mjs backfill --live recovered.jsonl`을 실행합니다. 늦게 도착한 프레임은 회원별 순서대로 이력을 다시 계산합니다. 새 발송은 생성하지 않고, 이력을 보정한 방의 기존 대기 알림은 폐기합니다. 서로 다른 이벤트가 동일 순번을 사용하면 운영자 확인이 필요합니다.
4. 이력과 관리기 상태를 확인한 뒤 STOP이 있는 상태에서 `node src/cli.mjs resume --live`를 실행합니다. 이어 신규 프로젝트 STOP을 해제하고 승인된 릴레이와 발송 작업을 재개합니다. 기존 칠갑산봇의 STOP, 프로세스, DB는 이 절차의 작업 대상에서 제외합니다.

## DB 마이그레이션

1. 해달콩의 입력·발송 작업을 중지하고, 운영 DB는 해달콩의 `var/STOP`을 만듭니다. 이미 발송 관리기에 접수된 작업이 있다면 해달콩 큐만 보류합니다.
2. 리플레이 DB는 `node src/cli.mjs migrate`, 운영 DB는 `node src/cli.mjs migrate --live`로 업그레이드합니다. SQLite 버전은 리플레이 `1 → 3`, 운영 `2 → 4`입니다. 쓰기를 예약한 상태에서 커밋된 DB 스냅샷을 `var/<파일명>.backup-*/before-migration.sqlite`에 만들고 버전과 무결성을 확인한 뒤 원본을 트랜잭션 안에서 마이그레이션합니다. 이력과 기존 발송 상태가 든 백업은 운영 계정만 접근할 수 있는 곳에 보관합니다.
3. 기존 프레임을 순서대로 읽어 회원 집계와 닉네임 이력을 재구성합니다. 원본 프레임, 체크포인트, 방 승인 정보, 기존 접수 기록은 보존합니다. 구형 알림 본문이 발송되지 않도록 대기 알림만 `discarded`로 전환합니다. `sending`이나 `uncertain` 상태는 위 장애 절차에 따라 확인합니다.
4. 작업이 실패하면 SQLite 트랜잭션을 롤백합니다. 작업 결과와 백업을 확인할 때까지 해달콩을 중지 상태로 유지합니다. 리플레이 DB는 `status`로 확인할 수 있습니다. 운영 DB를 이미 사용 중인 환경에서는 해달콩 전용 승인 절차에 따라 재개합니다.
