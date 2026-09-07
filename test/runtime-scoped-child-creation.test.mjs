import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTaskCreationGrant, createGrantedChild } from '../src/host/scoped-child-creation.mjs';
const context={project_root_sha256:'a'.repeat(64),epic_id:'11111111-1111-4111-8111-111111111111',anchor_version:1,protocol_digest:'b'.repeat(64),
  runtime_lock_digest:'c'.repeat(64),project_instruction_digest:'d'.repeat(64),delivery_profile_digest:'e'.repeat(64)};
function input() {
  return {schema_version:1,grant_id:'grant-1',context,parent_task_id:'ask-aaaaaa',session_id:'session-1',workflow:'planned',step:'fanout',step_visit:1,
    operation_id:'op-1',expires_at_ms:1_800_000_000_000,slots:['grok','gpt'].map(slot_id=>({
      intent:{schema_version:1,context,parent_task_id:'ask-aaaaaa',operation_id:'op-1',slot_id,child_role:'reviewer',seat:slot_id,
        candidate_digest:'1'.repeat(64),target_workflow:'panel',initial_step:'review',provider_session_intent_digest:'2'.repeat(64),sandbox_snapshot_intent_digest:'3'.repeat(64)},
      display:{title:'Reviewer',description:'Non-authoritative display text',blocked_by:[]},
    }))};
}
// These tests use an explicit API double for output validation. They do not
// exercise the actual Store or native persistence, which remain prerequisites.
function apiDouble(grant, result) {
  const {slots,...binding}=grant;
  return {capabilities:{protocol:'autosk-scoped-task-creation/v1'},binding,slot_ids:slots.map(s=>s.slot_id),
    create:async id=>result??{outcome:'created',task:{id:'ask-bbbbbb',status:'new',workflow:null,step:null,...slots.find(s=>s.slot_id===id).input}}};
}
test('grant compilation is deterministic and canonicalizes slot order',()=>{
  const raw=input(),one=compileTaskCreationGrant(raw); raw.slots.reverse();const two=compileTaskCreationGrant(raw);
  assert.deepEqual(one,two);assert.deepEqual(one.slots.map(s=>s.slot_id),['gpt','grok']);assert.ok(Object.isFrozen(one.slots[0].input));
});
test('renewed lease and display correction keep the creation binding, not the grant identity',()=>{
  const raw=input(),one=compileTaskCreationGrant(raw);raw.grant_id='renewal';raw.expires_at_ms+=1000;raw.slots[0].display.title='New title';
  const two=compileTaskCreationGrant(raw);assert.equal(one.context_digest,two.context_digest);
  assert.equal(one.slots[0].input.creation_binding_hash,two.slots[0].input.creation_binding_hash);assert.notDeepEqual(one,two);
});
test('candidate, session, parent visit and locks are load-bearing context',()=>{
  const one=compileTaskCreationGrant(input());
  for(const change of [r=>r.session_id='session-2',r=>r.step_visit=2,r=>r.slots[0].intent.candidate_digest='f'.repeat(64)]){
    const raw=input();change(raw);assert.notEqual(compileTaskCreationGrant(raw).context_digest,one.context_digest);
  }
});
for(const [name,change] of [
  ['foreign project',r=>r.slots[0].intent.context={...context,project_root_sha256:'f'.repeat(64)}],
  ['foreign parent',r=>r.slots[0].intent.parent_task_id='ask-cccccc'],['foreign operation',r=>r.slots[0].intent.operation_id='other'],
  ['duplicate slot',r=>r.slots.push(structuredClone(r.slots[0]))],['untracked field',r=>r.extra=true],['empty slots',r=>r.slots=[]],
  ['sparse slots',r=>r.slots=Array(2)],['parent blocker',r=>r.slots[0].display.blocked_by=[r.parent_task_id]],
])test(`grant compiler rejects ${name}`,()=>{const raw=input();assert.doesNotThrow(()=>compileTaskCreationGrant(raw));change(raw);assert.throws(()=>compileTaskCreationGrant(raw));});
test('call wrapper verifies bound SDK result and never invokes another grant',async()=>{
  const grant=compileTaskCreationGrant(input()),api=apiDouble(grant);
  assert.equal((await createGrantedChild(api,grant,'gpt')).task.id,'ask-bbbbbb');
  await assert.rejects(createGrantedChild({...api,binding:{...api.binding,session_id:'other'}},grant,'gpt'),{code:'creation_grant_binding_mismatch'});
  await assert.rejects(createGrantedChild(api,grant,'unknown'),{code:'creation_slot_missing'});
});
test('success prose, wrong marker and prematurely enrolled child are not accepted',async()=>{
  const grant=compileTaskCreationGrant(input()),ok=await apiDouble(grant).create('gpt');
  for(const bad of ['done',{...ok,outcome:'done'},{...ok,task:{...ok.task,creation_binding_hash:'f'.repeat(64)}},{...ok,task:{...ok.task,status:'work'}}]){
    await assert.rejects(createGrantedChild(apiDouble(grant,bad),grant,'gpt'));
  }
});

