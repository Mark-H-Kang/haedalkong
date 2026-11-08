# 해달콩 (haedalkong)

해달콩은 카카오톡 오픈채팅의 최초 입장, 퇴장, 재입장을 알리고 방별 회원의 입퇴장·닉네임 이력을 기록하는 독립 봇입니다. Windows에서 Node.js 24 이상으로 실행하며 외부 npm 패키지가 필요 없습니다. 기본 설정은 오프라인입니다. 운영 연동 절차는 [Iris 연결 및 복구 가이드](docs/iris-integration.md)에 있습니다.

## 오프라인 실행

```powershell
git clone https://github.com/Mark-H-Kang/haedalkong.git
Set-Location haedalkong
npm test
Copy-Item config.example.json config.local.json
node src/cli.mjs replay fixtures/membership.jsonl
node src/cli.mjs status
```

새 리플레이 DB에서는 이벤트 4건 적용, 중복 1건, 미승인 방 1건 무시를 확인할 수 있습니다. 같은 파일을 다시 읽으면 중복 5건, 무시 1건입니다. 재생 결과는 `var/replay.sqlite`에 저장됩니다. 운영 모드의 DB 경로는 `var/live.sqlite`이며 서로 다른 SQLite 식별자를 사용합니다.

`config.local.json`의 `rooms`에는 방 ID를 10진수 문자열 키로 등록합니다. 각 방의 `templates`에서 `join`, `leave`, `rejoin` 인사말을 바꿀 수 있습니다. `{name}`은 현재 확인된 이름, 마지막 확인 이름 또는 ‘회원’으로 바뀝니다. 제목과 이력 표시는 고정입니다. 기존 `kick` 설정은 읽을 수 있으며, 두 퇴장 유형 모두 `leave` 인사말을 씁니다. 인사말 변경은 새 알림부터 적용됩니다.

## 이력과 발송

- 방 ID와 회원 ID의 조합으로 회원을 구분합니다. 중복 이벤트는 무시하고 여러 회원이 포함된 이벤트는 전체를 한 번에 기록합니다.
- 시각은 원본 이벤트를 기준으로 `Asia/Seoul`로 표시합니다. 최초 입장은 저장된 이력에서 처음 확인한 입장입니다. 퇴장이 먼저 확인되면 입장 시각은 ‘기록 없음’으로 표시합니다. 연속으로 같은 재실 상태를 보고하면 집계와 알림을 추가하지 않습니다. 자발적 퇴장과 강제 퇴장은 내부에서 구분하며, 공개 알림과 누적 퇴장 횟수는 합칩니다.
- 닉네임은 검증된 입퇴장 프레임에서 바뀐 값만 저장합니다. 재입장 때 직전 확인 이름과 달라졌으면 이전·현재 이름과 최근 최대 5개를 오래된 순서대로 표시합니다. 긴 이름은 1,000 UTF-16 코드 단위 제한에 맞추기 위해 공개 이력 줄에서만 줄여 표시할 수 있습니다. 전체 이력과 변경 전후 이름은 보존됩니다.
- 이력, 방별 체크포인트, 발송 대기열을 한 SQLite 트랜잭션에 저장합니다. 발송 요청 전에 클레임을 영속화합니다. 접수 확인이 불명확하면 운영자가 확인할 때까지 발송을 중단합니다. 기본 발송 유효 기간은 원본 이벤트부터 120초입니다.
- SQLite에 회원 ID, 닉네임, 입퇴장 시각, 알림 문구가 저장됩니다. 운영 폴더와 백업의 접근 권한은 운영 계정으로 제한합니다. GitHub에는 합성 테스트 데이터와 예시 설정만 올립니다. 실제 설정, 토큰, DB, 운영 로그와 이벤트 파일은 별도로 관리합니다.

## 기존 SQLite 업그레이드

기존 DB에서 `migration-required`가 표시되면 해달콩 작업을 멈춘 상태에서 리플레이 DB는 `node src/cli.mjs migrate`로 업그레이드합니다. 기존 운영 DB는 해달콩의 `var/STOP`을 만든 뒤 `node src/cli.mjs migrate --live`로 업그레이드합니다. 이 명령은 운영 발송을 활성화하지 않습니다. 백업과 확인 절차는 [DB 마이그레이션](docs/iris-integration.md#db-마이그레이션)을 참조하세요.
