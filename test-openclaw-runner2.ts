import { callLLM } from './alive/scripts/utils/llm-client';

async function main() {
  delete process.env.LLM_API_KEY;
  try {
    const result = await callLLM('respond with exactly the words: hello world');
    console.log('RESULT:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error('ERROR:', e.message);
  }
}

main();
