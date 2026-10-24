"""Local-only operator/capture tests. All credentials and source files are synthetic."""
from pathlib import Path
import datetime,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,time,unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('owned_under_test',ROOT/'scripts/protected-state-d1-owned.py');op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)
spec=importlib.util.spec_from_file_location('capture_under_test',ROOT/'scripts/lib/capture_owned.py');cap=importlib.util.module_from_spec(spec);spec.loader.exec_module(cap)
NODE=shutil.which('node')
TOKEN='SYNTHETIC-RESTORE-TOKEN-'*3

def write(path,value):
 with path.open('x') as f:f.write(json.dumps(value)+'\n')
 os.chmod(path,0o600)
def expiry():return (datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).isoformat()
def prepared(root):
 root.chmod(0o700)
 for name in ['protected','cutover']: (root/name).mkdir(mode=0o700)
 target={'format':1,'stageOnly':True,'stageId':'stage-owned-fixture','accountId':'a'*32,'d1Id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','r2Bucket':'owned-stage-fixture','adminUrl':'http://127.0.0.1:1'}
 write(root/'target.json',target);write(root/'token.json',{'RESTORE_TOKEN':TOKEN});write(root/'protected/manifest.json',{'pagesSha256':'a'*64})
 admission={'targetSha256':op.digest(json.dumps(target,separators=(',',':')).encode()),'compactPlanSha256':'b'*64,'compactPlan':{'pagesSha256':'c'*64}};write(root/'admission.json',admission)
 c={'format':1,'mode':'full','window':1,'directory':str(root/'protected'),'manifestSha256':op.sha_file(root/'protected/manifest.json'),'admissionPath':str(root/'admission.json'),'admissionSha256':'e'*64,'admissionFileSha256':op.sha_file(root/'admission.json'),'cutoverBundle':str(root/'cutover'),'targetFile':str(root/'target.json'),'journalDirectory':str(root/'journal'),'credentialFile':str(root/'token.json')}
 write(root/'inputs.json',c);return c

class OperatorTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.cache=Path(tempfile.mkdtemp(prefix='protected-owned-prepared-',dir='/private/tmp'));prepared(cls.cache)
  r=cap.capture_owned([NODE,str(ROOT/'scripts/build-protected-state-d1-owned.mjs'),'--inputs',str(cls.cache/'inputs.json'),'--bun',str(Path(shutil.which('bun')).resolve())],ROOT,{'PATH':'/usr/bin:/bin','HOME':str(cls.cache)},cls.cache/'build.log',timeout=30,max_bytes=2097152)
  if not op.successful(r):raise AssertionError('Actual fixed builder failed: '+(cls.cache/'build.log').read_text())
  cls.base=op.private_json(cls.cache/'journal.owned/window-000001.review-template.json');cls.bundle=(cls.cache/'journal.owned/protected-state-d1.mjs').read_bytes();cls.manifest=(cls.cache/'journal.owned/bundle-manifest.json').read_bytes()
 @classmethod
 def tearDownClass(cls):shutil.rmtree(cls.cache)
 def setUp(self):
  self.root=Path(tempfile.mkdtemp(prefix='protected-owned-unit-',dir='/private/tmp'));self.c=prepared(self.root);self.registry=self.root/'journal.owned';self.registry.mkdir(mode=0o700);(self.registry/'home').mkdir(mode=0o700)
  for name,b in [('protected-state-d1.mjs',self.bundle),('bundle-manifest.json',self.manifest)]: (self.registry/name).write_bytes(b);(self.registry/name).chmod(0o600)
  self.r=json.loads(json.dumps(self.base));self.r.update(authority='trusted-parent-review',executeOneWindow=True,validUntil=expiry());self.r['inputs']={k:self.c[k] for k in ['directory','manifestSha256','admissionPath','admissionSha256','admissionFileSha256','cutoverBundle','targetFile','journalDirectory']};self.r['inputs']['targetFileSha256']=op.sha_file(self.root/'target.json');self.r['credential']=op.credential_metadata(self.root/'token.json');self.review=self.registry/'window-000001.reviewed.json';write(self.review,self.r)
  self.calls=[];self.selected=0
 def tearDown(self):shutil.rmtree(self.root)
 def select(self,r):
  self.selected+=1;self.assertTrue((self.registry/'window-000001/execution.intent.json').exists());return op.credential(r)
 def capture(self,argv,cwd,env,log,timeout,max_bytes):
  execution='--execute-window' in argv;version='--version' in argv;self.calls.append('runtime' if version else 'execution' if execution else 'inspection');self.assertEqual(argv if version else argv[:3],[self.r['runtime']['path'],'--no-env-file','--version'] if version else [self.r['runtime']['path'],'--no-env-file',str(self.registry/'protected-state-d1.mjs')]);self.assertEqual(cwd,ROOT);self.assertEqual(timeout,5 if version else 330 if execution else 300);self.assertEqual(max_bytes,4096 if version else 65536 if not execution else 2097152-(self.registry/'window-000001/runtime.log').stat().st_size-(self.registry/'window-000001/inspection.log').stat().st_size);self.assertEqual(set(env),{'HOME','PATH','LANG','TZ'}|({'RESTORE_TOKEN'} if execution else set()))
  if version:
   with log.open('x') as stream:stream.write('1.3.5\n')
   log.chmod(0o600);return {'exitCode':0,'timedOut':False,'logBoundExceeded':False,'localFailure':False,'ownedProcessSettled':True,'childPid':123}
  if execution:
   self.assertEqual(env['RESTORE_TOKEN'],TOKEN);j=self.root/'journal';j.mkdir(mode=0o700);write(j/'plan.json',{'format':1,'planSha256':self.r['planSha256']});w=j/'window-000001';w.mkdir(mode=0o700)
   value={'format':1,'planSha256':self.r['planSha256'],'window':1,'outcome':'bounded','attempts':1,'limits':self.r['limits']};write(w/'result.json',value);write(w/'accepted.json',{'format':1,'resultSha256':op.sha_file(w/'result.json')})
  else:value={'format':1,'execute':False,'planSha256':self.r['planSha256'],'pins':{'targetSha256':self.r['target'] and op.digest(json.dumps(self.r['target'],separators=(',',':')).encode()),'slice':'full-copy-v1'}}
  write(log,value);return {'exitCode':0,'timedOut':False,'logBoundExceeded':False,'localFailure':False,'ownedProcessSettled':True,'childPid':123}
 def test_real_builder_pins_physical_graph_and_preserves_private_root(self):
  m=json.loads(self.manifest);self.assertEqual(m['entry'],'scripts/protected-state-d1.ts');self.assertEqual(m['dirnameOverride']['uses'],[{'path':'scripts/lib/protected-state.ts','count':1}]);self.assertIn('node_modules/esbuild/package.json',m['aliases']);self.assertEqual(op.digest(self.bundle),m['bundlePin']['sha256']);self.assertIn(str(ROOT/'scripts/lib').encode(),self.bundle)
 def test_only_one_explicit_window_seals_then_reads_key(self):
  with patch.dict(os.environ,{'PATH':'/hostile/no-bun','BUN_OPTIONS':'--preload /never-run'}):result=op.execute(self.review,self.capture,self.select)
  self.assertTrue(result['passed']);self.assertEqual(self.calls,['runtime','inspection','execution']);self.assertEqual(self.selected,1)
  raw=''.join(p.read_text() for p in (self.registry/'window-000001').iterdir() if p.is_file());self.assertNotIn(TOKEN,raw);self.assertTrue((self.registry/'window-000001/accepted.json').exists())
  with self.assertRaises(ValueError):op.execute(self.review,self.capture,self.select)
  self.assertEqual(self.selected,1)
 def test_inspection_failure_never_selects_key_or_creates_execution_intent(self):
  def capture(*args,**kwargs):r=self.capture(*args,**kwargs);r['exitCode']=1 if self.calls[-1]=='inspection' else 0;return r
  self.assertFalse(op.execute(self.review,capture,self.select)['passed']);self.assertEqual(self.selected,0);self.assertEqual(self.calls,['runtime','inspection']);self.assertFalse((self.registry/'window-000001/execution.intent.json').exists())
 def test_review_drift_after_inspection_preserves_lock_before_key(self):
  def capture(*args,**kwargs):
   r=self.capture(*args,**kwargs)
   if self.calls[-1]=='inspection':self.review.write_text(json.dumps({**self.r,'validUntil':expiry()+'x'}))
   return r
  self.assertFalse(op.execute(self.review,capture,self.select)['passed']);self.assertEqual(self.selected,0);self.assertTrue((self.registry/'window-000001/started.json').exists())
 def test_source_manifest_drift_after_inspection_precedes_key(self):
  def capture(*args,**kwargs):
   r=self.capture(*args,**kwargs)
   if self.calls[-1]=='inspection':(self.root/'protected/manifest.json').write_text('PRIVATE changed source')
   return r
  self.assertFalse(op.execute(self.review,capture,self.select)['passed']);self.assertEqual(self.selected,0);self.assertEqual(self.calls,['runtime','inspection'])
 def test_other_runtime_or_excess_limits_never_spawn(self):
  self.r['runtime']['path']='/bin/sh';self.review.write_text(json.dumps(self.r))
  with self.assertRaises(ValueError):op.execute(self.review,self.capture,self.select)
  self.assertEqual(self.calls,[]);self.assertEqual(self.selected,0)
 def test_complete_prior_owned_receipts_are_required_even_with_new_review(self):
  self.assertTrue(op.execute(self.review,self.capture,self.select)['passed']);r={**self.r,'window':2};op.prior_windows(r,self.registry)
  (self.root/'journal/window-000001/result.json').write_text('{}')
  with self.assertRaises(ValueError):op.prior_windows(r,self.registry)
 def test_bundle_drift_is_refused_before_inspection_or_key(self):
  (self.registry/'protected-state-d1.mjs').write_text('PRIVATE changed')
  with self.assertRaises(ValueError):op.execute(self.review,self.capture,self.select)
  self.assertEqual(self.selected,0);self.assertEqual(self.calls,[])
 def test_pending_owned_group_has_no_accepted_marker_or_future_window(self):
  def capture(*args,**kwargs):r=self.capture(*args,**kwargs);r.update(exitCode=1,ownedProcessSettled=False);return r
  self.assertFalse(op.execute(self.review,capture,self.select)['passed']);self.assertFalse((self.registry/'window-000001/accepted.json').exists());self.assertEqual(self.selected,0)
  r={**self.r,'window':2};review=self.registry/'window-000002.reviewed.json';write(review,r)
  with self.assertRaises(ValueError):op.execute(review,self.capture,self.select)
  self.assertEqual(self.selected,0)
 def test_invalid_stage_target_is_refused_before_inspection(self):
  self.r['target']['d1Id']='8056b1a0-f858-4f89-a332-91f7f350eb7b';self.review.write_text(json.dumps(self.r))
  with self.assertRaises(ValueError):op.execute(self.review,self.capture,self.select)
  self.assertEqual(self.selected,0);self.assertEqual(self.calls,[])
 def test_global_config_checks_are_metadata_only(self):
  with patch.object(op.Path,'glob',return_value=[ROOT/'.env.fake']):
   with self.assertRaises(ValueError):op.execute(self.review,self.capture,self.select)
  self.assertEqual(self.selected,0)
 def test_private_key_metadata_and_payload_are_exact(self):
  self.assertEqual(op.credential(self.r),TOKEN);(self.root/'token.json').chmod(0o644)
  with self.assertRaises(ValueError):op.credential(self.r)
 def test_partial_result_persistence_failure_blocks_reentry(self):
  original=op.exclusive
  def fail(path,value):
   if path.name=='result.json':
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:os.write(fd,b'{"partial":')
    finally:os.close(fd)
    raise OSError('PRIVATE persistence failure')
   return original(path,value)
  with patch.object(op,'exclusive',side_effect=fail):result=op.execute(self.review,self.capture,self.select)
  self.assertFalse(result['passed']);self.assertTrue(result['receiptPersistenceUncertain']);self.assertFalse((self.registry/'window-000001/accepted.json').exists());self.assertEqual((self.registry/'window-000001/result.json').read_bytes(),b'{"partial":')
  with self.assertRaises(ValueError):op.execute(self.review,self.capture,self.select)
 def test_expired_review_does_not_create_attempt(self):
  self.r['validUntil']=datetime.datetime.now(datetime.timezone.utc).isoformat();self.review.write_text(json.dumps(self.r))
  with self.assertRaises(ValueError):op.execute(self.review,self.capture,self.select)
  self.assertFalse((self.registry/'window-000001').exists());self.assertEqual(self.selected,0)
 def test_acceptance_write_then_failure_permanently_fences_next_window(self):
  original=op.exclusive
  def fail(path,value):
   result=original(path,value)
   if path.name=='accepted.json' and path.parent.parent==self.registry:raise OSError('PRIVATE after marker write')
   return result
  with patch.object(op,'exclusive',side_effect=fail):result=op.execute(self.review,self.capture,self.select)
  own=self.registry/'window-000001';self.assertFalse(result['passed']);self.assertTrue(result['receiptPersistenceUncertain']);self.assertTrue((own/'accepted.json').exists());self.assertTrue((own/'receipt-uncertain.json').exists())
  self.assertTrue(op.private_json(own/'result.json')['passed'])
  with self.assertRaisesRegex(ValueError,'PROTECTED_OWNED_PRIOR_UNCERTAINTY'):op.prior_windows({**self.r,'window':2},self.registry)
  # Admission depends on fence presence, including an incomplete local write.
  (own/'receipt-uncertain.json').write_bytes(b'')
  with self.assertRaisesRegex(ValueError,'PROTECTED_OWNED_PRIOR_UNCERTAINTY'):op.prior_windows({**self.r,'window':2},self.registry)
 def test_acceptance_parent_fsync_failure_leaves_failclosed_fence(self):
  original=op.sync_dir;own=self.registry/'window-000001'
  def fail(path):
   if path==own and (own/'accepted.json').exists():raise OSError('PRIVATE parent fsync failure')
   return original(path)
  with patch.object(op,'sync_dir',side_effect=fail):result=op.execute(self.review,self.capture,self.select)
  self.assertFalse(result['passed']);self.assertTrue(result['receiptPersistenceUncertain']);self.assertTrue((own/'accepted.json').exists());self.assertTrue((own/'receipt-uncertain.json').exists())
  with self.assertRaisesRegex(ValueError,'PROTECTED_OWNED_PRIOR_UNCERTAINTY'):op.prior_windows({**self.r,'window':2},self.registry)

