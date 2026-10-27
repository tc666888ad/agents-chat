import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('工作区按范围读取源码和记忆；拒绝敏感文件、绝对路径、符号链接和嵌套排除目录', async () => {
  const { WorkspaceReader } = await import('../src/roundtable/workspace.js');
  const root = mkdtempSync(join(tmpdir(), 'rt-workspace-'));
  try {
    for (const dir of ['src', 'src/node_modules', 'docs', '.codex']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '先读取项目记忆');
    writeFileSync(join(root, 'src/main.ts'), 'const hello = "读取已有代码";');
    writeFileSync(join(root, '.codex/memory.md'), '# 项目记忆');
    for (const file of ['src/.env.local', 'src/dev.pem', 'src/node_modules/secret.ts', '.codex/auth.json']) writeFileSync(join(root, file), 'secret');
    writeFileSync(join(root, 'docs/big.txt'), Buffer.alloc(512 * 1024 + 1, 65));
    writeFileSync(join(root, 'docs/binary.txt'), Buffer.from([0, 1, 2]));
    symlinkSync(join(root, 'src/main.ts'), join(root, 'docs/link.ts'));
    symlinkSync(join(root, '.codex'), join(root, 'docs/alias'));
    const reader = new WorkspaceReader(root);
    assert.match((await reader.read('src/main.ts')).text, /已有代码/);
    assert.match((await reader.read('.codex/memory.md')).text, /项目记忆/);
    const files = await reader.list();
    assert.ok(files.includes('AGENTS.md'));
    assert.ok(!files.some((f: string) => /\.env|\.pem|auth\.json|node_modules|link\.ts|alias/.test(f)));
    for (const path of ['../AGENTS.md', join(root, 'AGENTS.md'), 'src/.env.local', 'src/dev.pem', 'src/node_modules/secret.ts', '.codex/auth.json', 'docs/link.ts', 'docs/alias/memory.md', 'docs/big.txt', 'docs/binary.txt']) {
      await assert.rejects(() => reader.read(path), Error, path);
    }
    assert.deepEqual(await reader.search('已有代码'), [{ path: 'src/main.ts', line: 1, text: 'const hello = "读取已有代码";' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
