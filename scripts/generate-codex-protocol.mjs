import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outputDir = path.resolve('src/core/agent/codex/protocol/generated');
const metadataPath = path.resolve('src/core/agent/codex/protocol/metadata.ts');
const checkOnly = process.argv.includes('--check');

if (!checkOnly) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  execFileSync('codex', ['app-server', 'generate-ts', '--out', outputDir], {
    stdio: 'inherit'
  });
}

const files = [];
const visit = (directory) => {
  for (const name of fs.readdirSync(directory)) {
    const filePath = path.join(directory, name);
    if (fs.statSync(filePath).isDirectory()) {
      visit(filePath);
    } else {
      files.push(filePath);
    }
  }
};

visit(outputDir);
files.sort();

const hash = createHash('sha256');
for (const filePath of files) {
  hash.update(path.relative(outputDir, filePath).split(path.sep).join('/'));
  hash.update('\0');
  hash.update(fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n'));
  hash.update('\0');
}

console.log(`Generated ${files.length} files`);
const actualHash = hash.digest('hex');
console.log(`SHA-256 ${actualHash}`);

if (checkOnly) {
  const metadata = fs.readFileSync(metadataPath, 'utf8');
  const expectedHash =
    /CODEX_PROTOCOL_SCHEMA_HASH\s*=\s*\n?\s*'([a-f0-9]{64})'/.exec(metadata)?.[1];
  if (!expectedHash) {
    throw new Error('Could not read CODEX_PROTOCOL_SCHEMA_HASH from metadata.ts.');
  }
  if (actualHash !== expectedHash) {
    throw new Error(
      `Generated protocol hash mismatch: expected ${expectedHash}, received ${actualHash}.`
    );
  }
  console.log('Generated protocol bindings match pinned metadata.');
}
