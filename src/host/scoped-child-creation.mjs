/** Compile approved host inputs to the daemon's least-authority creation grant.
 * This does not grant itself authority, enroll tasks, or confirm product gates.
 */
import { closedRecord, demand, assertDigest, digest, immutable, sameIdentity, compareCodePoints } from '../runtime/contracts.mjs';
import { validateContext } from '../runtime/context.mjs';
import { compileChildCreationIntent } from './child-creation-intent.mjs';
import { types } from 'node:util';
export const MAX_CREATION_GRANT_BYTES = 1_048_576;
const FIELDS = ['schema_version','grant_id','context','parent_task_id','session_id','workflow','step','step_visit','operation_id','expires_at_ms','slots'];
const BINDING = ['schema_version','grant_id','project_sha256','parent_task_id','session_id','workflow','step','step_visit','operation_id','context_digest','expires_at_ms'];
const identifier = value => demand(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value), 'creation_grant_invalid', 'Invalid bounded logical identifier');
const taskId = value => demand(typeof value === 'string' && /^ask-[a-f0-9]{6}$/u.test(value), 'creation_grant_invalid', 'Invalid task ID');
function list(value, min, max) {
  demand(!types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype
    && value.length >= min && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1,'creation_grant_invalid','Invalid bounded array');
  for (let i=0;i<value.length;i++) {
    const d=Object.getOwnPropertyDescriptor(value,String(i));
    demand(d && d.enumerable && Object.hasOwn(d,'value'),'creation_grant_invalid','Array accessors or holes are forbidden');
  }
}
export function compileTaskCreationGrant(raw) {
  closedRecord(raw,FIELDS);
  demand(raw.schema_version===1,'creation_grant_invalid','Unsupported creation grant version');
  validateContext(raw.context); taskId(raw.parent_task_id);
  for (const name of ['grant_id','session_id','workflow','step','operation_id']) identifier(raw[name]);
  demand(Number.isSafeInteger(raw.step_visit) && raw.step_visit>=1 && Number.isSafeInteger(raw.expires_at_ms),
    'creation_grant_invalid','Invalid step visit/expiry');
  list(raw.slots,1,64);
  const seen=new Set(); const compiled=[]; const intents=[];
  for (const slot of raw.slots) {
    closedRecord(slot,['intent','display']);
    const pair=compileChildCreationIntent(slot.intent);
    demand(sameIdentity(slot.intent.context,raw.context) && slot.intent.parent_task_id===raw.parent_task_id
      && slot.intent.operation_id===raw.operation_id && !seen.has(slot.intent.slot_id),
    'creation_grant_binding_mismatch','Child intent belongs to another context, parent, operation or duplicate slot');
    closedRecord(slot.display,['title','description','blocked_by']);
    demand(typeof slot.display.title==='string' && slot.display.title.trim().length>0 && Buffer.byteLength(slot.display.title)<=8192
      && typeof slot.display.description==='string' && Buffer.byteLength(slot.display.description)<=65536,
    'creation_grant_invalid','Invalid display text');
    list(slot.display.blocked_by,0,256); slot.display.blocked_by.forEach(taskId);
    demand(!slot.display.blocked_by.includes(raw.parent_task_id) && new Set(slot.display.blocked_by).size===slot.display.blocked_by.length,
      'creation_grant_invalid','Invalid child blockers');
    const blockedBy = [...slot.display.blocked_by].sort(compareCodePoints);
    // Blockers change scheduling semantics. Only title/description are display data.
    // Retrying the same slot with different blockers must conflict in autoskd.
    const creationBinding = digest('autosk-flow/scoped-child-binding/v1', {
      intent_binding_hash: pair.creation_binding_hash,
      blocked_by: blockedBy,
    });
    compiled.push({slot_id:slot.intent.slot_id,input:{title:slot.display.title,description:slot.display.description,
      blocked_by:blockedBy,creation_key:pair.creation_key,creation_binding_hash:creationBinding}});
    intents.push(slot.intent); seen.add(slot.intent.slot_id);
  }
  compiled.sort((a,b)=>compareCodePoints(a.slot_id,b.slot_id)); intents.sort((a,b)=>compareCodePoints(a.slot_id,b.slot_id));
  const context_digest=digest('autosk-flow/creation-scope-context/v1',{
    context:raw.context,parent_task_id:raw.parent_task_id,session_id:raw.session_id,workflow:raw.workflow,
    step:raw.step,step_visit:raw.step_visit,operation_id:raw.operation_id,intents,
    creation_identities: compiled.map(({slot_id,input}) => ({
      slot_id,creation_key:input.creation_key,creation_binding_hash:input.creation_binding_hash,
    })),
  });
  const grant={schema_version:1,grant_id:raw.grant_id,project_sha256:raw.context.project_root_sha256,
    parent_task_id:raw.parent_task_id,session_id:raw.session_id,workflow:raw.workflow,step:raw.step,step_visit:raw.step_visit,
    operation_id:raw.operation_id,context_digest,expires_at_ms:raw.expires_at_ms,slots:compiled};
  return snapshotCompiledGrant(grant);
}
/** Revalidate a compiled record before awaiting the SDK, and retain a private copy.
 * This is input/output integrity, never a substitute for supervisor admission.
 */
