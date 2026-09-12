import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export class AutomaticPaymentRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AutomaticPaymentRefusal'; }
}
export const requirePayment = (ok: unknown, code: string): void => { if (!ok) throw new AutomaticPaymentRefusal(code); };
export type StoredPolicy = { id: string; body: string; maxTotalAtoms: number; notBeforeMs: number; expiresAtMs: number };
export type Attempt = { jobId: string; original: string; originalDigest: string; amountAtoms: number; stage: string;
  claim: string | null; effectNotAfterMs: number };
export type HostedOperation = { operationId:string; binding:string; body:string; amountAtoms:number; stage:string; paymentJobId:string|null };

/** Host-owned local storage. The same database must be shared by every process
 * using this policy. No keys, signatures or bearer credentials are stored. */
export function openAutomaticBudget(directory: string, policy: StoredPolicy) {
  requirePayment(isAbsolute(directory) && realpathSync(directory) === directory, 'PRIVATE_DIRECTORY_REQUIRED');
  const ds = lstatSync(directory);
  requirePayment(ds.isDirectory() && !ds.isSymbolicLink() && (ds.mode & 0o077) === 0 && ds.uid === process.getuid?.(), 'PRIVATE_DIRECTORY_REQUIRED');
  const path = join(directory, 'automatic-payments.sqlite');
  try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const fs = lstatSync(path);
  requirePayment(fs.isFile() && !fs.isSymbolicLink() && fs.nlink === 1 && (fs.mode & 0o077) === 0 && fs.uid === ds.uid, 'PRIVATE_DATABASE_REQUIRED');
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS automatic_policy(id TEXT PRIMARY KEY, body TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS automatic_attempt(job_id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES automatic_policy(id),
      original TEXT NOT NULL, original_digest TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0),
      stage TEXT NOT NULL, claim TEXT, nonce_key TEXT UNIQUE, effect_not_after INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS automatic_hosted_operation(policy_id TEXT NOT NULL REFERENCES automatic_policy(id),
      operation_id TEXT NOT NULL, binding TEXT NOT NULL, body TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0),
      stage TEXT NOT NULL, payment_job_id TEXT UNIQUE REFERENCES automatic_attempt(job_id),
      PRIMARY KEY(policy_id,operation_id));`);
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  try { transaction(() => {
    const prior = db.prepare('SELECT body FROM automatic_policy WHERE id=?').get(policy.id);
    if (prior) requirePayment(prior.body === policy.body, 'POLICY_IMMUTABLE');
    else db.prepare('INSERT INTO automatic_policy(id,body) VALUES(?,?)').run(policy.id, policy.body);
  }); } catch (error) { db.close(); throw error; }
  function active(now: number) {
    requirePayment(Number.isSafeInteger(now) && now >= policy.notBeforeMs && now < policy.expiresAtMs, 'POLICY_EXPIRED');
    const row = db.prepare('SELECT body,revoked FROM automatic_policy WHERE id=?').get(policy.id);
    requirePayment(row?.body === policy.body && row.revoked === 0, 'POLICY_REVOKED');
  }
  function attempt(jobId: string): Attempt | null {
    const row = db.prepare('SELECT * FROM automatic_attempt WHERE job_id=?').get(jobId);
    if (!row) return null;
    requirePayment(row.policy_id === policy.id, 'ORIGINAL_POLICY_CONFLICT');
    return { jobId, original: String(row.original), originalDigest: String(row.original_digest), amountAtoms: Number(row.amount),
      stage: String(row.stage), claim: row.claim === null ? null : String(row.claim), effectNotAfterMs: Number(row.effect_not_after) };
  }
  function stage(jobId: string, expected: string, now: number) {
    active(now); const row = attempt(jobId);
    requirePayment(row && row.stage === expected, 'ORIGINAL_STAGE_CONFLICT');
    requirePayment(now < row!.effectNotAfterMs, 'ORIGINAL_EXPIRED');
    return row!;
  }
  function operation(operationId:string):HostedOperation|null {
    const r=db.prepare('SELECT * FROM automatic_hosted_operation WHERE policy_id=? AND operation_id=?').get(policy.id,operationId);
    return r?{operationId,binding:String(r.binding),body:String(r.body),amountAtoms:Number(r.amount),stage:String(r.stage),paymentJobId:r.payment_job_id===null?null:String(r.payment_job_id)}:null;
  }
  function total():number {
    const r=db.prepare(`SELECT (SELECT COALESCE(SUM(amount),0) FROM automatic_attempt WHERE policy_id=?) +
      (SELECT COALESCE(SUM(amount),0) FROM automatic_hosted_operation WHERE policy_id=? AND payment_job_id IS NULL) n`).get(policy.id,policy.id)!;
    return Number(r.n);
  }
  function insertAttempt(value:Attempt) {
    db.prepare('INSERT INTO automatic_attempt(job_id,policy_id,original,original_digest,amount,stage,effect_not_after) VALUES(?,?,?,?,?,?,?)')
      .run(value.jobId,policy.id,value.original,value.originalDigest,value.amountAtoms,'claim_intent',value.effectNotAfterMs);
  }
  return Object.freeze({
    reserve(value: Attempt, now: number): boolean { return transaction(() => {
      active(now); const prior = attempt(value.jobId);
      if (prior) { requirePayment(prior.originalDigest === value.originalDigest && prior.original === value.original, 'ORIGINAL_CONFLICT'); return false; }
      requirePayment(BigInt(total()) + BigInt(value.amountAtoms) <= BigInt(policy.maxTotalAtoms), 'BUDGET_EXHAUSTED');
      requirePayment(now < value.effectNotAfterMs, 'ORIGINAL_EXPIRED');
      insertAttempt(value);
      return true;
    }); },
    operation,
    reserveOperation(value:Omit<HostedOperation,'stage'|'paymentJobId'>,now:number,maxActive:number):boolean {return transaction(()=>{
      active(now);const old=operation(value.operationId);
      if(old){requirePayment(old.binding===value.binding&&old.amountAtoms===value.amountAtoms,'OPERATION_CONFLICT');return false;}
      requirePayment(BigInt(total())+BigInt(value.amountAtoms)<=BigInt(policy.maxTotalAtoms),'BUDGET_EXHAUSTED');
      const n=db.prepare("SELECT COUNT(*) n FROM automatic_hosted_operation WHERE policy_id=? AND stage<>'result_observed'").get(policy.id)!;
      requirePayment(Number(n.n)<maxActive,'ACTIVE_JOB_LIMIT');
      db.prepare("INSERT INTO automatic_hosted_operation(policy_id,operation_id,binding,body,amount,stage) VALUES(?,?,?,?,?,'review_intent')")
        .run(policy.id,value.operationId,value.binding,value.body,value.amountAtoms);return true;
    });},
    assertOperationStage(operationId:string,expected:string,now:number){active(now);requirePayment(operation(operationId)?.stage===expected,'OPERATION_STAGE_CONFLICT');},
    transitionOperation(operationId:string,expected:string,next:string,body:string,now:number,effect=true){transaction(()=>{
      if(effect)active(now);const old=operation(operationId);requirePayment(old?.stage===expected,'OPERATION_STAGE_CONFLICT');
      db.prepare('UPDATE automatic_hosted_operation SET stage=?,body=? WHERE policy_id=? AND operation_id=?').run(next,body,policy.id,operationId);
    });},
    adoptOperation(operationId:string,value:Attempt,now:number):boolean{return transaction(()=>{
      active(now);const op=operation(operationId);requirePayment(op&&op.amountAtoms===value.amountAtoms,'OPERATION_CONFLICT');
      const prior=attempt(value.jobId);
      if(prior){requirePayment(op!.paymentJobId===value.jobId&&prior.original===value.original&&prior.originalDigest===value.originalDigest,'ORIGINAL_CONFLICT');return false;}
      requirePayment(op!.stage==='prepared'&&op!.paymentJobId===null&&now<value.effectNotAfterMs,'OPERATION_STAGE_CONFLICT');
      insertAttempt(value);
      db.prepare("UPDATE automatic_hosted_operation SET stage='payment_intent',payment_job_id=? WHERE policy_id=? AND operation_id=?").run(value.jobId,policy.id,operationId);
      return true;
    });},
    claim(jobId: string, body: string, notAfterMs: number, now: number) { transaction(() => {
      const old = stage(jobId, 'claim_intent', now);
      requirePayment(now < notAfterMs && notAfterMs <= old.effectNotAfterMs, 'CLAIM_EXPIRED');
      db.prepare("UPDATE automatic_attempt SET stage='claimed',claim=?,effect_not_after=? WHERE job_id=?").run(body, notAfterMs, jobId);
    }); },
    signing(jobId: string, nonceKey: string, now: number) { transaction(() => {
      stage(jobId, 'claimed', now);
      requirePayment(!db.prepare('SELECT job_id FROM automatic_attempt WHERE nonce_key=?').get(nonceKey), 'AUTHORIZATION_ALREADY_ATTEMPTED');
      db.prepare("UPDATE automatic_attempt SET stage='sign_intent',nonce_key=? WHERE job_id=?").run(nonceKey, jobId);
    }); },
    submitting(jobId: string, now: number) { transaction(() => {
      stage(jobId, 'sign_intent', now); db.prepare("UPDATE automatic_attempt SET stage='submit_intent' WHERE job_id=?").run(jobId);
    }); },
    submitted(jobId: string) { transaction(() => {
      const row = attempt(jobId); requirePayment(row?.stage === 'submit_intent', 'ORIGINAL_STAGE_CONFLICT');
      db.prepare("UPDATE automatic_attempt SET stage='submitted_unconfirmed' WHERE job_id=?").run(jobId);
    }); },
    assertStage(jobId: string, expected: string, now: number) { stage(jobId, expected, now); },
    attempt,
    revoke() { transaction(() => { db.prepare('UPDATE automatic_policy SET revoked=1 WHERE id=?').run(policy.id); }); },
    status() {
      const p = db.prepare('SELECT revoked FROM automatic_policy WHERE id=?').get(policy.id)!;
      const row = db.prepare('SELECT COUNT(*) AS attempts FROM automatic_attempt WHERE policy_id=?').get(policy.id)!;
      return Object.freeze({ policyId: policy.id, revoked: p.revoked === 1, committedAtoms: String(total()), attempts: Number(row.attempts), maxTotalAtoms: String(policy.maxTotalAtoms) });
    },
    close() { db.close(); },
  });
}
