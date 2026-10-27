/** @ 解析：有点名就只回被点名的；没点名或 @所有人 就全部回。 */

const ALL_WORDS = ['所有人', '全部', '大家', 'all', 'everyone'];

export interface MentionTarget {
  id: string;
  name: string;
}

export function resolveTargets<T extends MentionTarget>(text: string, agents: T[]): { all: boolean; targets: T[] } {
  const lower = text.toLowerCase();
  const hit = new Set<string>();
  let explicitAll = false;
  // 名字长的先匹配，避免 "DeepSeek" 被 "Deep" 抢走
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  const re = /@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const rest = lower.slice(m.index + 1);
    if (ALL_WORDS.some((w) => rest.startsWith(w.toLowerCase()))) {
      explicitAll = true;
      continue;
    }
    const agent = sorted.find((a) => a.name && rest.startsWith(a.name.toLowerCase()));
    if (agent) hit.add(agent.id);
  }
  if (explicitAll || hit.size === 0) return { all: true, targets: agents };
  return { all: false, targets: agents.filter((a) => hit.has(a.id)) };
}
