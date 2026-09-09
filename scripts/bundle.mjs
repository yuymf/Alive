import { build } from 'rolldown';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const targets = [
  {
    input: path.join(ROOT, 'alive', 'scripts', 'host', 'chat.ts'),
    file: path.join(ROOT, 'dist-alive', 'scripts', 'host', 'chat.js'),
    external: ['livekit-server-sdk', 'jimp'],
  },
  {
    input: path.join(ROOT, 'alive', 'scripts', 'host', 'boot.ts'),
    file: path.join(ROOT, 'dist-alive', 'scripts', 'host', 'boot.js'),
    external: ['livekit-server-sdk', 'jimp'],
  },
  {
    input: path.join(ROOT, 'alive', 'scripts', 'admin', 'command-handler.ts'),
    file: path.join(ROOT, 'dist-alive', 'scripts', 'admin', 'command-handler.js'),
    external: ['livekit-server-sdk', 'jimp'],
  },
  {
    input: path.join(ROOT, 'alive', 'scripts', 'host', 'install.ts'),
    file: path.join(ROOT, 'dist-alive', 'scripts', 'host', 'install.js'),
    external: ['livekit-server-sdk', 'jimp'],
  },
];

async function main() {
  console.log('Bundling host scripts with rolldown...');
  for (const t of targets) {
    const start = Date.now();
    await build({
      input: t.input,
      output: {
        file: t.file,
        format: 'cjs',
        codeSplitting: false,
      },
      platform: 'node',
      external: t.external,
    });
    console.log(`  ✓ ${path.relative(ROOT, t.file)} (${Date.now() - start}ms)`);
  }
  console.log('Bundle complete.');
}

main().catch((err) => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
