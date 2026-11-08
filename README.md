# 해달콩 (haedalkong)

해달콩은 카카오톡 오픈채팅에서 최초 입장, 자발 퇴장, 재입장, 강제 퇴장 알림을 보내고 방별 회원 이력을 기록하는 독립 봇입니다. Windows에서 Node.js 24 이상으로 실행하며 외부 npm 패키지가 필요 없습니다. 기본 설정은 오프라인입니다. 운영 연동 절차는 [Iris 연결 및 복구 가이드](docs/iris-integration.md)에 있습니다.

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

`config.local.json`의 `rooms`에는 방 ID를 10진수 문자열 키로 등록합니다. 각 방의 `templates`에 `join`, `leave`, `rejoin`, `kick` 문구를 덮어쓸 수 있습니다. `{name}`에 이벤트 닉네임이 들어가고, 닉네임이 비어 있으면 마지막으로 확인된 이름 또는 ‘회원’을 사용합니다. 문구 변경은 새로 생성되는 알림부터 적용됩니다.

## 이력과 발송

- 방 ID, 이벤트 ID, 회원 ID를 문자열로 보존합니다. 이벤트 ID 재수신은 내용까지 일치할 때 중복으로 처리합니다. 같은 이벤트에서 여러 회원이 들어오면 전체 이력을 한 번에 기록합니다.
- 과거 입장 기록이 있는 회원이 퇴장 또는 강제 퇴장 후 돌아오면 재입장으로 분류합니다. 첫 관측이 퇴장인 회원의 다음 입장은 이 저장소에서 확인한 첫 입장입니다. 연속으로 같은 재실 상태를 보고한 프레임은 이력에 남기고 알림을 추가하지 않습니다.
- 이력, 방별 체크포인트, 발송 대기열을 한 SQLite 트랜잭션에 저장합니다. 발송 요청 전에 클레임을 영속화합니다. 접수 확인이 불명확하면 운영자가 확인할 때까지 발송을 중단합니다. 기본 발송 유효 기간은 원본 이벤트부터 120초입니다.
- SQLite에 회원 ID, 닉네임, 입퇴장 시각, 알림 문구가 저장됩니다. 운영 폴더와 백업의 접근 권한은 운영 계정으로 제한합니다. GitHub에는 합성 테스트 데이터와 예시 설정만 올립니다. 실제 설정, 토큰, DB, 운영 로그와 이벤트 파일은 별도로 관리합니다.
