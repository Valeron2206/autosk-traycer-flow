/** Read-only diagnostics. Available foundations are not advertised as a complete product. */
import { realpathSync } from 'node:fs';
import { GitObjects } from './git-objects.mjs';
import { immutable } from './contracts.mjs';

export function doctor(repositoryRoot, host = null) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ id: 'node_runtime', status: nodeMajor >= 24 ? 'available' : 'unsupported',
    detail: `Node ${process.versions.node}; supported production baseline is Node 24 or newer.` });
  try {
    const git = new GitObjects(realpathSync(repositoryRoot));
    checks.push({ id: 'git_objects', status: 'available', object_format: git.objectFormat,
      tool_digest: git.toolDigest(), detail: 'Absolute Git executable resolved and content-pinned; no refs or worktree changed.' });
  } catch (error) {
    checks.push({ id: 'git_objects', status: 'unavailable', detail: 'Git object preflight failed.', code: error.code ?? 'io_error' });
  }
  checks.push({ id: 'autosk_sdk_v2', status: host && typeof host.tasks?.current === 'function'
    && typeof host.transit === 'function' ? 'available' : 'unavailable',
  detail: 'Checked against the extension-facing API at pinned upstream 5163f00.' });
  // These must become live capability probes when the daemon/custody integration lands.
  // Boolean configuration supplied by an agent is not a capability proof.
  for (const [id, owner] of [['daemon_workflow_custody', 11], ['safe_project_fs', 13],
    ['ref_custody', 5], ['provider_qualification', 26], ['governance_release', 37], ['full_flow_e2e', 36]]) {
    checks.push({ id, status: 'not_integrated', owner_issue: owner,
      detail: 'Production integration and platform/custody qualification remain incomplete; source/test components do not authorize execution.' });
  }
  return immutable({ schema_version: 1, build_stage: 'native_host_boundary', production_ready: false,
    final_acceptance: 'pending',
    components: [
      { id: 'native_hostfs', status: 'implemented_not_qualified', owner_issue: 13 },
      { id: 'daemon_host_projections_patch', status: 'implemented_not_integrated', owner_issue: 38 },
    ], checks });
}
