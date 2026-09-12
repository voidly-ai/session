import { parseContext } from './protocol';
import { verifyEd25519Bytes } from './signatures';
import { MONETARY_ASSET, MONETARY_CHAIN, MONETARY_TOKEN, record, snapshot, equal, canonical, sha256, integer, id, digest, tx, text, base64, invalid,
  type MonetaryOriginal, type MonetaryClaimReference, type MonetaryWalletClaim, type MonetaryExistingClaim, type MonetaryAuthorizationStatus, type MonetarySubmission, type MonetaryRecovery } from './monetaryProtocol';
const iso = (v: unknown): number => { const s = text(v, 32); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s)) return invalid(); return integer(Date.parse(s)); };
const kind = (v: unknown): unknown => record(v, ['kind'], Object.keys(v as object).filter(k => k !== 'kind')).kind;
const resultReasons = ['INPUT_INVALID','ORIGINAL_MISMATCH','ORIGINAL_INVALID','IDENTITY_INVALID','RECOVERY_UNAVAILABLE','DEADLINE_EXCEEDED','RESPONSE_INVALID','RESULT_UNAUTHENTICATED','OUTPUT_TOO_LARGE'];
const settlementReasons = ['INPUT_INVALID','ORIGINAL_MISMATCH','ORIGINAL_INVALID','VERIFICATION_UNAVAILABLE','TRANSACTION_UNCONFIRMED','CONFIRMATIONS_PENDING','RPC_EVIDENCE_UNKNOWN','TRANSACTION_REVERTED','SETTLEMENT_TERMS_MISMATCH'];
const scalarFields = (r: Record<string, unknown>, ids: string[], digests: string[], times: string[]) => { ids.forEach(k => id(r[k])); digests.forEach(k => digest(r[k])); times.forEach(k => integer(r[k])); };
function job(r: Record<string, unknown>, o: MonetaryOriginal, c?: MonetaryClaimReference | null) {
  if (r.jobId !== o.prepared.jobId || (r.preparedDigest !== undefined && r.preparedDigest !== o.prepared.receipt.preparedDigest) || (c && r.claimId !== undefined && r.claimId !== c.claimId) || (c && r.grantHash !== undefined && r.grantHash !== c.grantHash)) return invalid();
}
/** Fresh response disclosure: the original signing request must still be visible. */
export function wallet(value: unknown, o: MonetaryOriginal): Promise<MonetaryWalletClaim | MonetaryExistingClaim> {
  return decodeWallet(value,o,true);
}
/** Retained history only. All original/amount/typed-data/hash bindings remain;
 * this does not authorize a new wallet disclosure or extend the work deadline. */
