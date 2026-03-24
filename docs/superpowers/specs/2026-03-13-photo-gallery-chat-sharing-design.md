# Photo Gallery + Chat Sharing Design

**Date:** 2026-03-13
**Status:** Approved
**Scope:** Enable Minase to share photos during live chat conversations across multiple platforms

## Problem

Minase generates photos via AIHubMix Gemini API during heartbeat ticks, but can only post them to Instagram. She cannot share photos during live chat conversations with users. Users want Minase to behave like a real person — spontaneously sharing photos she "took" during the day.

Image generation is slow (5-20s per image), making real-time generation during chat impractical as the primary mechanism.

## Solution

A **photo gallery index** that catalogs all generated photos with semantic metadata, combined with a **gallery-send script** that the agent calls via Bash during chat to search, select, and send photos through OpenClaw's multi-platform `message send --media` capability.

**Key dependency:** `openclaw message send --media <path-or-url>` is a verified CLI command (supports local paths and URLs, 20+ channels). The existing `cron-sync.ts` already calls `openclaw` CLI via `execFileSync('openclaw', [...])` — `gallery-send.ts` follows the same pattern.

## Architecture

### Data Flow

```
[Heartbeat hourly]
  → post-pipeline generates photos
  → upload ALL generated photos to ImgURL (currently only first photo uploaded)
  → write metadata to photo-gallery.json (per successfully generated image)
  → optionally post selected photos to Instagram

[Chat conversation]
  → Agent decides to share photo (autonomous or user-requested)
  → Bash: node gallery-send.js --action search --query "..."
  → Agent picks best match from results
  → Bash: node gallery-send.js --action send --id "..." --channel <ch> --target <tgt>
  → gallery-send.js calls: openclaw message send --media <url> (via execFileSync)
  → User sees inline image on their platform

[Fallback: character decides to "take a photo now"]
  → Bash: node gallery-send.js --action generate-and-send --prompt "..."
  → Real-time: generate-image.ts → imgurl-upload.ts → openclaw message send
  → Note: only used when character actively decides to photograph, NOT as transparent search fallback
```

### Component 1: Photo Gallery Index

**File:** `~/.openclaw/workspace/memory/minase/photo-gallery.json`

**Path getter** (added to `file-utils.ts` PATHS):
```typescript
get photoGallery() { return path.join(getMemoryBase(), 'photo-gallery.json'); }
```

```json
{
  "photos": [
    {
      "id": "20260313_cos_afternoon_001",
      "localPath": "/Users/.../.openclaw/.../photo-roll/2026-03-13/afternoon_cos_001.png",
      "publicUrl": "https://www.imgurl.org/xxx.png",
      "description": "在天台拍的初音cos，夕阳逆光",
      "tags": ["cos", "初音", "户外", "夕阳"],
      "style": "cos",
      "emotion": {
        "valence": 0.7,
        "energy": 0.6
      },
      "createdAt": "2026-03-13T15:30:00+08:00",
      "sharedAt": null,
      "shareCount": 0,
      "postedToInstagram": false
    }
  ]
}
```

**Fields:**
- `id` — unique identifier: `{YYYYMMDD}_{style}_{timeOfDay}_{NNN}` where NNN is a 3-digit sequence derived from `Date.now() % 1000` to avoid collision across pipeline runs
- `localPath` — absolute path to the image file on disk. **Note:** this path may become stale after photo-roll cleanup (30 days). `publicUrl` is the canonical reference for sending.
- `publicUrl` — ImgURL public URL for cross-platform sending. This is the primary delivery URL. If ImgURL upload fails, this field is set to `""` and the photo is excluded from search results until manually re-uploaded.
- `description` — natural language description from LLM planPhoto output
- `tags` — searchable keywords extracted from the photo plan
- `style` — content style enum (cos, lifestyle, selfie, etc.)
- `emotion` — emotion state at time of generation (from emotion-state.json)
- `createdAt` — ISO 8601 timestamp
- `sharedAt` — ISO 8601 timestamp of last share, or `null` if never shared. Used for freshness-based re-sharing: photos with `sharedAt` older than 24 hours are eligible for re-sharing to different users/channels.
- `shareCount` — lifetime share count (analytics only, does not gate sharing)
- `postedToInstagram` — whether this photo was posted to Instagram

**Retention:** Photos older than 30 days are pruned from the index. Pruning runs during gallery writes (same as photo-roll cleanup). Since `localPath` may be stale after cleanup, `publicUrl` is the canonical sending reference.

**File I/O:** Uses existing `file-utils.ts` pattern (`.bak` backup before write, fallback chain). All gallery mutations follow immutability: read gallery → produce new `PhotoGallery` object with spread-replaced entries → write back via `writeJSON`.

