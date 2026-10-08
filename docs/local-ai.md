# Local / Open-Source AI Setup

StudyOS is **local-first and provider-agnostic**. The AI layer speaks the
OpenAI-compatible `/v1/chat/completions` + `/v1/embeddings` protocol, which every
mainstream local inference server implements. A paid commercial API is **never
required** and is **never the default** — if `AI_BASE_URL` is unset, AI is simply
off and the app stays fully functional and honest about it.

## How it works

```
StudyOS server (Node)
   ↓  AI_BASE_URL (OpenAI-compatible protocol)
Self-hosted inference server (Ollama / llama.cpp / vLLM / LM Studio)
   ↓
Open-source model (GGUF quantized, runs on your hardware)
```

Student course material is sent only to the endpoint **you** configure. With a
local engine, material never leaves your machine/network.

## Environment variables (server-side only)

| Variable         | Required | Example                            | Notes                                          |
| ---------------- | -------- | ---------------------------------- | ---------------------------------------------- |
| `AI_BASE_URL`    | yes      | `http://127.0.0.1:11434/v1`        | Unset = AI disabled (honest `AI_NOT_CONFIGURED`) |
| `AI_API_KEY`     | no       | —                                  | Local servers need **no key**. Only set for an external provider you explicitly opted into. |
| `AI_CHAT_MODEL`  | yes*     | `qwen2.5:3b-instruct`              | Required for chat. Unset → AI honestly reports not configured |
| `AI_EMBED_MODEL` | no       | `nomic-embed-text`                 | Optional; without it BM25 keyword retrieval is used |

Engine state (`local` / `external` / `none`) is derived from the configured host
(localhost / private ranges = `local`) and reported by `GET /api/ai/status`.

## Option A — Ollama (easiest)

1. Install Ollama: <https://ollama.com/download>
2. Pull models:
   ```
   ollama pull qwen2.5:3b-instruct
   ollama pull nomic-embed-text        # optional, enables semantic retrieval
   ```
3. Run StudyOS server with:
   ```
   set AI_BASE_URL=http://127.0.0.1:11434/v1
   set AI_CHAT_MODEL=qwen2.5:3b-instruct
   set AI_EMBED_MODEL=nomic-embed-text
   node dist-server/index.js
   ```
4. Verify: `GET /api/ai/status` → `{ "engine": "local", "configured": true, ... }`

## Option B — llama.cpp server (no install, single binary)

```
llama-server -m qwen2.5-3b-instruct-q4_k_m.gguf --port 8091
set AI_BASE_URL=http://127.0.0.1:8091/v1
```

## Recommended models (smallest capable first)

| Model                          | Quantized size | RAM in use | Runs on          | Good for                                    |
| ------------------------------ | -------------- | ---------- | ---------------- | ------------------------------------------- |
| Qwen2.5-1.5B-Instruct (Q4_K_M) | ~1.0 GB        | ~1.6 GB    | any modern CPU   | Quick summaries, flashcards on old laptops  |
| **Qwen2.5-3B-Instruct (Q4_K_M)** | ~1.9 GB      | ~2.8 GB    | CPU (8GB+ RAM)   | **Default recommendation**: best quality/size balance for concept extraction, quizzes, tutor |
| Qwen2.5-7B-Instruct (Q4_K_M)   | ~4.4 GB        | ~5.8 GB    | CPU slow / GPU ideal | Higher quality tutor + exam analysis     |
| nomic-embed-text               | ~0.27 GB       | ~0.5 GB    | any CPU          | Embeddings for semantic retrieval           |

Qwen2.5 (Apache-2.0) is recommended because it follows JSON-structured output
instructions reliably at small sizes and handles mixed English/Arabic course
material. Llama-3.2-3B-Instruct (Llama license) is a good alternative.

## Verified on real hardware (baseline: Qwen2.5-0.5B-Instruct Q4_K_M)

Measured on a dual-core Intel i7-6600U (2.6 GHz, 20 GB RAM, no GPU), llama.cpp
CPU build, context 8192, 3 threads:

