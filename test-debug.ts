import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const prompt = 'respond with exactly the words: hello world';
const agentName = 'main';
const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'alive-oc-'));
const tmpFile = path.join(tmpDir, 'prompt.txt');
fs.writeFileSync(tmpFile, prompt, 'utf8');

const output = execSync(
  `cat "${tmpFile}" | openclaw agent --agent ${agentName} --local -m - --json`,
  { encoding: 'utf8', timeout: 120_000 },
);

// Clean up
try { fs.unlinkSync(tmpFile); } catch {}
try { fs.rmdirSync(tmpDir); } catch {}

// Debug
const parsed = JSON.parse(output);
console.log('payloads[0].text type:', typeof parsed?.payloads?.[0]?.text);
console.log('payloads[0].text value:', JSON.stringify(parsed?.payloads?.[0]?.text));
console.log('payloads[0]:', JSON.stringify(parsed?.payloads?.[0]));

fs.unlinkSync('/Users/halyu/Documents/Code/Alive/test-debug.ts');
