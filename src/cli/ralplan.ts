import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  NATIVE_SUBAGENT_ROLE_ROUTING_SUPPORT_FILE,
  NATIVE_SUBAGENT_ROLE_ROUTING_SUPPORT_TTL_MS,
  NATIVE_SUBAGENT_SUPPORT_BLOCKER_FILE,
  isUnsupportedNativeSubagentEvidenceForScope,
} from '../leader/contract.js';
import { normalizeSessionId, resolveRuntimeStateScope } from '../mcp/state-paths.js';
import { cancelMode } from '../modes/base.js';
import { readRoleRoutingMarker } from '../subagents/role-routing-marker.js';
import { resolveInstalledRoleName } from '../subagents/tracker.js';

export const RALPLAN_HELP = `omx ralplan - RALPLAN consensus support commands

Usage:
  omx ralplan preflight [--json]
  omx ralplan role-intent write --role <role> --parent-thread <id> [--session <id>] [--ttl-ms <n>] [--json]

Codex Desktop native sessions pass directly; other surfaces require a successful native typed-role spawn proof.
`;

type RoleIntentFailureReason = 'unknown_role' | 'unsupported_documented_leader_proof';

interface ParsedRoleIntentWriteArgs {
  role: string;
  parentThreadId: string;
  sessionId?: string;
  ttlMs?: number;
  json: boolean;
}

export interface RalplanCommandDependencies {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  resolveInstalledRoleName?: typeof resolveInstalledRoleName;
  isCodexDesktopNativeSurface?: typeof isCodexDesktopNativeSurface;
  hasNativeTypedRoleRoutingProof?: typeof hasNativeTypedRoleRoutingProof;
  cancelRalplan?: (cwd?: string) => Promise<void>;
}

export function isCodexDesktopNativeSurface(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const originator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE?.trim();
  return env.CODEX_CI === '1'
    && normalizeSessionId(env.CODEX_THREAD_ID) !== undefined
    && (!originator || originator === 'Codex Desktop');
}

export async function hasNativeTypedRoleRoutingProof(cwd: string): Promise<boolean> {
  let scope: Awaited<ReturnType<typeof resolveRuntimeStateScope>>;
  try {
    scope = await resolveRuntimeStateScope(cwd, process.env.CODEX_THREAD_ID);
  } catch {
    return false;
  }
  const sessionId = scope.sessionId;
  if (!sessionId) return false;
  if (readRoleRoutingMarker(scope.baseStateDir, { cwd: scope.cwd, sessionId })) {
    return false;
  }

  try {
    const blocker = JSON.parse(
      await readFile(join(scope.baseStateDir, NATIVE_SUBAGENT_SUPPORT_BLOCKER_FILE), 'utf-8'),
    ) as Record<string, unknown>;
    if (isUnsupportedNativeSubagentEvidenceForScope(blocker, {
      cwd: scope.cwd,
      sessionId,
    })) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }

  try {
    const proof = JSON.parse(
      await readFile(
        join(
          scope.baseStateDir,
          'sessions',
          sessionId,
          NATIVE_SUBAGENT_ROLE_ROUTING_SUPPORT_FILE,
        ),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const observedAt = Date.parse(String(proof.observed_at ?? ''));
    const expiresAt = Date.parse(String(proof.expires_at ?? ''));
    const proofLifetimeMs = expiresAt - observedAt;
    return proof.schema_version === 1
      && proof.status === 'supported'
      && proof.source === 'successful_native_typed_spawn'
      && proof.session_id === sessionId
      && Number.isFinite(observedAt)
      && Number.isFinite(expiresAt)
      && observedAt <= Date.now()
      && expiresAt > Date.now()
      && proofLifetimeMs > 0
      && proofLifetimeMs <= NATIVE_SUBAGENT_ROLE_ROUTING_SUPPORT_TTL_MS
      && typeof proof.cwd === 'string'
      && resolve(proof.cwd) === resolve(scope.cwd);
  } catch {
    return false;
  }
}

export async function ralplanCommand(
  args: string[],
  deps: RalplanCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
    stdout(RALPLAN_HELP);
    return;
  }
  if (args[0] === 'preflight') {
    const json = args.length === 2 && args[1] === '--json';
    if ((args.length !== 1 && !json)) throw new Error(`Unknown ralplan preflight argument: ${args.slice(1).join(' ')}`);
    const desktopNative = (
      deps.isCodexDesktopNativeSurface ?? isCodexDesktopNativeSurface
    )();
    if (desktopNative) {
      const success = { ok: true, source: 'codex_desktop_native_surface' as const };
      if (json) stdout(JSON.stringify(success));
      else stdout('ralplan preflight passed: Codex Desktop native surface verified');
      return;
    }
    const supported = await (
      deps.hasNativeTypedRoleRoutingProof ?? hasNativeTypedRoleRoutingProof
    )(process.cwd());
    if (supported) {
      const success = { ok: true, source: 'successful_native_typed_spawn' as const };
      if (json) stdout(JSON.stringify(success));
      else stdout('ralplan preflight passed: successful native typed-role spawn verified');
      return;
    }
    await (deps.cancelRalplan ?? ((cwd?: string) => cancelMode('ralplan', cwd)))(process.cwd());
    const failure = { ok: false, reason: 'unsupported_documented_leader_proof' as const };
    if (json) stdout(JSON.stringify(failure));
    else stderr('ralplan preflight failed: unsupported_documented_leader_proof');
    process.exitCode = 1;
    return;
  }

  if (args[0] !== 'role-intent' || args[1] !== 'write') {
    throw new Error(`Unknown ralplan command: ${args.join(' ')}\n${RALPLAN_HELP}`);
  }

  const parsed = parseRoleIntentWriteArgs(args.slice(2));
  const role = (deps.resolveInstalledRoleName ?? resolveInstalledRoleName)(parsed.role);
  emitRoleIntentFailure(
    role ? 'unsupported_documented_leader_proof' : 'unknown_role',
    parsed.json,
    stdout,
    stderr,
  );
}

function parseRoleIntentWriteArgs(args: string[]): ParsedRoleIntentWriteArgs {
  let role: string | undefined;
  let parentThreadId: string | undefined;
  let sessionId: string | undefined;
  let ttlMs: number | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--role' || arg === '--parent-thread' || arg === '--session' || arg === '--ttl-ms') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${arg}.`);
      if (arg === '--role') role = value;
      if (arg === '--parent-thread') parentThreadId = value;
      if (arg === '--session') sessionId = value;
      if (arg === '--ttl-ms') ttlMs = parseTtlMs(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--role=')) {
      role = arg.slice('--role='.length);
      continue;
    }
    if (arg.startsWith('--parent-thread=')) {
      parentThreadId = arg.slice('--parent-thread='.length);
      continue;
    }
    if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length);
      continue;
    }
    if (arg.startsWith('--ttl-ms=')) {
      ttlMs = parseTtlMs(arg.slice('--ttl-ms='.length));
      continue;
    }
    throw new Error(`Unknown role-intent write argument: ${arg}`);
  }

  if (!role?.trim()) throw new Error('Missing --role.');
  if (!parentThreadId?.trim()) throw new Error('Missing --parent-thread.');
  return {
    role,
    parentThreadId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    json,
  };
}

function parseTtlMs(value: string): number {
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('--ttl-ms must be a positive integer.');
  }
  return ttlMs;
}

function emitRoleIntentFailure(
  reason: RoleIntentFailureReason,
  json: boolean,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): void {
  const failure = { ok: false, reason };
  if (json) stdout(JSON.stringify(failure));
  else stderr(`role-intent write failed: ${reason}`);
  process.exitCode = 1;
}
