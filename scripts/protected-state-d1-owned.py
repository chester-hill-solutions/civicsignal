"""One reviewed staging client window. Run with Python -I -B; no implicit retry.

The fixed bundle is prepared locally from scripts/protected-state-d1.ts. A five-
second version proof precedes 300-second inspection and 330-second execution, each
followed by
at most ten seconds of owned-group cleanup. Local filesystem calls are not
preemptible. No accepted marker is issued after an observed review expiry.
"""
from pathlib import Path
import datetime,hashlib,importlib.util,json,os,pwd,re,stat,sys,time
ROOT=Path(__file__).resolve().parent.parent
CAPTURE_SHA='e262416e5ca9d25b37f869f238b5cbffe3d71c9ac178eb1bc4191b45fd367455'
INSPECTION_SECONDS=300
EXECUTION_SECONDS=330
VERSION_SECONDS=5
CLEANUP_SECONDS=10
LOG_BYTES=2097152

def require(value,code='PROTECTED_OWNED_REFUSED'):
 if not value:raise ValueError(code)
def digest(value):return hashlib.sha256(value).hexdigest()
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def date(value):
 require(isinstance(value,str),'PROTECTED_OWNED_REVIEW_EXPIRY')
 parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'));require(parsed.tzinfo is not None,'PROTECTED_OWNED_REVIEW_EXPIRY');return parsed.timestamp()
def private_dir(path):
 s=path.lstat();require(path.is_absolute() and path.resolve()==path and stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700,'PROTECTED_OWNED_PRIVATE_DIRECTORY')
def private_path(value,directory=False):
 require(isinstance(value,str),'PROTECTED_OWNED_PRIVATE_PATH');p=Path(value);require(p.is_absolute() and str(p)==value and p.resolve()==p and p!=ROOT and ROOT not in p.parents,'PROTECTED_OWNED_PRIVATE_PATH')
 if directory:private_dir(p)
 else:private_dir(p.parent)
 return p
def private_bytes(path,limit=65536):
 private_path(str(path));s=path.lstat();require(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=limit,'PROTECTED_OWNED_PRIVATE_FILE')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  before=os.fstat(fd);require((before.st_dev,before.st_ino)==(s.st_dev,s.st_ino),'PROTECTED_OWNED_FILE_DRIFT');data=os.read(fd,limit+1);after=os.fstat(fd)
 finally:os.close(fd)
 require(len(data)<=limit and len(data)==s.st_size and (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'PROTECTED_OWNED_FILE_DRIFT');return data
def private_json(path,limit=65536):return json.loads(private_bytes(path,limit))
def sync_dir(path):
 fd=os.open(path,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
def exclusive(path,value):
 private_dir(path.parent);b=(json.dumps(value,separators=(',',':'))+'\n').encode();fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  offset=0
  while offset<len(b):n=os.write(fd,b[offset:]);require(n>0,'PROTECTED_OWNED_SHORT_WRITE');offset+=n
  os.fsync(fd)
 finally:os.close(fd)
 sync_dir(path.parent);return digest(b)
def sha_file(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1048576),b''):h.update(block)
 return h.hexdigest()
def pin(path,expected):
 s=path.lstat();require(path.resolve()==path and stat.S_ISREG(s.st_mode) and s.st_size==expected['bytes'] and sha_file(path)==expected['sha256'],'PROTECTED_OWNED_CODE_DRIFT')
def successful(value):return value.get('exitCode')==0 and all(value.get(k) is False for k in ['timedOut','logBoundExceeded','localFailure']) and value.get('ownedProcessSettled') is True

def checked_target(value):
 from urllib.parse import urlsplit
 keys=['format','stageOnly','stageId','accountId','d1Id','r2Bucket','adminUrl'];require(isinstance(value,dict) and set(value)==set(keys),'PROTECTED_OWNED_TARGET')
 require(value['format']==1 and value['stageOnly'] is True and re.fullmatch(r'stage-[a-z0-9][a-z0-9-]{0,55}',value['stageId']) and re.fullmatch('[a-f0-9]{32}',value['accountId']) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',value['d1Id']) and value['d1Id']!='8056b1a0-f858-4f89-a332-91f7f350eb7b' and re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',value['r2Bucket']) and 'stage' in value['r2Bucket'] and value['r2Bucket']!='civicsignal-corpus','PROTECTED_OWNED_TARGET')
 u=urlsplit(value['adminUrl']);local=u.hostname in ['localhost','127.0.0.1','::1'];require(not u.username and not u.password and not u.query and not u.fragment and not u.path and (local and u.scheme in ['http','https'] or not local and u.scheme=='https' and re.fullmatch(r'civicsignal-v1-stage-restore-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev',u.hostname or '') and u.port is None),'PROTECTED_OWNED_TARGET');return value