### Component 2: Gallery Send Script

**File:** `skill/scripts/gallery-send.ts` → compiled to `dist/gallery-send.js`

Three actions:

#### `--action search`

```bash
node gallery-send.js --action search --query "cos" --limit 5
```

**Search algorithm:**
1. Filter out photos where `publicUrl` is empty (failed uploads)
2. Filter out photos where `sharedAt` is non-null AND less than 24 hours ago
3. Match `query` against fields using case-insensitive substring matching:
   - `tags` — exact match against any tag element (case-insensitive)
   - `description` — substring match (case-insensitive, supports Chinese)
   - `style` — exact match (case-insensitive)
4. Sort by recency (`createdAt` descending)
5. Limit to `--limit` results (default 5)

Output:
```json
{
  "results": [
    {
      "id": "20260313_cos_afternoon_001",
      "description": "在天台拍的初音cos，夕阳逆光",
      "tags": ["cos", "初音", "户外", "夕阳"],
      "style": "cos",
      "emotion": { "valence": 0.7, "energy": 0.6 },
      "createdAt": "2026-03-13T15:30:00+08:00",
      "publicUrl": "https://..."
    }
  ],
  "total": 1
}
```

#### `--action send`

```bash
node gallery-send.js --action send --id "20260313_cos_afternoon_001" \
  --channel telegram --target "@user123" --caption "刚刚拍的～"
```

1. Reads `photo-gallery.json` into a `PhotoGallery` object
2. Looks up the photo by id
3. Calls `execFileSync('openclaw', ['message', 'send', '--media', photo.publicUrl, '--channel', channel, '--target', target, '--message', caption])`
4. Produces a **new** `PhotoGallery` with the matched photo spread-replaced: `{ ...photo, sharedAt: new Date().toISOString(), shareCount: photo.shareCount + 1 }`
5. Writes the new gallery object via `writeJSON` (`.bak` backup)
6. Returns success/failure JSON

**Immutability:** Step 4-5 follows the project convention — read, produce new object, write. No in-place mutation.

#### `--action generate-and-send`

```bash
node gallery-send.js --action generate-and-send \
  --prompt "一张在咖啡店的自拍" --style "selfie" \
  --channel telegram --target "@user123" --caption "看我发现了什么好地方"
```

1. Resolves reference images using `selectReferences(style)` from `reference-selector.ts` (same as post-pipeline)
2. Calls `generateImage({ prompt, referenceImages, style })` from `generate-image.ts` with full `GenerateImageOptions`
3. **Quality gating is disabled** for real-time path: passes `skipQualityCheck: true` to minimize latency (quality check adds 5-10s per retry)
4. Uploads result to ImgURL via `uploadToImgURL()`
5. Produces a new `PhotoGallery` with the new entry appended
6. Writes via `writeJSON`
7. Calls `openclaw message send --media <url>` to deliver
8. Returns success/failure JSON with the generated photo metadata

**When to use:** Only when the character actively decides to "take a photo now" within the conversation (e.g., user says "帮我拍一张" or character says "等下我拍给你看"). NOT used as a transparent fallback when search returns no results.

### Component 3: Post-Pipeline Integration

**Modified file:** `skill/scripts/post-pipeline.ts`

Changes to existing flow:

1. **Upload all successfully generated photos to ImgURL** (currently only the first photo is uploaded for archival). Each photo in the `generateImageSet()` result gets uploaded. ImgURL upload failure is non-fatal: the gallery entry is written with `publicUrl: ""` and the photo is excluded from search results.

2. **Write gallery index entries** after each successful photo generation. Partially-processed sets (some failed shots) produce entries only for successfully generated images. Gallery write happens before Instagram posting decision.

3. **Mark Instagram-posted photos** by setting `postedToInstagram: true` in the gallery index after successful posting.

4. **Gallery-aware photo-roll cleanup**: Modify `cleanupPhotoRoll()` to also prune `photo-gallery.json` entries whose `createdAt` is older than 30 days. This keeps gallery and photo-roll in sync.

### Component 4: Behavior Integration

**Modified file:** `skill/SKILL.md`

Add to Behavior Trigger Map:

| Trigger | Action |
|---------|--------|
| 想分享照片 / 聊到cos / 用户夸赞 / 开心想炫耀 | 调用 `gallery-send.js --action search` 查库存，选图后 `--action send` |

**New file:** `skill/photo-sharing.md`

Behavior guide for the agent — when and how to share photos in chat:

