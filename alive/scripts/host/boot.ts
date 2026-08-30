// CLI entry for lifecycle scripts. Host agents run: node boot.js tick

import { loadAliveEnv, getPersonaName } from '../utils/file-utils';
import { createRealLLMClient } from '../utils/llm-client';
import { main as heartbeatMain } from '../lifecycle/heartbeat-tick';
import { runMorningPlan } from '../lifecycle/morning-plan';
import { runNightReflect } from '../lifecycle/night-reflect';

export type BootCommand = 'tick' | 'morning' | 'night';

export async function boot(command: BootCommand = 'tick'): Promise<void> {
  loadAliveEnv();
  if (!process.env.LLM_API_KEY) {
    throw new Error(
      'LLM_API_KEY is required for heartbeat scripts. Put it in $ALIVE_HOME/.env or export it. Conversation chat uses the host agent model and does not need this key.',
    );
  }
  const llm = createRealLLMClient();
  console.log(`[alive] ${command} persona=${getPersonaName()} home=${process.env.ALIVE_HOME ?? '~/.alive'}`);
  switch (command) {
    case 'morning':
      await runMorningPlan(llm);
      break;
    case 'night':
      await runNightReflect(llm);
      break;
    default:
      await heartbeatMain(llm);
  }
}

async function main(): Promise<void> {
  const raw = (process.argv[2] ?? 'tick').toLowerCase();
  const command: BootCommand = raw === 'morning' || raw === 'night' || raw === 'tick' ? raw : 'tick';
  await boot(command);
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
