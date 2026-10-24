/** Bounded staging copy. Default inspection has no credential path. */
import {lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privatePath} from './lib/protected-state';
import {inspectProtectedD1Client,runProtectedD1InitialWindow,runProtectedD1FullWindow,ProtectedD1ClientError} from './lib/protected-state-d1-client';
export async function protectedD1ClientMain(argv:string[]){
 const values=new Map<string,string>();let execute=false,full=false;
 for(let at=0;at<argv.length;at++){const key=argv[at]!;if(key==='--full-phases'){if(full)throw new ProtectedD1ClientError('PROTECTED_CLIENT_ARGUMENTS');full=true;continue;}if(key==='--execute-window'){if(execute)throw new ProtectedD1ClientError('PROTECTED_CLIENT_ARGUMENTS');execute=true;continue;}
  const value=argv[++at];if(!['--directory','--manifest-sha256','--admission','--admission-sha256','--admission-file-sha256','--cutover','--target','--journal','--max-requests','--wall-ms','--request-ms'].includes(key)||!value||value.startsWith('--')||values.has(key))throw new ProtectedD1ClientError('PROTECTED_CLIENT_ARGUMENTS');values.set(key,value);}
 for(const key of ['--directory','--manifest-sha256','--admission','--admission-sha256','--admission-file-sha256','--cutover','--target'])if(!values.has(key))throw new ProtectedD1ClientError('PROTECTED_CLIENT_ARGUMENTS');
 const path=await privatePath(values.get('--target')!);if((await lstat(path)).size>16*1024)throw new ProtectedD1ClientError('PROTECTED_CLIENT_TARGET_BOUND');
 const raw=await readFile(path);if(raw.length>16*1024)throw new ProtectedD1ClientError('PROTECTED_CLIENT_TARGET_BOUND');
 const options={directory:values.get('--directory')!,manifestSha256:values.get('--manifest-sha256')!,admissionPath:values.get('--admission')!,admissionSha256:values.get('--admission-sha256')!,admissionFileSha256:values.get('--admission-file-sha256')!,cutoverBundle:values.get('--cutover')!,target:JSON.parse(raw.toString('utf8')) as unknown};
 if(!execute)return inspectProtectedD1Client(options,full);
 if(!values.has('--journal'))throw new ProtectedD1ClientError('PROTECTED_CLIENT_ARGUMENTS');
 return (full?runProtectedD1FullWindow:runProtectedD1InitialWindow)({...options,journalDirectory:values.get('--journal')!,credential:()=>process.env['RESTORE_TOKEN']??'',
  ...(values.has('--max-requests')?{maxRequests:Number(values.get('--max-requests'))}:{}),...(values.has('--wall-ms')?{wallMs:Number(values.get('--wall-ms'))}:{}),...(values.has('--request-ms')?{requestMs:Number(values.get('--request-ms'))}:{})});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))protectedD1ClientMain(process.argv.slice(2)).then(value=>{console.log(JSON.stringify(value));if('outcome'in value&&['failed','unresolved'].includes(value.outcome))process.exitCode=2;}).catch(error=>{console.error(JSON.stringify({error:'protected_client_refused',code:error instanceof ProtectedD1ClientError?error.code:'PROTECTED_CLIENT_LOCAL_OR_TRANSPORT'}));process.exitCode=1;});
