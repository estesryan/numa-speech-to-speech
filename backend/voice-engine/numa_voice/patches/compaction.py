"""Fix: long-conversation history compaction fails with Qwen3.5 on MLX (upstream speech-to-speech 1.1.0 defect).

After `chat_size` user turns upstream summarizes older history with the LLM. Its MLX code path builds the prompt
with `apply_chat_template(..., add_generation_prompt=True)` but, unlike its Transformers path, without
`enable_thinking=False`. Qwen3.5 then writes a "Thinking Process:" preamble instead of the JSON summary, parsing
fails ("Chat compaction failed; chat unchanged"), the history keeps growing, and the attempt repeats on every
later turn while holding the process-wide MLX lock for ~6.6 s, blocking speech recognition and synthesis.

The fix is the one missing argument. This module replaces `LanguageModelHandler._build_compaction_generate_fn`
with a copy of upstream's MLX branch that passes it, and delegates every other backend to the original.
"""

from __future__ import annotations

from speech_to_speech.LLM import language_model as lm

from . import require, require_source

require(lm.LanguageModelHandler, "_build_compaction_generate_fn")
_ORIGINAL = lm.LanguageModelHandler._build_compaction_generate_fn
# what the replacement copies from upstream's MLX branch
_MLX_BRANCH = ('if self.backend == "mlx":', "self.model", "self.tokenizer", "max_tokens = 1024",
               'MLXLockContext(handler_name="MLX-compact", timeout=10.0)', "mlx_generate(")


def upstream_is_affected() -> bool:
    source = require_source(_ORIGINAL, *_MLX_BRANCH)
    mlx_branch = source.split(_MLX_BRANCH[0], 1)[1].split("else:", 1)[0]
    return "apply_chat_template" in mlx_branch and "enable_thinking" not in mlx_branch


def _build_compaction_generate_fn(self):  # noqa: ANN001, ANN202 - mirrors upstream's signature
    if self.backend != "mlx":
        return _ORIGINAL(self)
    from mlx_lm import generate as mlx_generate
    from speech_to_speech.utils.mlx_lock import MLXLockContext

    model, tokenizer = self.model, self.tokenizer
    max_tokens = 1024  # upstream's value

    def generate_mlx(system: str, user: str) -> str:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True,
                                               enable_thinking=False)
        with MLXLockContext(handler_name="MLX-compact", timeout=10.0):
            return mlx_generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens, verbose=False)

    return generate_mlx


def apply() -> str:
    if not upstream_is_affected():
        return "compaction: upstream already passes enable_thinking on MLX; patch not needed"
    lm.LanguageModelHandler._build_compaction_generate_fn = _build_compaction_generate_fn
    return "compaction: MLX history compaction now disables Qwen thinking (enable_thinking=False)"
