import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  hasNativeTypedRoleRoutingProof,
  isCodexDesktopNativeSurface,
  type RalplanCommandDependencies,
  ralplanCommand,
} from '../ralplan.js';
import { writeRoleRoutingMarker } from '../../subagents/role-routing-marker.js';

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
      isCodexDesktopNativeSurface: () => false,
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
      isCodexDesktopNativeSurface: () => false,
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

  it('never emits unsupported_documented_leader_proof on Codex Desktop', async () => {
    const previousCi = process.env.CODEX_CI;
    const previousThreadId = process.env.CODEX_THREAD_ID;
    const previousOriginator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    try {
      process.env.CODEX_CI = '1';
      process.env.CODEX_THREAD_ID = '019fa186-4775-7be3-a2ff-17b6a487ae97';
      delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
      let cancelled = false;
      const result = await invoke(['preflight', '--json'], {
        hasNativeTypedRoleRoutingProof: async () => false,
        cancelRalplan: async () => { cancelled = true; },
      });
      assert.equal(result.exitCode, undefined);
      assert.equal(cancelled, false);
      assert.deepEqual(result.stderr, []);
      assert.deepEqual(JSON.parse(result.stdout.join('\n')), {
        ok: true,
        source: 'codex_desktop_native_surface',
      });
      assert.doesNotMatch(result.stdout.join('\n'), /unsupported_documented_leader_proof/);
    } finally {
      if (previousCi === undefined) delete process.env.CODEX_CI;
      else process.env.CODEX_CI = previousCi;
      if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThreadId;
      if (previousOriginator === undefined) delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
      else process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = previousOriginator;
    }
  });

  it('accepts the originator-less Codex App subprocess identity and rejects adapted surfaces', () => {
    assert.equal(isCodexDesktopNativeSurface({
      CODEX_CI: '1',
      CODEX_THREAD_ID: '019f9bff-6b5a-7a01-b63a-d3d80cdebf44',
    }), true);
    assert.equal(isCodexDesktopNativeSurface({
      CODEX_CI: '1',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    }), false);
    assert.equal(isCodexDesktopNativeSurface({
      CODEX_CI: '1',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex CLI',
      CODEX_THREAD_ID: '019f9bff-6b5a-7a01-b63a-d3d80cdebf44',
    }), false);
    assert.equal(isCodexDesktopNativeSurface({
      CODEX_THREAD_ID: '019f9bff-6b5a-7a01-b63a-d3d80cdebf44',
    }), false);
  });

  it('reads only cwd-matching typed-role proof from the OMX state directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-proof-'));
    const previousThreadId = process.env.CODEX_THREAD_ID;
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionId = '019f9bff-6b5a-7a01-b63a-d3d80cdebf44';
      const proofPath = join(stateDir, 'sessions', sessionId, 'native-role-routing-support.json');
      const nowMs = Date.now();
      process.env.CODEX_THREAD_ID = sessionId;
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(proofPath, JSON.stringify({
        schema_version: 1,
        status: 'supported',
        source: 'successful_native_typed_spawn',
        session_id: sessionId,
        observed_at: new Date(nowMs - 1_000).toISOString(),
        expires_at: new Date(nowMs + 60_000).toISOString(),
        cwd,
      }));
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), true);

      await writeFile(join(stateDir, 'native-subagent-support.json'), JSON.stringify({
        schema_version: 1,
        status: 'unsupported',
        reason: 'multi_agent_v1_unavailable',
        source: 'post_tool_failure',
        session_id: sessionId,
        observed_at: new Date(nowMs).toISOString(),
        cwd,
      }));
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), false);
      await rm(join(stateDir, 'native-subagent-support.json'));

      await writeFile(proofPath, JSON.stringify({
        schema_version: 1,
        status: 'supported',
        source: 'successful_native_typed_spawn',
        session_id: sessionId,
        observed_at: new Date(nowMs - 1_000).toISOString(),
        expires_at: new Date(nowMs + 60_000).toISOString(),
        cwd: join(cwd, 'foreign'),
      }));
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), false);
    } finally {
      if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThreadId;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects expired proof and lets current role-routing-unavailable evidence win', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-stale-role-proof-'));
    const previousThreadId = process.env.CODEX_THREAD_ID;
    try {
      const sessionId = '019f9bff-6b5a-7a01-b63a-d3d80cdebf45';
      const stateDir = join(cwd, '.omx', 'state');
      const proofPath = join(stateDir, 'sessions', sessionId, 'native-role-routing-support.json');
      const nowMs = Date.now();
      process.env.CODEX_THREAD_ID = sessionId;
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(proofPath, JSON.stringify({
        schema_version: 1,
        status: 'supported',
        source: 'successful_native_typed_spawn',
        session_id: sessionId,
        observed_at: new Date(nowMs - 120_000).toISOString(),
        expires_at: new Date(nowMs - 60_000).toISOString(),
        cwd,
      }));
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), false);

      await writeFile(proofPath, JSON.stringify({
        schema_version: 1,
        status: 'supported',
        source: 'successful_native_typed_spawn',
        session_id: sessionId,
        observed_at: new Date(nowMs - 1_000).toISOString(),
        expires_at: new Date(nowMs + 60_000).toISOString(),
        cwd,
      }));
      writeRoleRoutingMarker(stateDir, {
        schema_version: 1,
        cwd,
        session_id: sessionId,
        observed_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + 60_000).toISOString(),
        evidence: 'current surface does not expose typed role routing',
      });
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), false);

      await rm(join(stateDir, 'native-subagent-role-routing.json'));
      await writeFile(proofPath, JSON.stringify({
        schema_version: 1,
        status: 'supported',
        source: 'successful_native_typed_spawn',
        session_id: sessionId,
        observed_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + 48 * 60 * 60_000).toISOString(),
        cwd,
      }));
      assert.equal(await hasNativeTypedRoleRoutingProof(cwd), false);
    } finally {
      if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThreadId;
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