function snapshotCompiledGrant(raw) {
  closedRecord(raw,[...BINDING,'slots']);
  demand(raw.schema_version===1,'creation_grant_invalid','Unsupported compiled grant version');
  assertDigest(raw.project_sha256); assertDigest(raw.context_digest); taskId(raw.parent_task_id);
  for (const name of ['grant_id','session_id','workflow','step','operation_id']) identifier(raw[name]);
  demand(Number.isSafeInteger(raw.step_visit) && raw.step_visit>=1 && Number.isSafeInteger(raw.expires_at_ms),
    'creation_grant_invalid','Invalid compiled visit/expiry');
  list(raw.slots,1,64); const ids=new Set();const keys=new Set();
  for(const slot of raw.slots) {
    closedRecord(slot,['slot_id','input']); identifier(slot.slot_id);
    closedRecord(slot.input,['title','description','blocked_by','creation_key','creation_binding_hash']);
    const input=slot.input;
    demand(typeof input.title==='string' && input.title.trim().length>0 && Buffer.byteLength(input.title)<=8192
      && typeof input.description==='string' && Buffer.byteLength(input.description)<=65536,
    'creation_grant_invalid','Invalid compiled display text');
    demand(typeof input.creation_key==='string' && /^flow:[a-f0-9]{64}$/u.test(input.creation_key),
      'creation_grant_invalid','Expected a compiled creation key'); assertDigest(input.creation_binding_hash);
    list(input.blocked_by,0,256); input.blocked_by.forEach(taskId);
    demand(!input.blocked_by.includes(raw.parent_task_id) && new Set(input.blocked_by).size===input.blocked_by.length
      && !ids.has(slot.slot_id) && !keys.has(input.creation_key), 'creation_grant_invalid','Invalid or duplicate compiled slot');
    ids.add(slot.slot_id);keys.add(input.creation_key);
  }
  demand(Buffer.byteLength(JSON.stringify(raw))<=MAX_CREATION_GRANT_BYTES,
    'creation_grant_invalid','Compiled grant exceeds daemon byte budget');
  return immutable(raw);
}
/** Call only an already-issued supervisor capability and verify its exact binding.
 * The capability itself, not this public shape check, is the authority boundary.
 */
export async function createGrantedChild(api, grant, slotId) {
  demand(api?.capabilities?.protocol==='autosk-scoped-task-creation/v1' && typeof api.create==='function',
    'scoped_creation_unavailable','A supervisor-issued scoped creation API is required');
  const pinned=snapshotCompiledGrant(grant);
  const {slots,...expected}=pinned;
  demand(sameIdentity(api.binding,expected) && sameIdentity(api.slot_ids,slots.map(s=>s.slot_id)),
    'creation_grant_binding_mismatch','SDK capability does not bind this exact grant');
  const slot=slots.find(s=>s.slot_id===slotId);
  demand(slot,'creation_slot_missing','Child slot is absent from the admitted grant');
  const raw=await api.create(slotId);
  closedRecord(raw,['outcome','task']);
  closedRecord(raw.task,['id','status','workflow','step','title','description','blocked_by','creation_key','creation_binding_hash']);
  const result=immutable(raw);
  const task=result.task;
  demand(typeof task.title==='string' && task.title.trim().length>0 && Buffer.byteLength(task.title)<=8192
    && typeof task.description==='string' && Buffer.byteLength(task.description)<=65536,
  'creation_result_mismatch','Invalid returned display text');
  list(task.blocked_by,0,256);task.blocked_by.forEach(taskId);
  demand(new Set(task.blocked_by).size===task.blocked_by.length
    && ['new','work','human','done','cancel'].includes(task.status),
  'creation_result_mismatch','Invalid returned blockers or lifecycle status');
  for(const name of ['workflow','step'])if(task[name]!==null)identifier(task[name]);
  demand(['created','existing_same_binding'].includes(result.outcome) && result.task?.creation_key===slot.input.creation_key
    && result.task?.creation_binding_hash===slot.input.creation_binding_hash,
  'creation_result_mismatch','SDK child result has the wrong outcome or creation identity');
  taskId(result.task.id);
  if(result.outcome==='created')demand(result.task.status==='new' && result.task.workflow===null && result.task.step===null,
    'creation_result_mismatch','Fresh child was already enrolled outside the creation operation');
  if(result.outcome==='created')demand(sameIdentity([...task.blocked_by].sort(compareCodePoints),slot.input.blocked_by),
    'creation_result_mismatch','Fresh child blockers differ from the admitted grant');
  return result;
}
