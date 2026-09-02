import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const showcase = JSON.parse(
  await readFile(path.join(rootDir, 'src', 'remotion', 'showcase.json'), 'utf8')
);
const audioDir = path.join(rootDir, 'public', 'remotion-showcase', 'audio');
const voiceDir = path.join(audioDir, 'voiceover');
const scratchDir = path.join(rootDir, '.local', 'task-monki-showcase-v022', 'voiceover');
const musicSource = process.env.TASK_MONKI_SHOWCASE_MUSIC
  ? path.resolve(process.env.TASK_MONKI_SHOWCASE_MUSIC)
  : null;
const voice = process.env.TASK_MONKI_SHOWCASE_VOICE ?? 'Daniel';
const rate = process.env.TASK_MONKI_SHOWCASE_VOICE_RATE ?? '180';

await rm(scratchDir, { recursive: true, force: true });
await mkdir(scratchDir, { recursive: true });
await mkdir(voiceDir, { recursive: true });

if (musicSource) {
  await run('ffmpeg', [
    '-y',
    '-i', musicSource,
    '-map', '0:a:0',
    '-af', 'loudnorm=I=-20:TP=-2:LRA=9',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    path.join(audioDir, 'music.wav')
  ]);
} else {
  await buildAmbientMusic(path.join(audioDir, 'music.wav'));
}

await run('ffmpeg', [
  '-y',
  '-f', 'lavfi',
  '-i', 'sine=frequency=1350:sample_rate=48000:duration=0.095',
  '-af', 'volume=0.18,afade=t=out:st=0.012:d=0.08',
  '-ac', '2',
  '-c:a', 'pcm_s16le',
  path.join(audioDir, 'click.wav')
]);

for (const [index, segment] of showcase.voiceover.entries()) {
  const rawPath = path.join(scratchDir, `${String(index + 1).padStart(2, '0')}-${segment.id}.aiff`);
  const outputPath = path.join(rootDir, 'public', 'remotion-showcase', segment.file);
  await run('say', ['-v', voice, '-r', rate, '-o', rawPath, segment.text]);
  const sourceDuration = await audioDuration(rawPath);
  const targetDuration = Math.max(1, segment.duration - 0.35);
  const tempo = sourceDuration > targetDuration ? sourceDuration / targetDuration : 1;
  if (tempo > 2) {
    throw new Error(`${segment.id} requires unsupported speech acceleration (${tempo.toFixed(2)}x).`);
  }
  const filter = [
    tempo > 1.001 ? `atempo=${tempo.toFixed(5)}` : null,
    'adelay=140|140',
    'apad',
    `atrim=0:${segment.duration.toFixed(3)}`,
    'loudnorm=I=-16:TP=-1.5:LRA=8'
  ].filter(Boolean).join(',');
  await run('ffmpeg', [
    '-y',
    '-i', rawPath,
    '-af', filter,
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    outputPath
  ]);
  const finalDuration = await audioDuration(outputPath);
  console.log(
    `${segment.id}: ${sourceDuration.toFixed(2)}s -> ${finalDuration.toFixed(2)}s (${tempo.toFixed(2)}x)`
  );
}

console.log(`Showcase audio written to ${audioDir}`);

async function buildAmbientMusic(outputPath) {
  const chords = [
    [130.81, 164.81, 196, 246.94],
    [110, 130.81, 164.81, 196],
    [87.31, 110, 130.81, 164.81],
    [98, 123.47, 146.83, 220]
  ];
  const args = ['-y'];
  for (const chord of chords) {
    const expression = chord
      .map((frequency, index) => `${index === 0 ? 0.18 : 0.11}*sin(2*PI*${frequency}*t)`)
      .join('+');
    args.push('-f', 'lavfi', '-i', `aevalsrc=${expression}:s=48000:d=9.125`);
  }
  args.push(
    '-f', 'lavfi', '-i',
    'aevalsrc=0.16*sin(2*PI*55*t)*exp(-8*mod(t\\,2)):s=48000:d=32',
    '-f', 'lavfi', '-i',
    'aevalsrc=0.035*sin(2*PI*523.25*t)*(0.55+0.45*sin(2*PI*0.125*t)):s=48000:d=32',
    '-filter_complex',
    [
      '[0:a]lowpass=f=1700,volume=0.28[c0]',
      '[1:a]lowpass=f=1700,volume=0.28[c1]',
      '[2:a]lowpass=f=1700,volume=0.28[c2]',
      '[3:a]lowpass=f=1700,volume=0.28[c3]',
      '[c0][c1]acrossfade=d=1.5:c1=tri:c2=tri[x1]',
      '[x1][c2]acrossfade=d=1.5:c1=tri:c2=tri[x2]',
      '[x2][c3]acrossfade=d=1.5:c1=tri:c2=tri[pad]',
      '[4:a]lowpass=f=115,volume=0.34[pulse]',
      '[5:a]aecho=0.8:0.65:420|760:0.14|0.08,volume=0.42[air]',
      '[pad][pulse][air]amix=inputs=3:normalize=0,highpass=f=45,lowpass=f=5200,loudnorm=I=-20:TP=-2:LRA=7,afade=t=in:st=0:d=0.2,afade=t=out:st=31.8:d=0.2,atrim=0:32[mix]'
    ].join(';'),
    '-map', '[mix]',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    outputPath
  );
  await run('ffmpeg', args);
}

async function audioDuration(filePath) {
  const output = await runCapture('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  return Number(output.trim());
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}.`));
    });
  });
}

async function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with ${code}.\n${output}`));
    });
  });
}
