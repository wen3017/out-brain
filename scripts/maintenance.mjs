import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, isAbsolute, win32, posix, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(join(root, '.env')); } catch { /* Environment may be injected. */ }
const [action, directory, mode = 'local'] = process.argv.slice(2);
if (!['backup', 'restore'].includes(action) || !directory || !['local', 'docker'].includes(mode)) {
  console.error('Usage: node scripts/maintenance.mjs backup|restore DIRECTORY [local|docker]'); process.exit(1);
}
if (mode === 'local' && !isAbsolute(process.env.STORAGE_ROOT || '')) {
  console.error('STORAGE_ROOT must be an absolute path shared by API, Worker and maintenance'); process.exit(1);
}
const require = createRequire(join(root, 'apps/api/package.json'));
const { PrismaClient } = require('@prisma/client');
const { Redis } = require('ioredis');
const destination = resolve(directory);
const storage = mode === 'docker' ? '/app/data/uploads' : resolve(root, process.env.STORAGE_ROOT || 'data/uploads');
const dbUrl = new URL(process.env.DATABASE_URL);
const redisUrl = new URL(process.env.REDIS_URL);
if (mode === 'docker') {
  if (dbUrl.hostname === 'postgres') dbUrl.hostname = '127.0.0.1';
  if (redisUrl.hostname === 'redis') redisUrl.hostname = '127.0.0.1';
}
const db = new PrismaClient({ datasources: { db: { url: dbUrl.toString() } } });
const redis = new Redis(redisUrl.toString(), { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
redis.on('error', () => {});
const pgEnvironment = { ...process.env, PGHOST: dbUrl.hostname, PGPORT: dbUrl.port || '5432', PGUSER: decodeURIComponent(dbUrl.username), PGPASSWORD: decodeURIComponent(dbUrl.password), PGDATABASE: decodeURIComponent(dbUrl.pathname.slice(1)) };
const pgBin = process.env.PG_BIN || (process.platform === 'win32' ? join(root, '.local/postgres/pgsql/bin') : '');
async function run(command, args, { input, output, env = process.env } = {}) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  // Never print raw database errors: they can contain connection credentials or data.
  child.stderr.resume();
  const complete = new Promise((ok, fail) => { child.once('error', () => fail(new Error(`${command} could not start`))); child.once('close', code => code === 0 ? ok() : fail(new Error(`${command} failed (exit ${code})`))); });
  const jobs = [complete];
  if (input) jobs.push(pipeline(createReadStream(input), child.stdin)); else child.stdin.end();
  if (output) jobs.push(pipeline(child.stdout, createWriteStream(output, { flags: 'wx', mode: 0o600 })));
  else child.stdout.on('data', data => { stdout += data; });
  await Promise.all(jobs); return stdout.trim();
}
async function postgres(command, args, options) {
  if (mode === 'docker') return run('docker', ['compose', 'exec', '-T', 'postgres', command, '-U', 'nbboss', '-d', 'nbboss', ...args], options);
  return run(pgBin ? join(pgBin, command + (process.platform === 'win32' ? '.exe' : '')) : command, ['--dbname', pgEnvironment.PGDATABASE, ...args], { ...options, env: pgEnvironment });
}
async function inventory(base, prefix = '') {
  const files = {};
  for (const entry of await readdir(join(base, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Backup contains unsupported links or special files');
    if (entry.isDirectory()) Object.assign(files, await inventory(base, name));
    else {
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(join(base, name))) digest.update(chunk);
      files[name] = digest.digest('hex');
    }
  }
  return files;
}
async function assertStopped() {
  if (mode === 'docker') {
    const running = await run('docker', ['compose', 'ps', '--status', 'running', '--services']);
    if (running.split(/\r?\n/).some(name => ['api', 'worker'].includes(name))) throw new Error('Stop API and Worker before maintenance');
  } else {
    for (const name of ['api', 'worker']) {
      let record;
      try { record = JSON.parse(await readFile(join(root, '.local/run', `${name}.json`), 'utf8')); } catch { continue; }
      let running = false; try { process.kill(Number(record.pid), 0); running = true; } catch { /* not running */ }
      if (running) throw new Error('Stop API and Worker before maintenance');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${process.env.API_PORT || 3001}/api/health/live`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) throw new Error('API_RUNNING');
    } catch (error) { if (error.message === 'API_RUNNING') throw new Error('Stop API before maintenance'); }
  }
  await redis.connect();
  if (await redis.get('nbboss:worker:heartbeat')) throw new Error('Worker heartbeat exists; stop all writers and wait 20 seconds');
}
async function container() {
  const id = await run('docker', ['compose', 'ps', '-a', '-q', 'api']);
  if (!id || /\s/.test(id)) throw new Error('Create exactly one stopped API container first');
  return id;
}
async function copyUploads(fromBackup) {
  if (mode === 'local') {
    await cp(fromBackup ? join(destination, 'uploads') : storage, fromBackup ? storage : join(destination, 'uploads'), { recursive: true, force: false, errorOnExist: true });
  } else {
    const id = await container();
    if (fromBackup) await run('docker', ['cp', join(destination, 'uploads') + '/.', `${id}:${storage}/`]);
    else await run('docker', ['cp', `${id}:${storage}`, join(destination, 'uploads')]);
  }
}
try {
  await assertStopped();
  if (mode === 'local') {
    const inside = (base, path) => { const rel = relative(base, path); return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
    if (inside(storage, destination) || inside(destination, storage)) throw new Error('Backup directory and upload directory must be separate');
  }
  if (action === 'backup') {
    await mkdir(destination, { mode: 0o700 }); // Refuse to overwrite an existing backup.
    await postgres('pg_dump', ['--format=custom', '--no-owner', '--no-acl'], { output: join(destination, 'database.dump') });
    if (mode === 'local') await mkdir(storage, { recursive: true });
    await copyUploads(false);
    const files = await inventory(destination);
    await writeFile(join(destination, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), storageRoot: storage, files }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Backup completed: ${destination}`);
  } else {
    const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || typeof manifest.storageRoot !== 'string' || !manifest.files?.['database.dump']) throw new Error('Unsupported backup manifest');
    const actual = await inventory(destination); delete actual['manifest.json'];
    if (Object.keys(actual).length !== Object.keys(manifest.files).length || Object.entries(actual).some(([name, hash]) => manifest.files[name] !== hash)) throw new Error('Backup integrity check failed');
    await access(join(destination, 'uploads'));
    const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    if (tables.length) throw new Error('Restore requires an empty database; existing data will never be overwritten');
    if (await redis.dbsize()) throw new Error('Restore requires a fresh, dedicated Redis database');
    if (mode === 'local') {
      await mkdir(storage, { recursive: true });
      if ((await readdir(storage)).length) throw new Error('Restore requires an empty upload directory');
    } else {
      await run('docker', ['compose', 'run', '--rm', '--no-deps', '--entrypoint', 'node', 'api', '-e', `const fs=require('fs');fs.mkdirSync('${storage}',{recursive:true});if(fs.readdirSync('${storage}').length)process.exit(1)`]);
    }
    await copyUploads(true);
    await postgres('pg_restore', ['--single-transaction', '--no-owner', '--no-acl'], { input: join(destination, 'database.dump') });
    const sourcePath = /^[A-Za-z]:[\\/]/.test(manifest.storageRoot) ? win32 : posix;
    const targetPath = mode === 'docker' ? posix : process.platform === 'win32' ? win32 : posix;
    const mapPath = path => {
      const rel = sourcePath.relative(manifest.storageRoot, path);
      if (!rel || rel.startsWith('..') || sourcePath.isAbsolute(rel)) throw new Error('Database contains a file outside its storage root');
      if (!manifest.files[`uploads/${rel.split(/[\\/]/).join("/")}`]) throw new Error("Database references a missing backup file");
      return targetPath.join(storage, ...rel.split(/[\\/]/));
    };
    await db.$transaction(async tx => {
      for (const file of await tx.fileAsset.findMany({ select: { id: true, storagePath: true } })) await tx.fileAsset.update({ where: { id: file.id }, data: { storagePath: mapPath(file.storagePath) } });
      for (const file of await tx.presentationVersion.findMany({ select: { id: true, pptxPath: true } })) await tx.presentationVersion.update({ where: { id: file.id }, data: { pptxPath: mapPath(file.pptxPath) } });
      await tx.user.updateMany({ data: { authVersion: { increment: 1 } } });
      await tx.refreshToken.updateMany({ data: { revokedAt: new Date() } });
      // A restored outbox must never automatically resend mail delivered after the snapshot.
      await tx.emailDelivery.updateMany({ where: { status: { in: ['PENDING', 'SENDING'] } }, data: { status: 'FAILED', errorCode: 'DELIVERY_UNCERTAIN_CHECK_INBOX' } });
    }, { timeout: 120_000 });
    console.log('Restore completed. Keep SMTP disabled until reviewing the outbox; apply migrations and start the application.');
  }
} catch (error) {
  console.error(error instanceof Error && !('clientVersion' in error) ? error.message : 'Database maintenance failed; check connectivity and schema compatibility');
  process.exitCode = 1;
} finally { await db.$disconnect(); redis.disconnect(); }
