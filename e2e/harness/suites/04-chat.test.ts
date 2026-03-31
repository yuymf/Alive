// e2e/harness/suites/04-chat.test.ts
// Suite 04: 聊天质量 — 发消息给 persona，LLM-as-Judge 评分，记录到报告

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { getConfig } from '../harness.config';
import {
  addSuiteResult,
  addInteraction,
  startTiming,
  endTiming,
} from '../harness-context';
import { chat, ensureGateway } from '../openclaw-driver';
import { loadAndApplyApiKeys } from '../../shared/setup';
import { callLLMJSON } from '../../../alive/scripts/utils/llm-client';

// === LLM-as-Judge ===

interface JudgeScore {
  tone: number;
  memory: number;
  naturalness: number;
  summary: string;
}

function buildJudgePrompt(
  personaVoice: string,
  message: string,
  response: string,
): string {
  return `你是一个 AI 角色扮演质量评审员。请评估以下对话中 AI 角色的回复质量。

## Persona 定义
${personaVoice}

## 用户消息
${message}

## Persona 回复
${response}

请从以下三个维度评分 (0-10):
1. **tone** (语气一致性): 回复是否符合 persona 定义的性格和说话方式
2. **memory** (记忆引用): 回复是否引用了上下文/记忆内容（如有的话）。如果当前对话没有可引用的记忆，给 5 分作为基准。
3. **naturalness** (自然度): 情绪表达和对话流是否自然，不生硬不做作

输出 JSON 格式:
{ "tone": N, "memory": N, "naturalness": N, "summary": "一句话评价" }`;
}

function loadPersonaVoiceSection(personaPath: string): string {
  try {
    const raw = fs.readFileSync(path.resolve(personaPath), 'utf8');
    const persona = YAML.parse(raw);
    const voice = persona.voice || {};
    const personality = persona.personality || {};
    return [
      `Name: ${persona.meta?.name || 'Unknown'}`,
      `MBTI: ${personality.mbti || 'Unknown'}`,
      `Language: ${voice.language || 'zh-CN'}`,
      `Style: ${voice.style || 'casual'}`,
      `Signature phrases: ${(voice.signature_phrases || []).join(', ')}`,
      `Speaking habits: ${(voice.habits || []).join(', ')}`,
      `Personality traits: ${(personality.traits || []).join(', ')}`,
    ].join('\n');
  } catch {
    return 'Persona definition not available.';
  }
}

describe('04-Chat', () => {
  const config = getConfig();
  let personaVoice = '';
  const scores: JudgeScore[] = [];
  let assertionsPassed = 0;
  let assertionsTotal = 0;

  function track(name: string, fn: () => void): void {
    assertionsTotal++;
    try {
      fn();
      assertionsPassed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      console.log(`  ❌ ${name}: ${(err as Error).message}`);
      throw err;
    }
  }

  beforeAll(() => {
    expect(fs.existsSync(config.skillDir), 'Alive skill must be installed').toBe(true);
    personaVoice = loadPersonaVoiceSection(config.persona);
    loadAndApplyApiKeys('alive');

    // Chat requires the openclaw gateway + agent
    const gatewayOk = ensureGateway();
    expect(gatewayOk, 'OpenClaw gateway must be running for chat tests').toBe(true);

    startTiming('04-chat');
  });

  afterAll(() => {
    const durationMs = endTiming('04-chat');
    const avgScore = scores.length > 0
      ? scores.reduce((sum, s) => sum + (s.tone + s.memory + s.naturalness) / 3, 0) / scores.length
      : 0;

    addSuiteResult({
      name: '04-Chat',
      status: 'review',
      durationMs,
      assertionsPassed,
      assertionsTotal,
    });

    console.log(`\n  📊 Average LLM Judge Score: ${avgScore.toFixed(1)}/10`);
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      const avg = ((s.tone + s.memory + s.naturalness) / 3).toFixed(1);
      console.log(`     Message ${i + 1}: ${avg}/10 (tone=${s.tone}, memory=${s.memory}, naturalness=${s.naturalness})`);
      console.log(`     → ${s.summary}`);
    }
  });

  for (let i = 0; i < 3; i++) {
    it(`chat message ${i + 1}: sends and evaluates response`, async () => {
      const message = config.chatMessages[i];
      if (!message) return;

      console.log(`\n  💬 Sending: "${message}"`);
      const result = await chat(message);

      console.log(`  📝 Response (${result.durationMs}ms, ${result.response.length} chars)`);

      track(`message ${i + 1}: got response`, () => {
        expect(result.response.length).toBeGreaterThan(0);
      });

      console.log(`  📝 Response (${result.durationMs}ms): ${result.response.slice(0, 200)}...`);

      try {
        const judgePrompt = buildJudgePrompt(personaVoice, message, result.response);
        const score = await callLLMJSON<JudgeScore>(judgePrompt, 500, 'harness-judge');
        scores.push(score);

        addInteraction({
          timestamp: new Date().toISOString(),
          source: 'engine-llm',
          phase: 'chat',
          prompt: `[LLM Judge] Message: "${message}"`,
          response: JSON.stringify(score, null, 2),
          metadata: {
            judgeScore: score,
            originalMessage: message,
            originalResponse: result.response,
          },
        });

        const avg = (score.tone + score.memory + score.naturalness) / 3;
        console.log(`  🎯 Judge: ${avg.toFixed(1)}/10 — ${score.summary}`);
      } catch (err) {
        console.log(`  ⚠ Judge evaluation failed: ${(err as Error).message}`);
        scores.push({ tone: 0, memory: 0, naturalness: 0, summary: 'Judge failed' });
      }
    }, 120_000);
  }
});
