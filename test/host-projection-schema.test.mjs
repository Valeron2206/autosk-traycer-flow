import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProjectionSchema, validateExecutionProjection } from '../src/host/execution-projection-schema.mjs';
const P='a'.repeat(64), key=`execution-base:${P}:epic-01:T01`;
function record(){return {schema_version:1,operation_id:'1'.repeat(64),key,plan_identity:'2'.repeat(64),recovery_target_digest:'3'.repeat(64),commit_oid:'4'.repeat(40),tree_oid:'5'.repeat(40),retention_ref:`refs/autosk/epics/${'6'.repeat(64)}/execution-bases/${'2'.repeat(64)}`,phase:'prepared',object_receipt:null,custody_receipt:null};}
test('execution-projection schema is immutable, versioned and source-closure pinned',()=>{
 const one=executionProjectionSchema(),two=executionProjectionSchema();assert.ok(Object.isFrozen(one));assert.equal(one.id,'execution-base-v1');assert.match(one.sha256,/^[a-f0-9]{64}$/);assert.equal(one.sha256,two.sha256);assert.equal(one.validate(key,record()),true);
});
for (const [name,mutate] of [
 ['unknown field',r=>{r.extra=true}],['missing field',r=>{delete r.operation_id}],['wrong key',r=>{r.key+='other'}],['bad phase',r=>{r.phase='accepted'}],['forged object receipt',r=>{r.object_receipt={}}],['missing object receipt',r=>{r.phase='objects_verified'}],['wrong plan ref',r=>{r.retention_ref=r.retention_ref.replace('2'.repeat(64),'8'.repeat(64))}],['mixed OID algorithms',r=>{r.tree_oid='5'.repeat(64)}],['wrong schema',r=>{r.schema_version=2}],['bad digest',r=>{r.plan_identity='unknown'}],
])test(`execution projection rejects ${name}`,()=>{const r=record();mutate(r);assert.throws(()=>validateExecutionProjection(key,r));});
test('object receipt is checked against every controlling field',()=>{
 const r=record();r.phase='objects_verified';r.object_receipt={schema_version:1,identity_digest:r.plan_identity,commit_oid:r.commit_oid,tree_oid:r.tree_oid,recovery_target_digest:r.recovery_target_digest,status:'objects_verified_not_retained'};
 assert.equal(validateExecutionProjection(key,r),true);r.object_receipt.tree_oid='9'.repeat(40);assert.throws(()=>validateExecutionProjection(key,r));
});