export function retainedWallet(value: unknown, o: MonetaryOriginal): Promise<MonetaryWalletClaim | MonetaryExistingClaim> {
  return decodeWallet(value,o,false);
}
async function decodeWallet(value: unknown, o: MonetaryOriginal, freshDisclosure: boolean): Promise<MonetaryWalletClaim | MonetaryExistingClaim> {
  const v = snapshot(value);
  if (kind(v) === 'original-wallet-already-claimed') {
    const r = record(v,['kind','claimId','jobId','phase','possibleDisclosure','claimedAtMs']); job(r,o); id(r.claimId); integer(r.claimedAtMs);
    if (r.phase !== 'wallet_request_claimed' || r.possibleDisclosure !== true) return invalid(); return v as MonetaryExistingClaim;
  }
  const r = record(v,['kind','claimId','jobId','context','originalId','grant','amount','grantHash','typedData','request','typedDataFingerprint','requestFingerprint','claimedAtMs','disclosureNotAfterMs']);
  job(r,o); const a = o.approval, q = o.quoted.quote;
  if (r.kind !== 'original-wallet-request' || r.originalId !== o.prepared.jobId || !equal(parseContext(r.context),a.lineage.context) || r.amount !== a.terms.amountAtoms) return invalid();
  scalarFields(r,['claimId'],['grantHash','typedDataFingerprint','requestFingerprint'],['claimedAtMs','disclosureNotAfterMs']);
  if (Number(r.claimedAtMs) >= Number(r.disclosureNotAfterMs) || Number(r.disclosureNotAfterMs) > q.expiresAtMs || freshDisclosure && Date.now() >= Number(r.disclosureNotAfterMs)) return invalid();
  const g = record(r.grant,['schema','hirer_did','provider_did','provider_signing_pubkey_base64','provider_enc_pubkey_base64','offer_hash','capsule_hash','brief_commitment','price_chain','price_asset','price_payer_account','price_payee_account','price_min_amount','price_max_amount','nonce','issued_at','expires_at']);
  if (g.schema !== 'voidly-task-grant/v1' || g.hirer_did !== a.hirerDid || g.provider_did !== a.providerDid || g.provider_signing_pubkey_base64 !== a.providerSigningPublicKeyBase64 || g.provider_enc_pubkey_base64 !== a.providerEncryptionPublicKeyBase64 || g.price_chain !== MONETARY_CHAIN || g.price_asset !== MONETARY_ASSET || g.price_payer_account !== a.terms.payerAccount || g.price_payee_account !== a.terms.payeeAccount || g.price_min_amount !== a.terms.amountAtoms || g.price_max_amount !== a.terms.amountAtoms) return invalid();
  digest(g.offer_hash); digest(g.capsule_hash); digest(g.brief_commitment); if (text(g.nonce,256).length < 16) return invalid();
  if (iso(g.issued_at) < q.issuedAtMs || iso(g.expires_at) !== q.workNotAfterMs || iso(g.issued_at) >= iso(g.expires_at) || await sha256(canonical(g)) !== r.grantHash) return invalid();
  const t = record(r.typedData,['domain','types','primaryType','message']), m = record(t.message,['from','to','value','validAfter','validBefore','nonce']);
  const members = (rows: string[][]) => rows.map(([name,type]) => ({name,type}));
  const expected = {domain:{name:'USD Coin',version:'2',chainId:8453,verifyingContract:MONETARY_TOKEN},types:{EIP712Domain:members([['name','string'],['version','string'],['chainId','uint256'],['verifyingContract','address']]),ReceiveWithAuthorization:members([['from','address'],['to','address'],['value','uint256'],['validAfter','uint256'],['validBefore','uint256'],['nonce','bytes32']])},primaryType:'ReceiveWithAuthorization',message:{from:a.terms.payerAccount.slice(12),to:a.terms.payeeAccount.slice(12),value:a.terms.amountAtoms,validAfter:'0',validBefore:String(Math.floor(q.workNotAfterMs/1000)),nonce:`0x${await sha256('voidly-session-settlement-binding/v1|'+r.grantHash)}`}};
  if (!equal(t,expected) || !equal(m,expected.message)) return invalid();
  const req = record(r.request,['method','params']);
  if (req.method !== 'eth_signTypedData_v4' || !Array.isArray(req.params) || req.params.length !== 2 || req.params[0] !== expected.message.from || typeof req.params[1] !== 'string' || req.params[1] !== JSON.stringify(r.typedData) || await sha256(req.params[1]) !== r.typedDataFingerprint) return invalid();
  const fingerprint = await sha256(JSON.stringify({version:'voidpay.original-wallet-sign.v0',context:a.lineage.context,originalId:o.prepared.jobId,grantHash:r.grantHash,amount:r.amount,request:r.request}));
  if (fingerprint !== r.requestFingerprint || freshDisclosure && Date.now() >= Number(r.disclosureNotAfterMs)) return invalid();
  return v as MonetaryWalletClaim;
}
export function authorization(value: unknown, o: MonetaryOriginal, claimId: string): MonetaryAuthorizationStatus {
  if (value === null) return null;
  const v = snapshot(value), r = record(v,['kind','jobId','claimId','authorizationDigest','preparedDigest','acceptedAtMs']); job(r,o);
  if (r.kind !== 'original-authorization-accepted' || r.claimId !== claimId) return invalid();
  scalarFields(r,[],['authorizationDigest','preparedDigest'],['acceptedAtMs']); return v as MonetaryAuthorizationStatus;
}
export function submission(value: unknown, o: MonetaryOriginal, c: MonetaryClaimReference): MonetarySubmission {
  const v = snapshot(value), k = kind(v);
  const r = record(v,k === 'original-request-already-exposed' ? ['kind','jobId','exposureId','phase','possibleExposure','exposedAtMs','payment'] : ['kind','jobId','exposureId','grantHash','payment'],k === 'unresolved' ? ['reason'] : []);
  job(r,o,c); id(r.exposureId); if (r.payment !== 'unconfirmed') return invalid();
  if (k === 'original-request-already-exposed') { if (r.phase !== 'exposure_claimed' || r.possibleExposure !== true) return invalid(); integer(r.exposedAtMs); }
  else { if (k !== 'provider-accepted' && k !== 'unresolved') return invalid(); if (r.grantHash !== c.grantHash) return invalid(); if (r.reason !== undefined && !/^[A-Z_]{1,128}$/.test(text(r.reason,128))) return invalid(); }
  return v as MonetarySubmission;
}
function anchor(v: unknown, o: MonetaryOriginal, c: MonetaryClaimReference, paid = false) {
  const r = record(v,['purchaseId','preparedDigest','supplierManifestDigest','owner','intentId','quoteDigest','grantHash','termsDigest',...(paid ? ['grantId','grantDigest'] : [])]);
  const q = o.quoted.quote, p = o.prepared.receipt;
  if (r.purchaseId !== p.purchaseId || r.preparedDigest !== p.preparedDigest || r.supplierManifestDigest !== p.supplierManifestDigest || !equal(parseContext(r.owner),q.lineage.context) || r.quoteDigest !== o.quoted.quoteDigest || r.grantHash !== c.grantHash || r.termsDigest !== q.termsDigest || (paid && (r.grantId !== q.grantId || r.grantDigest !== q.grantDigest))) return invalid();
  id(r.intentId); return r;
}
async function delivery(v: unknown, o: MonetaryOriginal, c: MonetaryClaimReference) {
  const r = record(v,['receipt','signatureBase64']), d = record(r.receipt,['schema','grant_hash','offer_hash','provider_did','result_capsule_hash','result_commitment','issued_at','recoverable_until']);
  if (d.schema !== 'voidly-task-delivery/v1' || d.grant_hash !== c.grantHash || d.offer_hash !== c.offerHash || d.provider_did !== o.approval.providerDid) return invalid();
  digest(d.result_capsule_hash); digest(d.result_commitment); if (iso(d.recoverable_until) <= iso(d.issued_at)) return invalid();
  const hex = (s: string) => Array.from(atob(s),v => v.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  if (!await verifyEd25519Bytes(hex(o.approval.providerSigningPublicKeyBase64),hex(base64(r.signatureBase64,64)),new TextEncoder().encode(canonical(d)))) return invalid();
  return {r,d};
}
export async function recovery(value: unknown, o: MonetaryOriginal, c: MonetaryClaimReference | null): Promise<MonetaryRecovery> {
  const v = snapshot(value), r = record(v,['kind','jobId','settlement','delivery','result'],['budgetRecovery']); job(r,o);
  if (r.kind !== 'original-monetary-recovery') return invalid();
  if (r.budgetRecovery !== undefined) {
    const k = kind(r.budgetRecovery), b = record(r.budgetRecovery,k === 'original-expired-unused-released' ? ['kind','jobId','claimId','releaseId','preparedDigest','amountAtoms','recordedAtMs','evidenceDigest','finalizedBlock'] : ['kind','jobId','reason']); job(b,o,c);
    if (k === 'original-expired-unused-released') {
      scalarFields(b,['claimId','releaseId'],['preparedDigest','evidenceDigest'],['recordedAtMs']);
      const f = record(b.finalizedBlock,['number','hash','timestamp']); tx(f.hash); integer(f.timestamp);
      if (!/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(text(f.number,18)) || Number(f.timestamp) < Math.floor(o.quoted.quote.workNotAfterMs/1000) || b.amountAtoms !== o.approval.terms.amountAtoms || !equal(r.settlement,{kind:'not-checked'}) || r.delivery !== null || !equal(r.result,{kind:'not-started',reason:'AUTHORIZATION_EXPIRED_UNUSED'})) return invalid();
      return v as MonetaryRecovery;
    }
    if (k !== 'original-expired-unused-pending' || !['ORIGINAL_NOT_ELIGIBLE','ORIGINAL_UNAVAILABLE','FINALITY_PENDING','AUTHORIZATION_NOT_UNUSED','RPC_EVIDENCE_UNKNOWN','RPC_TIMEOUT','INPUT_INVALID'].includes(text(b.reason,64))) return invalid();
  }
  let settlementExposure: unknown, deliveredExposure: unknown, deliveredDigest: unknown, openedDigest: unknown, openedLength: unknown;
  const sk = kind(r.settlement);
  if (sk === 'not-checked') record(r.settlement,['kind']);
  else if (sk === 'original-settlement-accounted') {
    if (!c) return invalid();
    const s = record(r.settlement,['kind','jobId','settlementId','claimId','exposureId','tx','authLogIndex','transferLogIndex','amountAtoms','recordedAtMs','evidenceDigest','evidence']); job(s,o,c);
    scalarFields(s,['claimId','exposureId'],['settlementId','evidenceDigest'],['authLogIndex','transferLogIndex','recordedAtMs']); tx(s.tx);
    const e = record(s.evidence,['ok','tx','grantHash','nonce','authorizer','payer','payee','value','authLogIndex','transferLogIndex','blockNumber','confirmations','assurance','chain','terms','rpcHosts','unpinnedHosts','unpinned','headOperators','headFrom']);
    const payer = o.approval.terms.payerAccount.slice(12), payee = o.approval.terms.payeeAccount.slice(12);
    if (s.amountAtoms !== o.approval.terms.amountAtoms || e.ok !== true || e.tx !== s.tx || e.grantHash !== c.grantHash || e.nonce !== `0x${await sha256('voidly-session-settlement-binding/v1|'+c.grantHash)}` || e.authorizer !== payer || e.payer !== payer || e.payee !== payee || e.value !== s.amountAtoms || e.authLogIndex !== s.authLogIndex || e.transferLogIndex !== s.transferLogIndex || e.chain !== '0x2105') return invalid();
    if (s.settlementId !== await sha256(JSON.stringify(['voidpay.monetary-settlement.v0',MONETARY_CHAIN,MONETARY_ASSET,s.tx,s.authLogIndex,s.transferLogIndex]))) return invalid();
    integer(e.blockNumber); integer(e.confirmations,12); integer(e.headOperators,2,8); text(e.headFrom,2048);
    const a = record(e.assurance,['level','confirmationBasis','safe','finalized','requiredConfirmations']); integer(a.requiredConfirmations,12);
    if (a.level !== 'rpc-quorum-inclusion' || a.confirmationBasis !== 'lowest-latest-head' || a.safe !== 'not-checked' || a.finalized !== 'not-checked' || Number(e.confirmations) < Number(a.requiredConfirmations)) return invalid();
    for (const field of ['rpcHosts','unpinnedHosts']) { const list=e[field]; if (!Array.isArray(list) || list.length>8 || list.some(x=> typeof x !== 'string' || !/^[a-z0-9.:-]{1,253}$/.test(x))) return invalid(); }
    if (e.unpinned !== false || (e.unpinnedHosts as unknown[]).length !== 0 || (e.rpcHosts as unknown[]).length < 2) return invalid();
    const t = record(e.terms,['source'],['expiresAt','band']); if (t.source !== 'grant') return invalid(); if (iso(t.expiresAt) !== o.quoted.quote.workNotAfterMs) return invalid(); const band = record(t.band,['min','max']); if (band.min !== s.amountAtoms || band.max !== s.amountAtoms) return invalid();
    settlementExposure = s.exposureId;
  } else {
    const s = record(r.settlement,['version','kind','original','candidateTx','reason']);
    if (!['unconfirmed','unknown','refused'].includes(String(sk)) || s.version !== 'voidpay.monetary-settlement.v0' || !settlementReasons.includes(String(s.reason))) return invalid();
    if (s.candidateTx !== null) tx(s.candidateTx); if (s.original !== null) { if (!c) return invalid(); anchor(s.original,o,c,true); }
  }
  if (r.delivery !== null) {
    if (!c) return invalid();
    const d = record(r.delivery,['kind','jobId','claimId','exposureId','preparedDigest','receiptDigest','delivery','recordedAtMs','output']); job(d,o,c);
    if (d.kind !== 'original-delivery-recorded') return invalid(); scalarFields(d,['claimId','exposureId'],['preparedDigest','receiptDigest'],['recordedAtMs']);
    const checked = await delivery(d.delivery,o,c); if (await sha256(canonical(checked.d)) !== d.receiptDigest) return invalid();
    deliveredExposure=d.exposureId; deliveredDigest=d.receiptDigest;
    if (d.output !== null) { const out=record(d.output,['digest','byteLength','recordedAtMs']); digest(out.digest); integer(out.byteLength,0,65536); integer(out.recordedAtMs); openedDigest=out.digest; openedLength=out.byteLength; }
  }
  if (settlementExposure !== undefined && deliveredExposure !== undefined && settlementExposure !== deliveredExposure) return invalid();
  if (!equal(r.result,{kind:'unknown',reason:'ORIGINAL_UNAVAILABLE'})) {
    const k = kind(r.result), keys = ['version','kind','original',...(['opened','locked'].includes(String(k)) ? ['delivery'] : []),...(k === 'opened' ? ['result','outputDigest','outputByteLength'] : []),...(['unknown','refused'].includes(String(k)) ? ['reason'] : [])];
    const out=record(r.result,keys,['settlementCandidate']);
    if (out.version !== 'voidpay.monetary-result-recovery.v0' || !['opened','locked','no-result','unknown','refused'].includes(String(k))) return invalid();
    if (out.original !== null) { if (!c) return invalid(); anchor(out.original,o,c); } else if (k !== 'unknown' && k !== 'refused') return invalid();
    if (out.reason !== undefined && !resultReasons.includes(String(out.reason))) return invalid();
    if (out.settlementCandidate !== undefined) { const hint=record(out.settlementCandidate,['tx','source']); tx(hint.tx); if (hint.source !== 'rail-recovery') return invalid(); }
    if (k === 'opened' || k === 'locked') {
      if (!c) return invalid(); const d=await delivery(out.delivery,o,c);
      if (deliveredDigest !== undefined && await sha256(canonical(d.d)) !== deliveredDigest) return invalid();
      if (k === 'opened') {
        const result=text(out.result,65536), size=new TextEncoder().encode(result).length;
        if (digest(out.outputDigest) !== await sha256(result) || integer(out.outputByteLength,0,65536) !== size || (openedDigest !== undefined && (openedDigest !== out.outputDigest || openedLength !== size))) return invalid();
      }
    }
  }
  return v as MonetaryRecovery;
}