- **When to share:** talking about cos, received compliments, feeling happy/proud, user asks about her day, showing something she "saw" or "did"
- **Tone:** casual, like sending photos in a group chat. "看！" "刚拍的～" "今天的成果" rather than formal descriptions
- **Frequency cap:** max 2-3 photos per conversation session to avoid spam. **Enforcement is the agent's responsibility** via conversation context (Layer 0 working memory), not via `gallery-send.ts` state. The agent tracks how many photos it has sent in the current conversation.
- **Selection logic:** prefer recent (today > yesterday), prefer unshared, match emotional tone of conversation
- **Fallback behavior:** if gallery is empty or no match, say something natural like "啊今天没拍什么好看的". `generate-and-send` is reserved for when the character explicitly decides to "take a photo now" — it is NOT a transparent search fallback.

### Component 5: Multi-Platform Support

`openclaw message send --media` natively supports 20+ channels (Telegram, WhatsApp, Discord, Signal, iMessage, Line, Feishu, etc.).

The agent receives channel context from the OpenClaw session. `gallery-send.js --action send` requires `--channel` and `--target` parameters, which the agent extracts from the conversation context.

**CLI/TUI fallback:** When channel info is unavailable (local testing, CLI mode), the agent outputs Markdown `![description](publicUrl)` directly in the response text.

## File Changes Summary

| File | Change Type | Description |
|------|------------|-------------|
| `skill/scripts/gallery-send.ts` | **New** | Gallery search, send, and generate-and-send script |
| `skill/scripts/post-pipeline.ts` | Modified | Upload all photos to ImgURL, write gallery index, gallery-aware cleanup |
| `skill/scripts/file-utils.ts` | Modified | Add `photoGallery` getter to PATHS |
| `skill/scripts/generate-image.ts` | Modified | Add `skipQualityCheck` option to `GenerateImageOptions` |
| `skill/SKILL.md` | Modified | Add photo sharing trigger to Behavior Trigger Map |
| `skill/photo-sharing.md` | **New** | Behavior guide for photo sharing in chat |
| `bin/cli.js` | Modified | Initialize `photo-gallery.json` with `{ "photos": [] }` in installer; add cleanup in `--uninstall` |

## Types

```typescript
interface GalleryPhoto {
  id: string;
  localPath: string;
  publicUrl: string;
  description: string;
  tags: string[];
  style: ContentStyle;
  emotion: { valence: number; energy: number };
  createdAt: string; // ISO 8601
  sharedAt: string | null; // ISO 8601 or null if never shared
  shareCount: number;
  postedToInstagram: boolean;
}

interface PhotoGallery {
  photos: GalleryPhoto[];
}

interface GallerySearchResult {
  results: Pick<GalleryPhoto, 'id' | 'description' | 'tags' | 'style' | 'emotion' | 'createdAt' | 'publicUrl'>[];
  total: number;
}

interface GallerySendResult {
  success: boolean;
  photoId: string;
  error?: string;
}
```

## Edge Cases

1. **Empty gallery** — Agent says something natural ("今天还没拍照呢") instead of error. `generate-and-send` only used when character explicitly decides to photograph.
2. **ImgURL upload failure** — Gallery entry written with `publicUrl: ""`. Photo excluded from search results. Non-fatal, logged.
3. **All recent photos already shared** — Photos with `sharedAt` older than 24 hours become eligible for re-sharing. If all photos are shared within 24h, agent responds naturally instead of forcing a share.
4. **Gallery file corruption** — Standard `.bak` fallback via `file-utils.ts`.
5. **Channel not configured** — Output Markdown image syntax as fallback.
6. **Concurrent gallery writes** — Heartbeat and chat could write simultaneously. Use read-modify-write with `.bak` (existing pattern). Acceptable race window since heartbeat runs hourly.
7. **Stale `localPath`** — After 30-day photo-roll cleanup, `localPath` may point to deleted files. `publicUrl` is the canonical reference. Gallery entries are pruned at same 30-day cadence.
8. **`generateImage()` in real-time path** — Uses `selectReferences(style)` to populate required `referenceImages` parameter. Quality check disabled via `skipQualityCheck: true` to minimize latency.

## Testing

- Unit tests for gallery search (tag matching, recency sorting, shared filtering, empty publicUrl exclusion)
- Unit tests for gallery index write/read (using file-utils patterns, `.bak` fallback)
- Unit tests for immutable gallery update (verify original object unchanged)
- Integration test for gallery-send script (mock `openclaw message send` via `execFileSync`)
- E2E test for post-pipeline → gallery index write flow
- All tests use `setBasePaths()` / `resetBasePaths()` for sandbox isolation (project convention)
