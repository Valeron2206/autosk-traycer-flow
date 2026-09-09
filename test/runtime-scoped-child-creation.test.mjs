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
// Each fixture names the refusal it expects. Asserting only that something
// threw let a fixture be caught by an unrelated guard downstream — the parent
// blocker was refused as an invalid compiled slot, so the guard the test was
// named after was never evaluated.
for(const [name,change,message] of [
  ['foreign project',r=>r.slots[0].intent.context={...context,project_root_sha256:'f'.repeat(64)},'Child intent belongs to another context, parent, operation or duplicate slot'],
  ['foreign parent',r=>r.slots[0].intent.parent_task_id='ask-cccccc','Child intent belongs to another context, parent, operation or duplicate slot'],
  ['foreign operation',r=>r.slots[0].intent.operation_id='other','Child intent belongs to another context, parent, operation or duplicate slot'],
  ['duplicate slot',r=>r.slots.push(structuredClone(r.slots[0])),'Child intent belongs to another context, parent, operation or duplicate slot'],
  ['untracked field',r=>r.extra=true,'Record fields must match the closed contract'],
  ['empty slots',r=>r.slots=[],'Invalid bounded array'],
  ['sparse slots',r=>r.slots=Array(2),'Invalid bounded array'],
  ['accessor index',r=>Object.defineProperty(r.slots,'0',{get:()=>({intent:r.slots[1].intent,display:{title:'t',description:'d',blocked_by:[]}}),enumerable:true,configurable:true}),'Array accessors or holes are forbidden'],
  ['parent blocker',r=>r.slots[0].display.blocked_by=[r.parent_task_id],'Invalid child blockers'],
  ['duplicate blocker',r=>r.slots[0].display.blocked_by=['ask-dddddd','ask-dddddd'],'Invalid child blockers'],
  ['unsupported version',r=>r.schema_version=2,'Unsupported creation grant version'],
  ['zero step visit',r=>r.step_visit=0,'Invalid step visit/expiry'],
  ['non-integer expiry',r=>r.expires_at_ms=1.5,'Invalid step visit/expiry'],
  ['blank title',r=>r.slots[0].display.title='   ','Invalid display text'],
  ['oversized description',r=>r.slots[0].display.description='x'.repeat(65537),'Invalid display text'],
])test(`grant compiler rejects ${name}`,()=>{const raw=input();assert.doesNotThrow(()=>compileTaskCreationGrant(raw));change(raw);
  assert.throws(()=>compileTaskCreationGrant(raw),e=>e.message===message,`${name} was refused by another guard`);});
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
  // The expected message is part of each case: a compiled grant has several
  // guards over the same record, and "some code was thrown" cannot tell whether
  // the one under test was ever evaluated.
  for(const [change,message] of [
    [g=>g.slots=null,'Invalid bounded array'],
    [g=>g.slots=Array(1),'Invalid bounded array'],
    [g=>g.slots[0].input=null,'Expected a plain record'],
    [g=>g.schema_version=2,'Unsupported compiled grant version'],
    [g=>g.context_digest=null,'Expected SHA-256'],
    [g=>g.step_visit=0,'Invalid compiled visit/expiry'],
    [g=>g.slots[0].input.title='  ','Invalid compiled display text'],
    [g=>g.slots[0].input.creation_key='flow:zz','Expected a compiled creation key'],
    [g=>g.slots[0].input.blocked_by=[g.parent_task_id],'Invalid or duplicate compiled slot'],
    [g=>{g.slots[1].slot_id=g.slots[0].slot_id;},'Invalid or duplicate compiled slot'],
  ]){
    const raw=structuredClone(compiled);change(raw);
    await assert.rejects(createGrantedChild(api,raw,'gpt'),e=>e.message===message);
  }
  // A capability that is not the scoped creation API is refused before the
  // grant is even read, so a wrong protocol never reaches a create call.
  for(const bad of [{capabilities:{protocol:'other'},create:async()=>{}},{capabilities:{protocol:'autosk-scoped-task-creation/v1'}},null]){
    await assert.rejects(createGrantedChild(bad,compiled,'gpt'),{code:'scoped_creation_unavailable'});
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
  const requested=input();requested.slots.forEach(slot=>slot.display.blocked_by=['ask-cccccc']);
  const grant=compileTaskCreationGrant(requested);
  for(const outcome of ['created','existing_same_binding']){
    const raw=await apiDouble(grant).create('gpt');raw.outcome=outcome;
    if(outcome==='existing_same_binding')Object.assign(raw.task,{status:'work',workflow:'panel',step:'review'});
    raw.task.blocked_by=[...raw.task.blocked_by];
    const expected=structuredClone(raw);
    const result=await createGrantedChild(apiDouble(grant,raw),grant,'gpt');
    assert.notEqual(result,raw);assert.notEqual(result.task,raw.task);
    raw.outcome='invalid';raw.task.creation_key='changed';raw.task.blocked_by.push('ask-dddddd');
    assert.deepEqual(result,expected);
    assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.task));assert.ok(Object.isFrozen(result.task.blocked_by));
    assert.throws(()=>{result.task.status='done';},TypeError);
  }
});

