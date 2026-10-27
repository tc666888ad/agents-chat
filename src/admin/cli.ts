import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../db/index.js';
import { RoomHub } from '../infra/hub.js';
import { ServiceError, RoomService } from '../service/room-service.js';
import { ROLE_LABEL } from '../domain/room.js';

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const rest: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(arg);
    }
  }
  return { _: rest, flags };
}

function dbPath(): string {
  return process.env.DB_PATH || 'data/negotiation.db';
}

function service(): RoomService {
  const path = dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new RoomService(openDb(path), new RoomHub());
}

function tokenFrom(flags: Record<string, string | boolean>): string {
  const token = (flags.token as string | undefined) ?? process.env.NEG_TOKEN ?? '';
  if (!token) throw new ServiceError('FORBIDDEN', '缺少 --token 或环境变量 NEG_TOKEN');
  return token;
}

function printTokens(tokens: { seat?: string; role: string; name: string; token: string }[]): void {
  for (const t of tokens) {
    const label = ROLE_LABEL[t.role] ?? t.role;
    console.log(`  ${label}${t.seat ? `（入场券 ${t.seat}）` : ''}: ${t.token}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags } = parseArgs(rest);

try {
  const svc = service();

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(`用法：
  pnpm admin create-room --title "用户中心接口" [--scope "用户列表 详情 禁用"] [--prd-file x.md] [--designer A|B]
  pnpm admin rooms
  pnpm admin invite --token <人的票> --side frontend [--name 小王]
  pnpm admin post --token <票> --text "……"
  pnpm admin confirm --token <人的票> --ok
  pnpm admin confirm --token <人的票> --issue "这里不对"`);
    process.exit(0);
  }

  if (cmd === 'create-room') {
    const prdFile = flags['prd-file'] as string | undefined;
    const out = svc.createRoom({
      title: String(flags.title ?? '未命名房间'),
      op_scope: flags.scope ? String(flags.scope) : '',
      prd: prdFile ? readFileSync(prdFile, 'utf8') : String(flags.prd ?? ''),
      designer_seat: flags.designer === 'B' ? 'B' : 'A',
    });
    console.log(`房间 ${out.room.code} 已创建：${out.room.title}`);
    console.log(`网页：http://localhost:${process.env.PORT ?? 3000}/room/${out.room.code}`);
    console.log('入场券：');
    printTokens(out.tokens);
    console.log('\n把「设计方」和「复核方」两张票分别配给两个 agent。');
    process.exit(0);
  }

  if (cmd === 'rooms') {
    const rooms = svc.listRooms();
    if (!rooms.length) console.log('还没有房间。');
    for (const r of rooms) {
      console.log(
        `${r.code}  ${r.status_label}  ${r.title}  （${r.plan_count} 次提交，最后发言：${r.last_speaker ?? '—'} ${r.last_at ?? ''}）`,
      );
    }
    process.exit(0);
  }

  if (cmd === 'invite') {
    const cred = svc.authenticate(tokenFrom(flags));
    const out = svc.invite(cred, {
      side: flags.side === 'backend' ? 'backend' : 'frontend',
      name: flags.name ? String(flags.name) : undefined,
    });
    console.log(`审阅链接：http://localhost:${process.env.PORT ?? 3000}${out.link}`);
    process.exit(0);
  }

  if (cmd === 'post') {
    const cred = svc.authenticate(tokenFrom(flags));
    const text = String(flags.text ?? '');
    const message =
      cred.role === 'frontend' || cred.role === 'backend'
        ? svc.postHumanMessage(cred, { text })
        : svc.sendMessage(cred, { text }).message;
    console.log(`#${message.seq} ${message.speaker}: ${message.body}`);
    process.exit(0);
  }

  if (cmd === 'confirm') {
    const cred = svc.authenticate(tokenFrom(flags));
    const out = svc.confirm(cred, {
      verdict: flags.issue ? 'issue' : 'ok',
      note: flags.issue ? String(flags.issue) : undefined,
    });
    console.log(
      `已记录。状态：${out.status_label}；${out.confirmations.map((c) => `${c.label}=${c.status}`).join('，')}`,
    );
    process.exit(0);
  }

  console.error(`未知命令：${cmd}`);
  process.exit(1);
} catch (err) {
  if (err instanceof ServiceError) {
    console.error(`[${err.code}] ${err.message}`);
    process.exit(1);
  }
  throw err;
}
