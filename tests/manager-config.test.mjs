import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import crypto from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import vm from 'node:vm';

// Run the real configuration code against temporary files, without starting
// the HTTP server, a proxy child, or touching the user's Codex configuration.
const source = fs.readFileSync(new URL('../dots-manager.mjs', import.meta.url), 'utf8');
const configCode = source.slice(0, source.indexOf('\nfunction log('))
  .replace(/^import .*;\n/gm, '')
  .replace('dirname(fileURLToPath(import.meta.url))', 'fixtureDir');

function fixture(t, initialConfig) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dots-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.toml');
  fs.writeFileSync(configPath, initialConfig);
  const context = vm.createContext({
    ...fs, crypto, join, dirname, homedir, fixtureDir: dir,
    process: { pid: process.pid, env: { CODEX_HOME: dir } },
    startChild() {}, stopChild() {},
  });
  vm.runInContext(configCode + '\nglobalThis.switchMode = setMode;', context);
  return {
    switchMode: context.switchMode,
    config: () => fs.readFileSync(configPath, 'utf8'),
  };
}

function assertDotsTableSeparated(config) {
  assert.match(config, /(?:^|\n)\[model_providers\.dots\]\nname = "dots"/);
  assert.doesNotMatch(config, /[^\r\n]\[model_providers\.dots\]/);
  assert.equal(config.split('[model_providers.dots]').length - 1, 1);
}

for (const eol of ['\n', '\r\n']) {
  for (const trailingNewline of [false, true]) {
    test(`dots header is separate after a table (${JSON.stringify(eol)}, trailing newline: ${trailingNewline})`, (t) => {
      const initial = ['model = "gpt-6.1-sol"', '[features]', 'enabled = false'].join(eol) + (trailingNewline ? eol : '');
      const f = fixture(t, initial);
      f.switchMode('dots');
      assertDotsTableSeparated(f.config());
      assert.match(f.config(), /\[features\]\nenabled = false(?:\n|$)/);
    });
  }
}

for (const suffix of ['', '\n']) {
  test(`repeated switches keep the last setting and one separate table (initial newline: ${Boolean(suffix)})`, (t) => {
    const f = fixture(t, 'model = "gpt-6.1-sol"\n[features]\nenabled = false' + suffix);
    for (let i = 0; i < 3; i++) {
      f.switchMode('dots');
      assertDotsTableSeparated(f.config());
      f.switchMode('direct');
      assert.doesNotMatch(f.config(), /\[model_providers\.dots\]/);
      assert.match(f.config(), /\[features\]\nenabled = false(?:\n|$)/);
    }
  });
}

test('a final comment cannot swallow the dots table header', (t) => {
  const f = fixture(t, '[features]\nenabled = false # disabled intentionally');
  f.switchMode('dots');
  assertDotsTableSeparated(f.config());
  assert.match(f.config(), /enabled = false # disabled intentionally\n/);
});
