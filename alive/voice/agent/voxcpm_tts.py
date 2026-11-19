"""VoxCPM HTTP TTS for LiveKit Agents.

Talks to the OpenAI-compatible server at VOXCPM_URL
(POST /v1/audio/speech and /v1/audio/speech/stream).

Why this plugin does its own text chunking instead of using the framework's
sentence tokenizer:

    实测（probe_sentstream.py）：blingfire 的流式 SentenceTokenizer 在收到
    「哦好，我看一眼哈～」这种**没有句末标点**的短句时，一个字都不吐，一直到
    ``end_input()``。而在工具轮里 ``end_input()`` 要等 tool_call 执行完才来
    （agent.log 实测：turn committed 9.800s → tool 完成 11.898s → 首音 11.973s）。
    也就是说，句子分词器把首字拖到了工具之后，跟 TTS 本身无关。

    VoxCPM 的 /stream 端点首块只要 70-80ms，所以这里改成**分句边界 + 空闲超时**
    的切分器：只要文本攒到一个逗号/句号，或者静置 250ms 没有新 token，就立刻把这
    一段送去合成。首字因此只等「LLM 吐出第一个分句」的时间，不再等整轮结束。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import dataclass

import aiohttp
from livekit.agents import APIConnectOptions, APIStatusError, DEFAULT_API_CONNECT_OPTIONS
from livekit.agents.tts import ChunkedStream, SynthesizeStream, TTS, TTSCapabilities
from livekit.agents.utils import aio

TARGET_SAMPLE_RATE = 24000

#: 逗号级边界：文本攒到这些字符之一就可以先合成一段，不必等句号。
#: ～/~ 也算 —— 中文口语过渡语常以它收尾（「哦好，我看一眼哈～」），
#: 不算边界的话整句要等空闲超时才能出门，白白多 150ms。
CLAUSE_BREAKS = "，、；：,;:。！？!?…～~\n"
#: 一段文本的最大字符数：没有标点的长句也要在攒够这么多后切一刀，别一直憋着。
MAX_CHUNK_CHARS = 24
#: 最小段长：比这短的片段（如「哦好，」）不单独合成 —— VoxCPM 单独读三个字听着突兀，
#: 让它在缓冲区里再等一两个 token，等句末标点或 flush 时一起走。
MIN_BREAK_CHARS = 6
#: 静置多久没有新 token 就把手上的文本先发出去（LLM 卡顿/工具轮时最关键）。
#: 只在缓冲区已够 MIN_BREAK_CHARS 时生效；太短的片段等 flush 哨兵，不硬凑。
IDLE_FLUSH_S = 0.15
#: 饿死兜底：缓冲区一直太短但也没有 flush 哨兵时，最多再等这么久就强制送出去。
#: 宁可读三个字也别彻底没声音 —— 哨兵缺失属于框架异常，不能让它静默成「不说话」。
STALL_FLUSH_S = 0.8
#: 收尾引号/括号：切点时把它们挂在前一段末尾，不要单独留成 `」` 这种一字片段。
TRAILING_CLOSERS = "」』”’）)》]｝}】〉"


@dataclass
class VoxCPMOptions:
    url: str
    voice: str
    sample_rate: int


class VoxCPMHttpTTS(TTS):
    def __init__(
        self,
        *,
        url: str | None = None,
        voice: str | None = None,
        sample_rate: int = TARGET_SAMPLE_RATE,
        control_provider=None,
    ) -> None:
        super().__init__(
            capabilities=TTSCapabilities(streaming=True),
            sample_rate=sample_rate,
            num_channels=1,
        )
        self._opts = VoxCPMOptions(
            url=(url or os.getenv("VOXCPM_URL", "http://127.0.0.1:8000")).rstrip("/"),
            voice=(voice or os.getenv("VOXCPM_VOICE", "default")).strip() or "default",
            sample_rate=sample_rate,
        )
        # Called once per request, right before the POST. It must be a pure in-memory
        # read: anything that awaits or touches disk here would land on the
        # user-speaks→first-audio path, which the card forbids.
        self._control_provider = control_provider
        self._http_session: aiohttp.ClientSession | None = None

    @property
    def provider(self) -> str:
        return "voxcpm"

    @property
    def model(self) -> str:
        return "VoxCPM2"

    def synthesize(self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> ChunkedStream:
        return _VoxCPMChunkedStream(tts=self, input_text=text, conn_options=conn_options)

    def stream(self, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) -> SynthesizeStream:
        return _VoxCPMSynthesizeStream(tts=self, conn_options=conn_options)

    async def aclose(self) -> None:
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
        self._http_session = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(force_close=True),
                timeout=aiohttp.ClientTimeout(total=120, sock_read=60),
            )
        return self._http_session


async def _post_stream(tts: VoxCPMHttpTTS, text: str, request_id: str, output_emitter):
    """POST one chunk to /stream and push every PCM chunk straight through."""
    sess = await tts._ensure_session()
    payload = {"input": text, "voice": tts._opts.voice, "response_format": "pcm"}
    control = tts._control_provider() if tts._control_provider else None
    if control:
        payload["control"] = control
    async with sess.post(f"{tts._opts.url}/v1/audio/speech/stream", json=payload) as resp:
        if resp.status >= 400:
            body = await resp.text()
            raise APIStatusError(
                f"VoxCPM {resp.status}: {body[:200]}",
                status_code=resp.status,
                request_id=request_id,
                body=body,
            )
        # iter_any() rather than iter_chunked(4096): the server yields one PCM chunk per
        # autoregressive step (~100ms of audio), and re-chunking to 4096 bytes would add
        # up to one buffer's worth of delay on the very first audio the user hears.
        async for chunk in resp.content.iter_any():
            if not chunk:
                continue
            if len(chunk) % 2:
                chunk = chunk[:-1]
            if chunk:
                output_emitter.push(chunk)


def _speakable(text: str) -> bool:
    """这一段是否值得单独送进 TTS。

    纯标点/引号（`」`、`。` 这种被切点漏下的残留）合成出来是一声怪音，干脆不发；
    它已经在前一段的语音里起过作用了。
    """
    return any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in text)


def split_ready(buffer: str, *, force: bool) -> tuple[str, str]:
    """切出一段可以立刻合成的文本，返回 (ready, rest)。

    ``force=False``（LLM 还在吐字）：只在**够长的标点边界**或达到 MAX_CHUNK_CHARS 时切，
    否则攒着 —— 把「哦好，」这种三字片段单独送进 VoxCPM 会读得突兀。

    ``force=True``（flush 哨兵 / 空闲超时 / 流结束）：把手上这一整段都送出去，
    但仍受 MAX_CHUNK_CHARS 上限约束（否则一大段会变成一次很慢的合成）。
    这里不按 MIN_BREAK_CHARS 拦 —— 已经在迟发，再切碎只会更慢。
    """
    if not buffer.strip():
        return "", buffer
    cut = -1
    for i, ch in enumerate(buffer):
        if ch in CLAUSE_BREAKS:
            cut = i + 1  # 标点留在前一段，避免语气被截断
    if cut > 0 and cut < len(buffer):
        # 切点后面若紧跟收尾引号，把它一起带走，免得留下 `」` 这种一字片段
        j = cut
        while j < len(buffer) and buffer[j] in TRAILING_CLOSERS:
            j += 1
        if j > cut and j - cut <= 2:
            cut = j
    if force:
        if len(buffer) <= MAX_CHUNK_CHARS:
            return buffer, ""
        if cut >= MIN_BREAK_CHARS:
            return buffer[:cut], buffer[cut:]
        return buffer[:MAX_CHUNK_CHARS], buffer[MAX_CHUNK_CHARS:]
    if cut >= MIN_BREAK_CHARS:
        return buffer[:cut], buffer[cut:]
    if len(buffer) >= MAX_CHUNK_CHARS:
        return buffer[:MAX_CHUNK_CHARS], buffer[MAX_CHUNK_CHARS:]
    return "", buffer


class _VoxCPMChunkedStream(ChunkedStream):
    def __init__(self, *, tts: VoxCPMHttpTTS, input_text: str, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._vox = tts

    async def _run(self, output_emitter) -> None:
        request_id = str(uuid.uuid4())
        text = (self._input_text or "").strip()
        output_emitter.initialize(
            request_id=request_id,
            sample_rate=self._vox.sample_rate,
            num_channels=1,
            mime_type="audio/pcm",
        )
        if not text:
            return
        await _post_stream(self._vox, text, request_id, output_emitter)


class _VoxCPMSynthesizeStream(SynthesizeStream):
    """Clause-level streaming with an idle timeout (see module docstring)."""

    def __init__(self, *, tts: VoxCPMHttpTTS, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=tts, conn_options=conn_options)
        self._vox: VoxCPMHttpTTS = tts

    async def _run(self, output_emitter) -> None:
        request_id = str(uuid.uuid4())
        output_emitter.initialize(
            request_id=request_id,
            sample_rate=self._vox.sample_rate,
            num_channels=1,
            mime_type="audio/pcm",
            stream=True,
        )

        queue: asyncio.Queue[str | None] = asyncio.Queue()
        pending = {"buf": ""}

        async def _flush_ready(force: bool) -> None:
            ready, rest = split_ready(pending["buf"], force=force)
            pending["buf"] = rest
            if _speakable(ready):
                await queue.put(ready)

        async def _reader() -> None:
            starved = 0.0
            try:
                while True:
                    try:
                        item = await asyncio.wait_for(self._input_ch.recv(), timeout=IDLE_FLUSH_S)
                    except asyncio.TimeoutError:
                        # 只把「够长」的缓冲先送出去；太短的等 flush 哨兵，
                        # 否则会把「哦好，」这种三字片段单独合成（听着突兀）。
                        buf = pending["buf"].strip()
                        starved += IDLE_FLUSH_S
                        if len(buf) >= MIN_BREAK_CHARS or starved >= STALL_FLUSH_S:
                            await _flush_ready(force=True)
                            starved = 0.0
                        continue
                    except Exception:
                        break
                    starved = 0.0
                    if isinstance(item, self._FlushSentinel):
                        await _flush_ready(force=True)
                        continue
                    pending["buf"] += item
                    await _flush_ready(force=False)
                await _flush_ready(force=True)
            finally:
                await queue.put(None)

        async def _synth() -> None:
            started = False
            try:
                while True:
                    text = await queue.get()
                    if text is None:
                        break
                    if not started:
                        output_emitter.start_segment(segment_id=str(uuid.uuid4()))
                        started = True
                    self._mark_started()
                    await _post_stream(self._vox, text, request_id, output_emitter)
                    output_emitter.flush()
            finally:
                if started:
                    output_emitter.end_segment()

        reader_task = asyncio.create_task(_reader())
        try:
            await _synth()
        finally:
            await aio.cancel_and_wait(reader_task)