test('malformed compiled grant rejects before calling the capability',async()=>{
  const compiled=compileTaskCreationGrant(input());let calls=0;
  const api={...apiDouble(compiled),create:async()=>{calls++;throw Error('must not call')}};
  for(const change of [g=>g.slots=null,g=>g.slots=Array(1),g=>g.slots[0].input=null,g=>g.schema_version=2,g=>g.context_digest=null]){
    const raw=structuredClone(compiled);change(raw);
    await assert.rejects(createGrantedChild(api,raw,'gpt'),e=>typeof e.code==='string');
  }
  assert.equal(calls,0);
});
test('caller mutation while SDK call is pending cannot change expected creation markers',async()=>{
  const compiled=compileTaskCreationGrant(input());const raw=structuredClone(compiled);let resolve;
  const api={...apiDouble(compiled),create:()=>new Promise(r=>resolve=r)};
  const pending=createGrantedChild(api,raw,'gpt');
  const original=raw.slots.find(s=>s.slot_id==='gpt').input;
  original.creation_binding_hash='f'.repeat(64);
  resolve({outcome:'created',task:{id:'ask-bbbbbb',status:'new',workflow:null,step:null,...original}});
  await assert.rejects(pending,{code:'creation_result_mismatch'});
});
test('compiled grant accessors are refused without executing them',async()=>{
  const compiled=compileTaskCreationGrant(input());const raw=structuredClone(compiled);let calls=0;
  Object.defineProperty(raw.slots[0].input,'description',{enumerable:true,get(){calls++;return ''}});
  await assert.rejects(createGrantedChild(apiDouble(compiled),raw,'gpt'));
  assert.equal(calls,0);
});
test('compiler enforces the exact daemon byte limit, including all display fields',()=>{
  const raw=input();const seed=raw.slots[0];raw.slots=Array.from({length:16},(_,i)=>({
    intent:{...structuredClone(seed.intent),slot_id:`slot-${i}`},display:{title:'Reviewer',description:'',blocked_by:[]},
  }));
  let room=1_048_576-Buffer.byteLength(JSON.stringify(compileTaskCreationGrant(raw)));
  for(const slot of raw.slots){const n=Math.min(room,65536);slot.display.description='x'.repeat(n);room-=n;}
  assert.equal(room,0);const exact=compileTaskCreationGrant(raw);
  assert.equal(Buffer.byteLength(JSON.stringify(exact)),1_048_576);
  raw.slots[0].display.title+='x';assert.throws(()=>compileTaskCreationGrant(raw),{code:'creation_grant_invalid'});
});

test('scheduler blockers are binding inputs, not editable display metadata', () => {
  const original = input();
  original.slots[0].display.blocked_by = ['ask-111111'];
  const first = compileTaskCreationGrant(original);
  const changed = structuredClone(original);
  changed.slots[0].display.blocked_by = ['ask-222222'];
  const second = compileTaskCreationGrant(changed);
  const before = first.slots.find((slot) => slot.slot_id === 'grok').input;
  const after = second.slots.find((slot) => slot.slot_id === 'grok').input;
  assert.equal(before.creation_key, after.creation_key);
  assert.notEqual(before.creation_binding_hash, after.creation_binding_hash);
  assert.notEqual(first.context_digest, second.context_digest);
});

test('blocker ordering is canonical and cannot create a different identity', () => {
  const raw = input();
  raw.slots[0].display.blocked_by = ['ask-222222', 'ask-111111'];
  const first = compileTaskCreationGrant(raw);
  raw.slots[0].display.blocked_by.reverse();
  assert.deepEqual(compileTaskCreationGrant(raw), first);
});

for(const [name,change] of [
  ['inherited fields',task=>Object.create(task)],
  ['inherited marker',task=>{
    const inherited=Object.create({creation_key:task.creation_key});
    Object.assign(inherited,task);delete inherited.creation_key;return inherited;
  }],
  ['symbol field',task=>({...task,[Symbol('extra')]:true})],
  ['unexpected field',task=>({...task,extra:true})],
  ['missing field',task=>{delete task.description;return task;}],
  ['hidden field',task=>{Object.defineProperty(task,'description',{enumerable:false});return task;}],
])test(`SDK result rejects ${name}`,async()=>{
  const grant=compileTaskCreationGrant(input()),ok=await apiDouble(grant).create('gpt');
  for(const outcome of ['created','existing_same_binding']){
    const task=change(structuredClone(ok.task));
    await assert.rejects(createGrantedChild(apiDouble(grant,{outcome,task}),grant,'gpt'),{code:'invalid_record'});
  }
});

for(const field of ['id','status','workflow','step','title','description','blocked_by','creation_key','creation_binding_hash']){
  test(`SDK task ${field} getter is rejected without invocation`,async()=>{
    const grant=compileTaskCreationGrant(input()),ok=await apiDouble(grant).create('gpt');let calls=0;
    for(const outcome of ['created','existing_same_binding']){
      const task={...ok.task};
      Object.defineProperty(task,field,{enumerable:true,get(){calls++;return ok.task[field];}});
      await assert.rejects(createGrantedChild(apiDouble(grant,{outcome,task}),grant,'gpt'),{code:'invalid_record'});
    }
    assert.equal(calls,0);
  });
}

test('SDK result is a detached immutable snapshot for fresh and progressed children',async()=>{
  const grant=compileTaskCreationGrant(input());
  for(const outcome of ['created','existing_same_binding']){
    const raw=await apiDouble(grant).create('gpt');raw.outcome=outcome;
    if(outcome==='existing_same_binding')Object.assign(raw.task,{status:'work',workflow:'panel',step:'review'});
    raw.task.blocked_by=['ask-cccccc'];
    const expected=structuredClone(raw);
    const result=await createGrantedChild(apiDouble(grant,raw),grant,'gpt');
    assert.notEqual(result,raw);assert.notEqual(result.task,raw.task);
    raw.outcome='invalid';raw.task.creation_key='changed';raw.task.blocked_by.push('ask-dddddd');
    assert.deepEqual(result,expected);
    assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.task));assert.ok(Object.isFrozen(result.task.blocked_by));
    assert.throws(()=>{result.task.status='done';},TypeError);
  }
});
