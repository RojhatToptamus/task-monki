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
    await service.secrets.create({id:'fixture/dev/token',value:secret});
    const initial=await service.start(tree,'file');
    const ready=await approve(service,tree,initial.status.candidate.id);
    assert.equal(await(await fetch(ready.url)).text(),'packaged');
    assert.ok(!(await service.owner().logs(service.name(tree),ready.id)).text.includes(secret));
    const update=await service.start(tree,'file');
    await service.owner().cancel(service.name(tree),update.status.candidate.id);
    assert.equal(await(await fetch(ready.url)).text(),'packaged');
    await service.close();
    await assert.rejects(fetch(ready.url));
    service=new ApplicationPreviewService(options);
    await service.init();
    const stopped=await service.read(tree);
    assert.equal(stopped.status.active,undefined);
    assert.equal(stopped.status.latest.state,'stopped');
    await service.secrets.unlock({password});
    const restarted=await service.start(tree,'retained');
    const second=await approve(service,tree,restarted.status.candidate.id);
    assert.equal(await(await fetch(second.url)).text(),'packaged');
    await service.retireWorktree(tree);
    await assert.rejects(fetch(second.url));
    process.stdout.write(JSON.stringify({status:'passed',checks:['packaged CommonJS consumer','Electron supervisor','profile SQLite keystore','synthetic secret redaction','cancellation preserves serving app','stop and restart persistence','paths with spaces','owned cleanup']})+'\\n');
  } finally {await service.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
let verified = false;
try {
  const child = spawn(executable, [fixture], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
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