def startup_absence(registry):
 home=Path(pwd.getpwuid(os.getuid()).pw_dir);paths=[ROOT/'bunfig.toml',ROOT/'bunfig.json',home/'.bunfig.toml',home/'.config/bunfig.toml',home/'.config/.bunfig.toml',home/'.bun/bunfig.toml',registry/'home/.bunfig.toml',registry/'home/.config/bunfig.toml',registry/'home/.config/.bunfig.toml',registry/'home/.bun/bunfig.toml']
 require(not list(ROOT.glob('.env*')) and all(not os.path.lexists(p) for p in paths),'PROTECTED_OWNED_STARTUP_CONFIG');private_dir(registry/'home')
 return {'rootEnvFiles':0,'rootBunConfigFiles':0,'globalBunConfigFiles':0,'privateHomeEntries':len(list((registry/'home').iterdir())),'metadataOnly':True}
def child_env(registry,token=None):
 env={'HOME':str(registry/'home'),'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','TZ':'UTC'}
 if token is not None:env['RESTORE_TOKEN']=token
 return env

def validate_current(review_path,original,reserve=0):
 require(private_bytes(review_path)==original,'PROTECTED_OWNED_REVIEW_DRIFT');r=json.loads(original)
 require(r['authority']=='trusted-parent-review' and r['executeOneWindow'] is True and r['automaticNextWindow'] is False and r['allowanceExtension'] is False and r['workspace']==str(ROOT),'PROTECTED_OWNED_REVIEW')
 require(time.time()+reserve<date(r['validUntil'])<=time.time()+86400,'PROTECTED_OWNED_REVIEW_EXPIRY')
 require(r['operatorSha256']==sha_file(Path(__file__).resolve()) and r['captureSha256']==CAPTURE_SHA,'PROTECTED_OWNED_CODE_DRIFT')
 helper=ROOT/'scripts/lib/capture_owned.py';require(sha_file(helper)==CAPTURE_SHA,'PROTECTED_OWNED_CODE_DRIFT')
 runtime=r['runtime'];require(runtime['kind']=='bun' and runtime['version']=='1.3.5' and isinstance(runtime['path'],str),'PROTECTED_OWNED_RUNTIME');binary=Path(runtime['path']);require(binary.is_absolute() and str(binary)==runtime['path'] and binary.resolve()==binary,'PROTECTED_OWNED_RUNTIME');pin(binary,runtime);require(binary.stat().st_uid in [0,os.getuid()] and not binary.stat().st_mode&0o022 and os.access(binary,os.X_OK),'PROTECTED_OWNED_RUNTIME')
 for path,expected in [(Path(r['inputs']['directory'])/'manifest.json',r['inputs']['manifestSha256']),(Path(r['inputs']['admissionPath']),r['inputs']['admissionFileSha256']),(Path(r['inputs']['targetFile']),r['inputs']['targetFileSha256'])]:require(digest(private_bytes(path,16384))==expected,'PROTECTED_OWNED_INPUT_DRIFT')
 registry=Path(r['inputs']['journalDirectory']+'.owned');private_path(str(registry),True);startup_absence(registry)
 raw=private_bytes(registry/'bundle-manifest.json',1048576);require(digest(raw)==r['bundleManifestSha256'],'PROTECTED_OWNED_CODE_DRIFT');m=json.loads(raw)
 require(m['format']==1 and m['preparedOnly'] is True and m['root']==str(ROOT) and m['entry']=='scripts/protected-state-d1.ts' and m['bundle']=='protected-state-d1.mjs' and m['bundlePin']['sha256']==r['bundleSha256'] and m['options']=={'format':'esm','platform':'node','target':'esnext','conditions':['bun','import'],'legalComments':'none'} and m['dirnameOverride']=={'value':str(ROOT/'scripts/lib'),'uses':[{'path':'scripts/lib/protected-state.ts','count':1}]},'PROTECTED_OWNED_BUNDLE')
 require(set(m['aliases'])=={'node_modules/esbuild/package.json'},'PROTECTED_OWNED_BUNDLE')
 for alias,physical in m['aliases'].items():require(not Path(physical).is_absolute() and '..' not in Path(physical).parts and (ROOT/alias).resolve()==ROOT/physical and physical in m['files'],'PROTECTED_OWNED_CODE_PATH')
 for name,expected in m['files'].items():require(not Path(name).is_absolute() and '..' not in Path(name).parts,'PROTECTED_OWNED_CODE_PATH');pin(ROOT/name,expected)
 require('scripts/protected-state-d1.ts' in m['files'] and 'scripts/build-protected-state-d1-owned.mjs' in m['files'],'PROTECTED_OWNED_BUNDLE');require(digest(private_bytes(registry/'protected-state-d1.mjs',8388608))==r['bundleSha256'],'PROTECTED_OWNED_BUNDLE');pin(registry/'protected-state-d1.mjs',m['bundlePin'])
 return r,registry

