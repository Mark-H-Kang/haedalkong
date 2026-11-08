export const templates = Object.freeze({
  join: '🦦 {name}님이 입장하셨어요!',
  rejoin: '🦦 {name}님 다시 오셨네요!',
  leave: '🦦 {name}님이 퇴장하셨어요!',
});

export const maxNoticeLength = 1000;
const seoul = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: '2-digit', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const graphemes = new Intl.Segmenter('ko-KR');

export function projectMember(previous, kind, name, seconds) {
  const inside = Number(kind === 'join');
  const transition = previous?.inside === inside
    ? null
    : inside && previous?.seen_join ? 'rejoin' : kind;
  const joined = Boolean(transition && inside);
  const left = Boolean(transition && !inside);
  return {
    transition,
    observedName: name !== null && name !== (previous?.name ?? null),
    name: name ?? previous?.name ?? null,
    seen_join: Number(Boolean(inside || previous?.seen_join)),
    inside,
    first_join: previous?.first_join ?? (joined ? seconds : null),
    last_join: joined ? seconds : previous?.last_join ?? null,
    last_exit: left ? seconds : previous?.last_exit ?? null,
    joins: (previous?.joins ?? 0) + Number(joined),
    leaves: (previous?.leaves ?? 0) + Number(left && kind === 'leave'),
    kicks: (previous?.kicks ?? 0) + Number(left && kind === 'kick'),
  };
}

function timeLine(label, seconds, count) {
  if (seconds == null) return `${label}: 기록 없음`;
  const parts = Object.fromEntries(seoul.formatToParts(seconds * 1000).map(({ type, value }) => [type, value]));
  const { year, month, day, hour, minute } = parts;
  const time = `${year}년 ${month}월 ${day}일 ${hour}시 ${minute}분`;
  return `${label}: ${time}${count === undefined ? '' : ` (${count}회)`}`;
}

function abbreviate(name, limit) {
  if (name.length <= limit) return name;
  let short = '';
  for (const { segment } of graphemes.segment(name)) {
    if (short.length + segment.length >= limit) break;
    short += segment;
  }
  return short + '…';
}

export function renderNotice(state, custom, previousName, recentNames) {
  const kind = state.transition === 'kick' ? 'leave' : state.transition;
  const render = template => template.replaceAll('{name}', () => state.name ?? '회원');
  const greeting = render(custom[kind]);
  const line = greeting.length <= 400 ? greeting : render(templates[kind]);
  const joins = state.joins;
  const exits = state.leaves + state.kicks;
  if (kind === 'join') return `🚪 최초 입장\n${line}\n\n${timeLine('입장 시각', state.first_join)}`;
  const lastJoin = timeLine('입장 시각', state.last_join, joins);
  const lastExit = timeLine('퇴장 시각', state.last_exit, exits);
  if (kind === 'leave') return `🚪 퇴장 감지\n${line}\n\n${lastExit}\n\n${lastJoin}`;

  const first = timeLine('최초 입장 시각', state.first_join);
  const body = `💕 재입장\n${line}\n\n${first}\n${lastJoin}\n\n${lastExit}`;
  if (!recentNames.length) return body;
  const detail = `${body}\n\n🦦 닉변 감지! 🦦\n✏️ 이전 닉네임: ${previousName}\n` +
    `✨ 변경 닉네임: ${state.name}\n\n📋 최근 닉네임 이력 (${recentNames.length}개)\n`;
  const arrow = ' → ';
  let remaining = maxNoticeLength - detail.length - arrow.length * (recentNames.length - 1);
  const names = recentNames.map((name, index) => {
    const shown = abbreviate(name, Math.floor(remaining / (recentNames.length - index)));
    remaining -= shown.length;
    return shown;
  });
  return detail + names.join(arrow);
}