class CaptureTests(unittest.TestCase):
 def setUp(self):self.root=Path(tempfile.mkdtemp(prefix='protected-capture-',dir='/private/tmp'));self.root.chmod(0o700)
 def tearDown(self):shutil.rmtree(self.root)
 def capture(self,program,**kw):return cap.capture_owned([sys.executable,'-I','-c',program],self.root,{'PATH':'/usr/bin:/bin'},self.root/'process.log',**kw)
 def test_actual_short_process_and_minimal_environment(self):
  r=self.capture('import os;print(sorted(os.environ))');self.assertTrue(op.successful(r));self.assertNotIn('RESTORE_TOKEN',(self.root/'process.log').read_text());self.assertEqual((self.root/'process.log').stat().st_mode&0o777,0o600)
 def test_actual_deadline_cancels_owned_process(self):
  r=self.capture('import time;time.sleep(60)',timeout=.1);self.assertTrue(r['timedOut']);self.assertTrue(r['ownedProcessSettled'])
 def test_actual_log_cap(self):
  r=self.capture('print("x"*100000)',timeout=2,max_bytes=128);self.assertTrue(r['logBoundExceeded']);self.assertTrue(r['ownedProcessSettled']);self.assertEqual((self.root/'process.log').stat().st_size,128)
 def test_actual_log_io_failure_settles_group(self):
  def fail(stream,block):raise OSError('PRIVATE')
  r=self.capture('import time;print("ready",flush=True);time.sleep(60)',timeout=2,write_chunk=fail);self.assertTrue(r['localFailure']);self.assertTrue(r['ownedProcessSettled'])
 def test_exclusive_log_is_not_overwritten(self):
  (self.root/'process.log').write_bytes(b'preserved');r=self.capture('print("never")',timeout=2);self.assertTrue(r['localFailure']);self.assertIsNone(r['childPid']);self.assertEqual((self.root/'process.log').read_bytes(),b'preserved')

if __name__=='__main__':unittest.main()