for(const [name,change] of [
  ['non-string title',task=>task.title=1],['blank title',task=>task.title=' '],
  ['oversized title',task=>task.title='x'.repeat(8193)],
  ['non-string description',task=>task.description={}],['oversized description',task=>task.description='x'.repeat(65537)],
  ['non-array blockers',task=>task.blocked_by={}],['invalid blocker',task=>task.blocked_by=['other']],
  ['duplicate blockers',task=>task.blocked_by=['ask-cccccc','ask-cccccc']],
  ['too many blockers',task=>task.blocked_by=Array.from({length:257},(_,i)=>`ask-${i.toString(16).padStart(6,'0')}`)],
  ['non-string status',task=>task.status={}],['unknown status',task=>task.status='success'],
  ['non-string workflow',task=>task.workflow=1],['invalid workflow',task=>task.workflow='../panel'],
  ['non-string step',task=>task.step={}],['invalid step',task=>task.step='review\n'],
])test(`SDK result rejects ${name} values`,async()=>{
  const grant=compileTaskCreationGrant(input());
  for(const outcome of ['created','existing_same_binding']){
    const raw=await apiDouble(grant).create('gpt');raw.outcome=outcome;change(raw.task);
    await assert.rejects(createGrantedChild(apiDouble(grant,raw),grant,'gpt'),e=>typeof e.code==='string');
  }
});

test('fresh SDK child must preserve admitted blockers while a retry may have changed blockers',async()=>{
  const grant=compileTaskCreationGrant(input());
  const raw=await apiDouble(grant).create('gpt');raw.task.blocked_by=['ask-cccccc'];
  await assert.rejects(createGrantedChild(apiDouble(grant,raw),grant,'gpt'),{code:'creation_result_mismatch'});
  raw.outcome='existing_same_binding';
  assert.deepEqual((await createGrantedChild(apiDouble(grant,raw),grant,'gpt')).task.blocked_by,['ask-cccccc']);
});

test('SDK retry accepts all upstream statuses and exact display/blocker limits',async()=>{
  const grant=compileTaskCreationGrant(input());
  for(const status of ['new','work','human','done','cancel']){
    const raw=await apiDouble(grant).create('gpt');raw.outcome='existing_same_binding';
    Object.assign(raw.task,{status,workflow:status==='new'?null:'panel',step:status==='new'?null:'review',
      title:'x'.repeat(8192),description:'x'.repeat(65536),
      blocked_by:Array.from({length:256},(_,i)=>`ask-${i.toString(16).padStart(6,'0')}`)});
    assert.deepEqual(await createGrantedChild(apiDouble(grant,raw),grant,'gpt'),raw);
  }
});

test('fresh SDK blocker comparison uses set identity',async()=>{
  const requested=input();requested.slots.forEach(slot=>slot.display.blocked_by=['ask-cccccc','ask-dddddd']);
  const grant=compileTaskCreationGrant(requested),raw=await apiDouble(grant).create('gpt');
  raw.task.blocked_by=[...raw.task.blocked_by].reverse();
  assert.deepEqual(await createGrantedChild(apiDouble(grant,raw),grant,'gpt'),raw);
});

test('SDK blocker array cannot invoke a method inherited from a custom prototype',async()=>{
  const grant=compileTaskCreationGrant(input());
  for(const outcome of ['created','existing_same_binding']){
    const raw=await apiDouble(grant).create('gpt');raw.outcome=outcome;let calls=0;
    raw.task.blocked_by=[];
    Object.setPrototypeOf(raw.task.blocked_by,Object.assign(Object.create(Array.prototype),{
      map(){calls++;return [];},
    }));
    await assert.rejects(createGrantedChild(apiDouble(grant,raw),grant,'gpt'),{code:'invalid_identity'});
    assert.equal(calls,0);
  }
});

test('grant arrays reject inherited iteration before invoking it',()=>{
  for(const field of ['slots','blocked_by']){
    const raw=input();let calls=0;
    const array=field==='slots'?raw.slots:raw.slots[0].display.blocked_by;
    Object.setPrototypeOf(array,Object.assign(Object.create(Array.prototype),{
      [Symbol.iterator](){calls++;return Array.prototype[Symbol.iterator].call(this);},
    }));
    assert.throws(()=>compileTaskCreationGrant(raw),{code:'creation_grant_invalid'});
    assert.equal(calls,0);
  }
});

test('SDK result proxies are refused without executing traps',async()=>{
  const grant=compileTaskCreationGrant(input());
  for(const field of ['task','blocked_by']){
    const raw=await apiDouble(grant).create('gpt');let calls=0;
    const target=field==='task'?raw.task:raw.task.blocked_by;
    const proxy=new Proxy(target,{
      get(object,key){calls++;return Reflect.get(object,key);},
      getPrototypeOf(object){calls++;return Reflect.getPrototypeOf(object);},
      ownKeys(object){calls++;return Reflect.ownKeys(object);},
    });
    if(field==='task')raw.task=proxy;else raw.task.blocked_by=proxy;
    await assert.rejects(createGrantedChild(apiDouble(grant,raw),grant,'gpt'),{code:field==='blocked_by'?'invalid_identity':'invalid_record'});
    assert.equal(calls,0);
  }
});
