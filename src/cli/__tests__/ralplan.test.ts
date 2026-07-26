import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  hasNativeTypedRoleRoutingProof,
  type RalplanCommandDependencies,
  ralplanCommand,
} from '../ralplan.js';

async function invoke(args: string[], deps: RalplanCommandDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

describe('#3194 ralplan CLI unsupported-only surface', () => {
  it('fails the explicit adapted-surface preflight and neutralizes routing-only Ralplan state', async () => {
    let resolved = false;
    let cancelled = false;
    const result = await invoke(['preflight', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
      hasNativeTypedRoleRoutingProof: async () => false,
      cancelRalplan: async () => { cancelled = true; },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(resolved, false);
    assert.equal(cancelled, true);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });

  it('passes preflight when a successful native typed-role spawn is durably proven', async () => {
    let cancelled = false;
    const result = await invoke(['preflight', '--json'], {
      hasNativeTypedRoleRoutingProof: async () => true,
      cancelRalplan: async () => { cancelled = true; },
    });
    assert.equal(result.exitCode, undefined);
    assert.equal(cancelled, false);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), {
      ok: true,
      source: 'successful_native_typed_spawn',
    });
  });

  it('reads only cwd-matching typed-role proof from the OMX state directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-proof-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'native-role-routing-support.json'), JSON.stringify({
        schema_version: 1,
        status: 'supported',
        source: 'successful_native_typed_spawn',
        cwd,
      }));
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), true);

      await writeFile(join(stateDir, 'native-role-routing-support.json'), JSON.stringify({
        schema_version: 1,
        status: 'supported',
        source: 'successful_native_typed_spawn',
        cwd: join(cwd, 'foreign'),
      }));
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('validates malformed arguments before resolving a role', async () => {
    let resolved = false;
    await assert.rejects(() => invoke(['role-intent', 'write', '--role', 'architect', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
    }), /Missing --parent-thread/);
    assert.equal(resolved, false);
  });

  it('returns unknown_role for a syntactically valid uninstalled role', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'synthetic-unknown', '--parent-thread', 'synthetic-parent', '--json'], {
      resolveInstalledRoleName: () => null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });

  it('denies installed roles before any runtime state dependency is consulted', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'synthetic-parent', '--session', 'synthetic-session', '--ttl-ms', '1', '--json'], {
      resolveInstalledRoleName: (role) => role.toLowerCase() === 'architect' ? 'architect' : null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });
});
