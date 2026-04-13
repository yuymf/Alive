import { callLLM } from './alive/scripts/utils/llm-client';

async function main() {
  delete process.env.LLM_API_KEY;
  const result = await callLLM('respond with exactly the words: hello world');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e: Error) => console.error('ERROR:', e.message));