- Generation ~22 tokens/s, prompt processing ~65 tokens/s.
- Full StudyOS E2E pipeline (upload → ingest → concepts → formulas → notes →
  flashcards → quiz → submit → tutor → analysis → summary → what-matters) passed
  21/21 checks in ~158 s wall time against this model — see
  `scripts/local-ai-e2e.mjs`.
- Raw structured-output reliability without app hardening (`scripts/model-probe.mjs`,
  8 representative tasks, no retries/coercion): 3/8 strict-shape. StudyOS's own
  hardening (JSON coercion, shape guards that trigger hardened retries, output
  salvage) lifts the same tasks to full pipeline reliability.
- Larger models (1.5B / 3B Q4_K_M) are recommended when download bandwidth
  permits (~1.0/1.9 GB); a degraded-network attempt in Oct 2026 measured
  <0.2 MB/s (3+ h ETA), so 0.5B remained the verified baseline. The provider
  abstraction is model-agnostic — point `AI_CHAT_MODEL` at any GGUF/Ollama model
  with no code changes.

## Benchmark: Qwen2.5-3B-Instruct Q4_K_M vs 0.5B (Oct 2026)

The 3B model (2.1 GB) was benchmarked on the same hardware with
`scripts/model-probe.mjs` (8 representative tasks, raw output, no app
hardening) plus a full E2E run through the real server pipeline:

| Metric | 0.5B | 3B |
|---|---|---|
| Raw probe pass rate | 3/8 | 4/8 |
| Quiz generation | placeholder text ("a/b/c/d") | real, grounded questions (PASS) |
| Flashcards | wrong shape (single object) | correct array (PASS) |
| Formulas | wrong keys (name=expression) | correct fields (PASS) |
| Tutor (English) | correct but shallow (12.0 s) | deeper, worked example (41.6 s) |
| Tutor (Arabic) | clean Arabic (38.6 s) | garbled loanwords mixed in (70.7 s) |
| Task latency avg | ~22 s | ~91 s (4.2× slower) |
| Generation speed | ~22 tok/s | ~6–9 tok/s |
| Server RAM | ~0.6 GB | ~3.5 GB |
| E2E pipeline | 21/21 | 6 pass / 6 fail (quiz 180 s timeout, ingest stalled, empty concepts/formulas/notes) |

**Decision: keep 0.5B as the default on 2-core CPU hardware.** The 3B
produces genuinely better structured study content (quizzes, flashcards,
formulas), but on this class of hardware it is unreasonably slow: multiple
pipeline stages exceed the 180 s local timeout, and ingestion of a short
lecture did not complete. Arabic output also degraded relative to 0.5B.

3B becomes the right choice when any of these apply: a GPU or ≥4 fast CPU
cores, raising the local timeout above 300 s, or offloading generation to a
faster host behind `AI_BASE_URL`. Switching is configuration-only.

## What works with NO AI engine at all

Course management, upload/storage, PDF/PPTX/DOCX extraction, chunking, BM25
retrieval, manual flashcards + SM-2 review, manual quiz review, weaknesses,
mastery, study sessions, priorities recomputation from stored evidence,
"What actually matters?", "Ask my course" (data-grounded intents), dashboard and
recommendations. All deterministic, all offline.

## What requires the AI engine

Concept/definition/formula extraction from raw material, notes generation, quiz
generation, flashcard generation, tutor answers to open questions, past-exam
analysis, exam simulation. All of these run against your configured endpoint —
local first.

## Browser inference (evaluated, not implemented)

Running models in the browser (WebGPU/transformers.js) was evaluated and
**rejected as the default**: 100 MB–2 GB model downloads per student device,
slow low-end phones, no shared cache between students, and it cannot serve the
server-side batch pipeline (course analysis after upload). Server-side
self-hosted inference is the correct architecture for StudyOS's workload.

## Verdent-hosted deployments

The platform runs one Node container with a single app port — an inference
server cannot run inside it. For hosted deployments, point `AI_BASE_URL` at an
inference server you control (same machine, LAN, or a rented GPU/CPU box). The
app reports `engine: "external"` then; choose a host you trust, because course
material is sent there.
