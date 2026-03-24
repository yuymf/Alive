# Plan: Model-Aware Prompt Router for Image Generation

**Date**: 2026-03-21
**Status**: ✅ Implemented
**Author**: AI Assistant

## Problem

MizuSan's image generation pipeline uses **identical prompts** for both Gemini (AIHubMix) and Grok (fal.ai) models, despite their fundamentally different optimal prompt structures:

- **Gemini** excels with structured `[Tag]` sections, English-primary, precise camera parameters
- **Grok** prefers concise narrative style, handles CN/EN mixing well, has `revised_prompt` auto-rewriting

This one-size-fits-all approach leaves quality on the table for both models.

## Solution

Introduce a model-aware prompt routing layer that automatically selects the optimal prompt strategy based on the active `IMAGE_ENTRY` environment variable.

### Architecture

```
generateImageSet()
  → buildRealisticPrompt(desc, style)
    → getImageEntry()
      ├─ AIHUBMIX → buildGeminiRealisticPrompt()  [structured [Tag] sections]
      └─ FAI      → buildGrokRealisticPrompt()     [narrative CN/EN mix]
    → callWithFallback(prompt, refs, ...)
```

### Key Design Decisions

1. **New module `prompt-builder.ts`** — Extracted from 740-line `generate-image.ts` to separate prompt construction (pure functions) from API calls / retries / file management
2. **Strategy pattern** — Two independent prompt builders (`buildGeminiPrompt`, `buildGrokPrompt`) behind a unified router (`buildPromptForProvider`)
3. **Zero API surface change** — `buildImagePrompt()` and `buildRealisticPrompt()` retain original signatures; routing happens internally via `getImageEntry()`
4. **Shared constants** — `CAMERA_ANCHORS`, `NEGATIVE_CONSTRAINTS`, `styleContext` migrated to `prompt-builder.ts` and re-exported

### Gemini Strategy (ref: @oggii_0)

- Structured `[Scene]` `[Subject]` `[Expression]` `[Camera]` `[Atmosphere]` `[Negative]` sections
- English-primary for concept grounding
- Full camera specs (e.g., `Canon EOS R5, 85mm f/1.4, shallow depth of field`)
- Negative constraints in dedicated `[Negative]` tag
- Realistic details in `[Realism]` tag

### Grok Strategy (ref: @qisi_ai)

- Natural narrative flow, no `[Tag]` sections
- Chinese emotional descriptors (故事感, 情绪, 慵懒) for stronger affective resonance
- Simplified camera info (device name only — Grok is less sensitive to lens specs)
- Concise — lets Grok's `revised_prompt` do its magic
- Realistic details appended inline as `真实感细节：...`

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `skill/scripts/prompt-builder.ts` | **NEW** | Model-aware prompt builder with Gemini/Grok strategies and router |
| `skill/scripts/generate-image.ts` | **MODIFIED** | `buildImagePrompt`/`buildRealisticPrompt` now delegate to prompt-builder |
| `tests/prompt-builder.test.ts` | **NEW** | 67 tests covering all ContentStyle × Provider combinations |
| `tests/generate-image-provider.test.ts` | **MODIFIED** | +5 integration tests for prompt routing via IMAGE_ENTRY |

## Test Coverage

- **67 unit tests** in `prompt-builder.test.ts`:
  - Constants integrity (CAMERA_ANCHORS, styleContext, NEGATIVE_CONSTRAINTS)
  - Gemini prompt structure validation (all [Tag] sections present)
  - Grok prompt structure validation (no [Tag] sections, Chinese descriptors)
  - Router correctness (AIHUBMIX → Gemini, FAI → Grok)
  - Realistic prompt variants for both strategies
  - Edge cases (empty description, structural difference between strategies)

- **5 integration tests** in `generate-image-provider.test.ts`:
  - `buildImagePrompt` routes correctly per IMAGE_ENTRY
  - `buildRealisticPrompt` routes correctly per IMAGE_ENTRY
  - Same input produces structurally different output for each model

- **Full regression**: 794 tests across 42 files, all passing

## Usage

No configuration changes needed. The router uses the existing `IMAGE_ENTRY` environment variable:

```bash
# Use Gemini (structured prompt)
IMAGE_ENTRY=AIHUBMIX npx minase generate

# Use Grok (narrative prompt)
IMAGE_ENTRY=FAI npx minase generate
```
