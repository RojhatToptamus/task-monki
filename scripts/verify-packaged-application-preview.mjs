import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run the shipped CommonJS consumer and SQLite/native dependencies inside Electron's Node runtime.
if (process.platform !== 'darwin') throw new Error('This packaged verifier currently requires macOS.');
const app = path.resolve('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Task Monki.app');
const executable = path.join(app, 'Contents/MacOS/Task Monki');
const resources = path.join(app, 'Contents/Resources');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task monki packaged preview '));
const fixture = path.join(root, 'verify.cjs');
await fs.writeFile(fixture, `
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {ApplicationPreviewService} = require(${JSON.stringify(path.join(resources, 'app.asar/dist-electron/core/preview/ApplicationPreviewService.js'))});
const root = ${JSON.stringify(root)};
const options = {
  root: path.join(root,'profile'),
  supervisor: {
    executable: process.execPath,
    module: ${JSON.stringify(path.join(resources, 'app.asar.unpacked/node_modules/previewhost/dist/supervisor.js'))},
    env: {ELECTRON_RUN_AS_NODE:'1'}
  }
};
async function approve(service,tree,id) {
  const deadline=Date.now()+10000;
  while(!(await service.read(tree)).approval) {
    if(Date.now()>deadline)throw Error('Approval did not arrive');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  await service.approve(tree,id);
  const ready=await service.owner().wait(service.name(tree),id);
  assert.equal(ready.state,'ready',JSON.stringify(ready));
  return ready;
}
(async()=>{
  let service=new ApplicationPreviewService(options);
  await service.init();
  try {
    const source=path.join(root,'source with spaces');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source,'app.cjs'),"console.log('token',process.env.TOKEN);require('http').createServer((q,r)=>r.end('packaged')).listen(Number(process.env.PORT),'127.0.0.1');");
    await fs.writeFile(path.join(source,'preview.yaml'),JSON.stringify({name:'packaged',type:'command',cwd:'.',command:[${JSON.stringify(process.execPath)},'app.cjs'],env:{TOKEN:{secret:'fixture/dev/token'}}}));
    const tree={id:'packaged-fixture',worktreePath:source};
    const password='SYNTHETIC_packaged_password';
    const secret='SYNTHETIC_packaged_value';
    await service.secrets.unlock({password,confirmation:password,create:true});
    const initial=await service.start(tree);
    while(!(await service.read(tree)).approval) await new Promise(resolve=>setTimeout(resolve,25));
    await assert.rejects(service.approve(tree,initial.status.candidate.id), error => error.message.includes('fixture/dev/token'));
    assert.equal((await service.read(tree)).approval.secrets[0].availability,'missing');
    await service.secrets.create({id:'fixture/dev/token',value:secret});
    assert.equal((await service.read(tree)).status.active,undefined);
    assert.equal((await service.read(tree)).approval.attemptId,initial.status.candidate.id);
    const ready=await approve(service,tree,initial.status.candidate.id);
    assert.equal(await(await fetch(ready.url)).text(),'packaged');
    assert.ok(!(await service.owner().logs(service.name(tree),ready.id)).text.includes(secret));
    await service.secrets.lock();
    const update=await service.start(tree);
    while(!(await service.read(tree)).approval) await new Promise(resolve=>setTimeout(resolve,25));
    await assert.rejects(service.approve(tree,update.status.candidate.id),/locked/);
    await service.secrets.unlock({password});
    await service.owner().cancel(service.name(tree),update.status.candidate.id);
    assert.equal(await(await fetch(ready.url)).text(),'packaged');
    await fs.writeFile(path.join(source,'preview.yaml'),JSON.stringify({name:'packaged',type:'command',cwd:'.',command:[${JSON.stringify(process.execPath)},'-e',"console.error('fixture command failed');process.exit(2)"]}));
    const failedUpdate=await service.start(tree);
    while(!(await service.read(tree)).approval) await new Promise(resolve=>setTimeout(resolve,25));
    await service.approve(tree,failedUpdate.status.candidate.id);
    const failed=await service.owner().wait(service.name(tree),failedUpdate.status.candidate.id);
    assert.equal(failed.state,'failed');
    assert.match((await service.owner().logs(service.name(tree),failed.id)).text,/fixture command failed/);
    assert.equal(await(await fetch(ready.url)).text(),'packaged');
    await fs.writeFile(path.join(source,'preview.yaml'),JSON.stringify({name:'packaged',type:'command',cwd:'.',command:[${JSON.stringify(process.execPath)},'app.cjs'],env:{TOKEN:{secret:'fixture/dev/token'}}}));
    const restored=await service.start(tree);
    await approve(service,tree,restored.status.candidate.id);
    await service.close();
    await assert.rejects(fetch(ready.url));
    service=new ApplicationPreviewService(options);
    await service.init();
    const stopped=await service.read(tree);
    assert.equal(stopped.status.active,undefined);
    assert.equal(stopped.status.latest.state,'stopped');
    await service.secrets.unlock({password});
    const restarted=await service.start(tree);
    const second=await approve(service,tree,restarted.status.candidate.id);
    assert.equal(await(await fetch(second.url)).text(),'packaged');
    await service.retireWorktree(tree);
    await assert.rejects(fetch(second.url));
    const setupSource=path.join(root,'first time setup');
    await fs.mkdir(setupSource);
    await fs.writeFile(path.join(setupSource,'index.html'),'first setup');
    const setupTree={id:'first-setup',worktreePath:setupSource};
    assert.equal((await service.inspectSetup(setupTree)).recommendations[0].type,'static');
    await service.saveFile(setupTree,undefined,JSON.stringify({name:'application',type:'static',directory:'.'}));
    assert.equal((await service.read(setupTree)).status,undefined);
    await assert.rejects(service.saveFile(setupTree,undefined,JSON.stringify({name:'application',type:'static',directory:'.'})),/already exists|changed/);
    const setupPending=await service.start(setupTree);
    const setupReady=await approve(service,setupTree,setupPending.status.candidate.id);
    assert.equal(await(await fetch(setupReady.url)).text(),'first setup');
    await service.retireWorktree(setupTree);
    const external=path.join(root,'external folder');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external,'index.html'),'external folder');
    await fs.writeFile(path.join(setupSource,'preview.yaml'),JSON.stringify({name:'app',type:'environment',primary:'web',services:{web:{type:'static',directory:external}}}));
    const before=await service.read(setupTree);
    assert.equal(before.fileSources[0].connected,false);
    await service.connectSource(setupTree,{taskId:'setup',service:'web',directory:external,expected:{active:null,candidate:null,latest:null}});
    assert.equal((await service.read(setupTree)).status,undefined);
    const otherFolder=path.join(root,'unconnected external folder');
    await fs.mkdir(otherFolder);
    await fs.rename(external,external+' original');
    await fs.symlink(otherFolder,external);
    try {
      assert.equal((await service.read(setupTree)).fileSources[0].connected,false);
      await assert.rejects(service.start(setupTree),/Connect/);
    } finally {
      await fs.unlink(external);
      await fs.rename(external+' original',external);
    }
    const connected=await service.start(setupTree);
    const externalReady=await approve(service,setupTree,connected.status.candidate.id);
    assert.equal(await(await fetch(externalReady.url)).text(),'external folder');
    await service.retireWorktree(setupTree);
    const fresh=path.join(root,'fresh dependency project');
    await fs.mkdir(path.join(fresh,'server-package'),{recursive:true});
    const manifest={name:'preview-fixture',version:'1.0.0',dependencies:{'fixture-server':'file:./server-package'}};
    await fs.writeFile(path.join(fresh,'package.json'),JSON.stringify(manifest));
    await fs.writeFile(path.join(fresh,'package-lock.json'),JSON.stringify({name:'preview-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':manifest,'node_modules/fixture-server':{resolved:'server-package',link:true},'server-package':{name:'fixture-server',version:'1.0.0',bin:{'fixture-server':'server.cjs'}}}}));
    await fs.writeFile(path.join(fresh,'server-package/package.json'),JSON.stringify({name:'fixture-server',version:'1.0.0',bin:{'fixture-server':'server.cjs'}}));
    await fs.writeFile(path.join(fresh,'server-package/server.cjs'),"#!/usr/bin/env node\\nrequire('http').createServer((q,r)=>r.end('installed dependency')).listen(Number(process.env.PORT),'127.0.0.1');");
    const freshSpec={name:'portable-project',type:'environment',primary:'web',services:{install:{type:'job',cwd:'.',command:['npm','ci','--offline','--no-audit','--no-fund']},web:{type:'command',cwd:'.',command:['./node_modules/.bin/fixture-server'],dependsOn:['install']}}};
    const freshTree={id:'fresh-dependencies',worktreePath:fresh};
    await service.saveFile(freshTree,undefined,JSON.stringify(freshSpec));
    await assert.rejects(fs.access(path.join(fresh,'node_modules')));
    const freshPending=await service.start(freshTree);
    const freshReady=await approve(service,freshTree,freshPending.status.candidate.id);
    assert.equal(await(await fetch(freshReady.url)).text(),'installed dependency');
    const review=await service.start(freshTree);
    assert.ok(review.restartReview);
    await service.cancel(freshTree,review.restartReview.id);
    assert.equal(await(await fetch(freshReady.url)).text(),'installed dependency');
    const restartReview=await service.start(freshTree);
    await service.approve(freshTree,restartReview.restartReview.id);
    let newId;
    const restartDeadline=Date.now()+10000;
    while(!newId){const next=await service.read(freshTree);newId=next.status.candidate?.id??(next.status.latest?.id!==freshReady.id?next.status.latest?.id:undefined);if(Date.now()>restartDeadline)throw Error('Restart candidate did not arrive');if(!newId)await new Promise(resolve=>setTimeout(resolve,25));}
    assert.equal((await service.owner().wait(service.name(freshTree),newId)).state,'ready');
    assert.equal((await service.read(freshTree)).approval,undefined);
    const deniedRestart=await service.start(freshTree);
    const moved=fresh+' original';
    const unexpected=path.join(root,'unconnected replacement');
    await fs.mkdir(unexpected);
    await fs.writeFile(path.join(unexpected,'preview.yaml'),JSON.stringify(freshSpec));
    await fs.rename(fresh,moved);
    await fs.symlink(unexpected,fresh);
    try {
      await assert.rejects(service.approve(freshTree,deniedRestart.restartReview.id),/source folder changed/);
      assert.equal((await service.owner().get(service.name(freshTree))).active.id,newId);
    } finally {
      await fs.unlink(fresh);
      await fs.rename(moved,fresh);
    }
    const refusedReview=await service.start(freshTree);
    const originalStart=service.owner().start;
    service.owner().start=async()=>{throw Error('Synthetic pre-admission failure');};
    try {
      await assert.rejects(service.approve(freshTree,refusedReview.restartReview.id),/previous preview stopped.*replacement could not start/);
      const refused=await service.owner().get(service.name(freshTree));
      assert.equal(refused.active,undefined);
      assert.equal(refused.candidate,undefined);
    } finally { service.owner().start=originalStart; }
    const corrected=await service.start(freshTree);
    const correctedReady=await approve(service,freshTree,corrected.status.candidate.id);
    assert.equal(await(await fetch(correctedReady.url)).text(),'installed dependency');
    await service.retireWorktree(freshTree);
    const brokenModule=path.join(root,'broken-supervisor.mjs');
    await fs.writeFile(brokenModule,"process.stderr.write('bootstrap diagnostic');await import('task-monki-fixture-missing-module');");
    const broken=new ApplicationPreviewService({...options,root:path.join(root,'broken-profile'),supervisor:{...options.supervisor,module:brokenModule}});
    await broken.init();
    try {
      await broken.secrets.unlock({password,confirmation:password,create:true});
      await broken.secrets.create({id:'fixture/dev/token',value:secret});
      const attempt=await broken.start(tree);
      while(!(await broken.read(tree)).approval) await new Promise(resolve=>setTimeout(resolve,25));
      await broken.approve(tree,attempt.status.candidate.id);
      const result=await broken.owner().wait(broken.name(tree),attempt.status.candidate.id);
      assert.equal(result.error.code,'SUPERVISOR_FAILED');
      assert.match((await broken.owner().logs(broken.name(tree),result.id)).text,/task-monki-fixture-missing-module/);
    } finally {await broken.close();}
    process.stdout.write(JSON.stringify({status:'passed',checks:['packaged CommonJS consumer','Electron supervisor','profile SQLite keystore','synthetic secret redaction','cancellation preserves serving app','stop and restart persistence','paths with spaces','owned cleanup','missing secret blocks approval','saving does not approve','failed replacement preserves serving app','first-time save and start','explicit external folder connection','supervisor startup diagnostics','locked storage blocks approval','fresh dependency installation','restart review cancel and approve','source identity change requires reconnection','source identity change cancels restart before stopping','forced pre-admission failure leaves stopped preview','corrected file starts after refused restart']})+'\\n');
  } finally {await service.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
let verified = false;
try {
  const child = spawn(executable, [fixture], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, `Packaged verification interrupted by ${signal}`);
    assert.equal(code, 0, 'Packaged preview verification failed');
    verified = true;
  } finally { clearTimeout(timer); }
} finally {
  if (verified) await fs.rm(root, { recursive: true, force: true });
  else console.error(`Verification state retained for owned-resource recovery: ${root}`);
}
