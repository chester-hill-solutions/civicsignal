#!/usr/bin/env bun
/** Offline only. There is deliberately no remote/apply-to-cloud mode. */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { applyProtectedState, prepareProtectedState, ProtectedStateError, verifyProtectedState } from './lib/protected-state';

export async function protectedStateCli(argv: string[]) {
  const [mode,...rest]=argv;
  const flags=new Map<string,string>();
  for(let n=0;n<rest.length;n+=2){
    const flag=rest[n]!,value=rest[n+1];
    if(!flag.startsWith('--')||!value||value.startsWith('--')||flags.has(flag))throw new ProtectedStateError('INVALID_ARGUMENTS');
    flags.set(flag,value);
  }
  const exact=(names:string[])=>{
    if(flags.size!==names.length||!names.every(name=>flags.has(name)))throw new ProtectedStateError('INVALID_ARGUMENTS');
  };
  const get=(flag:string)=>flags.get(flag)!;
  if(mode==='prepare'){
    const sourceFlag=flags.has('--source-sql')?'--source-sql':'--source-sqlite';
    exact([sourceFlag,'--source-sha256','--legacy-auth','--auth-sha256','--target','--target-sha256','--cutover','--cutover-sha256','--output']);
    return prepareProtectedState({source:{kind:sourceFlag==='--source-sql'?'sql':'sqlite',path:get(sourceFlag),sha256:get('--source-sha256')},
      legacyAuth:{path:get('--legacy-auth'),sha256:get('--auth-sha256')},targetSqlite:{path:get('--target'),sha256:get('--target-sha256')},
      cutoverBundle:{path:get('--cutover'),manifestSha256:get('--cutover-sha256')},outputDirectory:get('--output')});
  }
  if(mode==='apply-local'||mode==='verify-local'){
    exact(['--bundle','--manifest-sha256','--target']);
    const options={directory:get('--bundle'),manifestSha256:get('--manifest-sha256'),targetSqlite:get('--target')};
    return mode==='apply-local'?applyProtectedState(options):verifyProtectedState(options);
  }
  throw new ProtectedStateError('INVALID_ARGUMENTS');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  protectedStateCli(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{
    console.error(JSON.stringify({failed:true,code:error instanceof ProtectedStateError?error.code:'PROTECTED_STATE_FAILURE'}));process.exitCode=1;
  });
}
