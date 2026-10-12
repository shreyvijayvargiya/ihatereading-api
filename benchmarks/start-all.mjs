// Starts all servers from servers.json at once, each on its own PORT.
// Usage: node benchmarks/start-all.mjs [--install] [--cmd "npm start"]
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { servers } = JSON.parse(readFileSync(resolve(here, 'servers.json'), 'utf8'));
const args = process.argv.slice(2);
const install = args.includes('--install');
const cmdIdx = args.indexOf('--cmd');
const cmd = cmdIdx >= 0 ? args[cmdIdx + 1] : 'npm start';

const children = servers.map((s) => {
	const cwd = resolve(here, s.dir);
	if (install) execSync('npm install', { cwd, stdio: 'inherit' });
	const child = spawn(s.cmd || cmd, {
		cwd,
		shell: true,
		env: { ...process.env, PORT: String(s.port), NODE_ENV: 'production' },
	});
	const tag = `[${s.name}:${s.port}]`;
	child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
	child.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
	child.on('exit', (code) => console.log(`${tag} exited (${code})`));
	return child;
});

const stop = () => {
	children.forEach((c) => c.kill('SIGTERM'));
	setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`Started ${children.length} servers. Ctrl-C stops all.`);