def credential_metadata(path):
 private_path(str(path));s=path.lstat();require(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=4096,'PROTECTED_OWNED_CREDENTIAL_FILE')
 return {'path':str(path),'dev':str(s.st_dev),'ino':str(s.st_ino),'size':s.st_size,'mtimeNs':str(s.st_mtime_ns),'uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode)}
def credential(r):
 p=Path(r['credential']['path']);require(credential_metadata(p)==r['credential'],'PROTECTED_OWNED_CREDENTIAL_DRIFT');value=private_json(p,4096);require(credential_metadata(p)==r['credential'] and isinstance(value,dict) and set(value)=={'RESTORE_TOKEN'} and isinstance(value['RESTORE_TOKEN'],str) and re.fullmatch(r'[\x21-\x7e]{32,512}',value['RESTORE_TOKEN']),'PROTECTED_OWNED_CREDENTIAL');return value['RESTORE_TOKEN']

def arguments(r,registry,execute=False):
 i=r['inputs'];args=[r['runtime']['path'],'--no-env-file',str(registry/'protected-state-d1.mjs')]
 if r['mode']=='full':args.append('--full-phases')
 for key,name in [('directory','--directory'),('manifestSha256','--manifest-sha256'),('admissionPath','--admission'),('admissionSha256','--admission-sha256'),('admissionFileSha256','--admission-file-sha256'),('cutoverBundle','--cutover'),('targetFile','--target')]:args.extend([name,str(i[key])])
 if execute:
  args.extend(['--execute-window','--journal',i['journalDirectory']])
  for key,flag in [('maxRequests','--max-requests'),('wallMs','--wall-ms'),('requestMs','--request-ms')]:args.extend([flag,str(r['limits'][key])])
 return args

def prior_windows(r,registry):
 n=r['window'];require(type(n) is int and 1<=n<=100000,'PROTECTED_OWNED_WINDOW');journal=Path(r['inputs']['journalDirectory']);private_path(str(journal.parent),True)
 own=sorted(p.name for p in registry.iterdir() if p.is_dir() and p.name!='home');require(own==['window-%06d'%i for i in range(1,n)],'PROTECTED_OWNED_PRIOR_ATTEMPT')
 if journal.exists():
  private_path(str(journal),True);require(sorted(p.name for p in journal.iterdir())==['plan.json']+['window-%06d'%i for i in range(1,n)],'PROTECTED_OWNED_CLIENT_HISTORY');require(private_json(journal/'plan.json')['planSha256']==r['planSha256'],'PROTECTED_OWNED_CLIENT_HISTORY')
 else:require(n==1,'PROTECTED_OWNED_CLIENT_HISTORY')
 for index in range(1,n):
  own_dir=registry/('window-%06d'%index);private_dir(own_dir)
  # Even an empty/partial fence is terminal. Never parse, remove or repair it.
  require(not os.path.lexists(own_dir/'receipt-uncertain.json'),'PROTECTED_OWNED_PRIOR_UNCERTAINTY')
  accepted=private_json(own_dir/'accepted.json');raw=private_bytes(own_dir/'result.json');result=json.loads(raw)
  require(accepted['resultSha256']==digest(raw) and result['passed'] is True and result['window']==index and result['planSha256']==r['planSha256'] and successful(result['execution']) and result['receiptPersistenceUncertain'] is False and not os.path.lexists(own_dir/'acceptance-expired.json'),'PROTECTED_OWNED_PRIOR_ATTEMPT')
  client=journal/('window-%06d'%index);require(digest(private_bytes(client/'result.json'))==result['clientResultSha256'] and digest(private_bytes(client/'accepted.json'))==result['clientAcceptedSha256'] and not os.path.lexists(client/'acceptance-expired.json'),'PROTECTED_OWNED_CLIENT_HISTORY')

def captured(capture,argv,registry,directory,name,env,timeout,json_output=True,log_limit=LOG_BYTES):
 started=stamp();value=capture(argv,ROOT,env,directory/(name+'.log'),timeout=timeout,max_bytes=log_limit)
 path=directory/(name+'.log');raw=None
 try:
  require(value.get('ownedProcessSettled') is True,'PROTECTED_OWNED_UNSETTLED');raw=private_bytes(path,log_limit);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  try:os.fsync(fd)
  finally:os.close(fd)
  sync_dir(directory)
 except Exception:value={**value,'localFailure':True,'localFailureCode':'owned-log-persistence-or-settlement-uncertain'}
 value={**value,'startedAt':started,'finishedAt':stamp(),'logSha256':digest(raw) if raw is not None else None,'deadlineSeconds':timeout,'cleanupSeconds':10}
 exclusive(directory/(name+'-process.json'),value);require(successful(value),'PROTECTED_OWNED_CHILD');return value,json.loads(raw) if json_output else raw.decode('utf8').strip()

def execute(review_path,capture=None,select_credential=None):
 """Injected callables are local test seams; the command line exposes neither."""
 review_path=Path(review_path);original=private_bytes(review_path);r,registry=validate_current(review_path,original,700)
 require(r.get('format')==1 and r['mode'] in ['initial','full'] and r['limits'].keys()=={'maxRequests','wallMs','requestMs'},'PROTECTED_OWNED_REVIEW')
 for key,maximum in [('maxRequests',64),('wallMs',300000),('requestMs',15000)]:require(type(r['limits'][key]) is int and 1<=r['limits'][key]<=maximum,'PROTECTED_OWNED_LIMITS')
 require(review_path==registry/('window-%06d.reviewed.json'%r['window']),'PROTECTED_OWNED_REVIEW_PATH');i=r['inputs']
 for key in ['directory','cutoverBundle']:private_path(i[key],True)
 for key in ['admissionPath','targetFile']:private_path(i[key]);private_bytes(Path(i[key]),16384)
 target=checked_target(r['target']);require(digest(private_bytes(Path(i['targetFile']),16384))==i['targetFileSha256'],'PROTECTED_OWNED_TARGET_DRIFT');require(credential_metadata(Path(r['credential']['path']))==r['credential'],'PROTECTED_OWNED_CREDENTIAL_DRIFT')
 prior_windows(r,registry)
 if capture is None:
  spec=importlib.util.spec_from_file_location('protected_owned_capture',ROOT/'scripts/lib/capture_owned.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);capture=module.capture_owned
 directory=registry/('window-%06d'%r['window']);directory.mkdir(mode=0o700);sync_dir(registry);started=time.monotonic();result={'format':1,'phase':'protected-d1-owned-window','window':r['window'],'mode':r['mode'],'planSha256':r['planSha256'],'reviewSha256':digest(original),'startedAt':stamp(),'passed':False,'receiptPersistenceUncertain':False,'acceptanceRequiresSeparateMarker':True,'automaticNextWindow':False,'versionSeconds':5,'inspectionSeconds':300,'executionSeconds':330,'cleanupSecondsPerChild':10,'maxLogBytesTotal':LOG_BYTES};token=None
 try:
  exclusive(directory/'started.json',{'format':1,'reviewSha256':digest(original),'planSha256':r['planSha256'],'window':r['window'],'mode':r['mode'],'startedAt':result['startedAt'],'automaticNextWindow':False})
  result['startupBefore']=startup_absence(registry)
  version,actual_version=captured(capture,[r['runtime']['path'],'--no-env-file','--version'],registry,directory,'runtime',child_env(registry),VERSION_SECONDS,False,4096);result['runtime']=version;require(actual_version==r['runtime']['version'],'PROTECTED_OWNED_RUNTIME_VERSION');validate_current(review_path,original,680)
  inspection,observed=captured(capture,arguments(r,registry),registry,directory,'inspection',child_env(registry),INSPECTION_SECONDS,True,65536);result['inspection']=inspection
  require(observed.get('format')==1 and observed.get('execute') is False and observed.get('planSha256')==r['planSha256'] and observed.get('pins',{}).get('targetSha256')==digest(json.dumps(target,separators=(',',':')).encode()) and observed.get('pins',{}).get('slice')==('full-copy-v1' if r['mode']=='full' else 'initial-admission-v1'),'PROTECTED_OWNED_INSPECTION')
  validate_current(review_path,original,370);result['startupAfterInspection']=startup_absence(registry)
  execution_log_bytes=LOG_BYTES-(directory/'runtime.log').stat().st_size-(directory/'inspection.log').stat().st_size;require(execution_log_bytes>=65536,'PROTECTED_OWNED_LOG_BUDGET')
  exclusive(directory/'execution.intent.json',{'format':1,'reviewSha256':digest(original),'planSha256':r['planSha256'],'window':r['window'],'runtimeProcessSha256':digest(private_bytes(directory/'runtime-process.json')),'inspectionProcessSha256':digest(private_bytes(directory/'inspection-process.json')),'bundleSha256':r['bundleSha256'],'runtimeSha256':r['runtime']['sha256'],'limits':r['limits'],'maxExecutionLogBytes':execution_log_bytes,'startedAt':stamp(),'automaticNextWindow':False})
  validate_current(review_path,original,370);token=(select_credential or credential)(r);validate_current(review_path,original,370)
  execution,child=captured(capture,arguments(r,registry,True),registry,directory,'execution',child_env(registry,token),EXECUTION_SECONDS,True,execution_log_bytes);token=None;result['execution']=execution
  validate_current(review_path,original);result['startupAfter']=startup_absence(registry)
  require(child.get('format')==1 and child.get('planSha256')==r['planSha256'] and child.get('window')==r['window'] and child.get('outcome') in (['bounded','complete','reconciled'] if r['mode']=='full' else ['bounded','checking-text','reconciled']) and type(child.get('attempts')) is int and 1<=child['attempts']<=r['limits']['maxRequests'] and child.get('limits')==r['limits'],'PROTECTED_OWNED_CLIENT_RESULT')
  client=Path(i['journalDirectory'])/('window-%06d'%r['window']);client_raw=private_bytes(client/'result.json');client_accepted=private_bytes(client/'accepted.json');require(json.loads(client_raw)==child and json.loads(client_accepted)['resultSha256']==digest(client_raw) and not os.path.lexists(client/'acceptance-expired.json'),'PROTECTED_OWNED_CLIENT_RECEIPT')
  result.update(passed=True,outcome=child['outcome'],attempts=child['attempts'],clientResultSha256=digest(client_raw),clientAcceptedSha256=digest(client_accepted))
 except Exception as error:
  result['code']=str(error) if isinstance(error,ValueError) and re.fullmatch('PROTECTED_OWNED_[A-Z_]+',str(error)) else 'PROTECTED_OWNED_LOCAL_OR_CHILD'
 finally:
  try:result['startupAfter']=startup_absence(registry);validate_current(review_path,original);result['postcheckPassed']=True
  except Exception:result['passed']=False;result['postcheckPassed']=False;result.setdefault('code','PROTECTED_OWNED_POSTCHECK')
  token=None;result['finishedAt']=stamp();result['elapsedSeconds']=time.monotonic()-started
  try:
   result_sha=exclusive(directory/'result.json',result)
   if result['passed']:
    validate_current(review_path,original);exclusive(directory/'accepted.json',{'format':1,'resultSha256':result_sha,'window':r['window'],'planSha256':r['planSha256']})
    try:validate_current(review_path,original)
    except Exception:exclusive(directory/'acceptance-expired.json',{'format':1,'passed':False});raise
  except Exception:
   result['passed']=False;result['receiptPersistenceUncertain']=True
   # result.json can already say passed and accepted.json can already exist
   # when either exclusive write reports a later fsync failure. Preserve both
   # and leave a separate permanent fence before returning that uncertainty.
   try:exclusive(directory/'receipt-uncertain.json',{'format':1,'passed':False,'receiptPersistenceUncertain':True,'window':r['window'],'planSha256':r['planSha256'],'automaticNextWindow':False})
   except Exception:pass  # A created partial fence also refuses later windows.
 return {'format':1,'phase':'protected-d1-owned-window','passed':result['passed'],'outcome':result.get('outcome','failed') if result['passed'] else 'failed','preserved':True,'automaticNextWindow':False,'receiptPersistenceUncertain':result['receiptPersistenceUncertain']}

def main():
 require(sys.flags.isolated and sys.dont_write_bytecode and len(sys.argv)==4 and sys.argv[1:3]==['--execute-reviewed-window','--review'],'PROTECTED_OWNED_ARGUMENTS');summary=execute(sys.argv[3]);print(json.dumps(summary));return 0 if summary['passed'] else 2
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception:print(json.dumps({'passed':False,'error':'protected_owned_refused','preserved':True,'automaticNextWindow':False}));raise SystemExit(1)
