"""Use DSH's built-in pi-ai provider for managed OpenAI/Anthropic gateways.

The route and native compaction budgets follow the selected model. The DSH
agent, native sandbox, approvals and sessions remain owned by DeepSeek Harness.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import context_window, runtime_images
from .runtime_defaults import DEFAULT_OUTPUT

PROVIDER = "soduwork"
KEY_ENV = "SODUWORK_API_KEY"
PROFILE_ENV = "SODUWORK_DSH_PROVIDERS"
COMPACTION_ENV = "SODUWORK_DSH_COMPACTION"
REASONING_ENV = "SODUWORK_DSH_MANAGED_REASONING"
_THINKING_FORMATS = {"openai", "zai", "deepseek"}
_THINKING_LEVELS = ("minimal", "low", "medium", "high", "xhigh", "max")


def _request_budgets(context_limit: int, requested_output: int) -> tuple[int, dict]:
    # Output and input share the provider's context window. Keep ordinary output
    # limits unchanged, but never reserve the entire window for a completion.
    input_reserve = min(4096, context_limit // 2)
    output_limit = min(requested_output, context_limit - input_reserve)
    message_budget = context_limit - output_limit
    # DSH otherwise reserves 65,536 tokens and asks for a 65,536-token summary,
    # disabling pressure compaction on smaller routes or exceeding output caps.
    summary_limit = min(output_limit, 8192, message_budget // 4)
    instruction_reserve = min(1024, message_budget // 16)
    return output_limit, {
        "auto": True,
        "thresholdRatio": 0.8,
        "retainRatio": 0.16,
        "headroomTokens": summary_limit + instruction_reserve,
        "maxTokens": summary_limit,
    }


def bundle_args() -> list[str]:
    bundle = Path(__file__).with_name("dsh_gateway_bundle")
    if not (bundle / "cordis.patch.yml").is_file() or not (bundle / "package.json").is_file():
        raise RuntimeError("DeepSeek Harness managed gateway adapter is missing; update SoduWork")
    return ["--bundle", str(bundle)]


def _apply_reasoning(profile: dict, llm: dict) -> dict | None:
    """Use the native process-local pi-ai profile for an explicitly selected level."""
    mode = llm.get("thinkingMode")
    wire_format = llm.get("thinkingFormat")
    choices = llm.get("thinkingLevelMap")
    level = llm.get("thinkingLevel")
    if (mode not in ("always", "controllable") or llm.get("reasoning") is not True
            or llm.get("supportsReasoningEffort") is not True
            or not isinstance(wire_format, str) or wire_format not in _THINKING_FORMATS
            or not isinstance(choices, dict)):
        return None
    declared = {key: choices[key].strip() for key in _THINKING_LEVELS
                if isinstance(choices.get(key), str) and choices[key].strip() not in ("", "none", "off")}
    if not declared:
        return None
    if mode == "controllable" and llm.get("thinkingAlwaysOn") is not True and choices.get("off") == "none":
        declared["off"] = "none"
    if level is None or level == "":
        # Reset a prior override from this managed session to provider defaults.
        return {"provider": PROVIDER, "model": profile["models"][0]["id"], "level": ""}
    if not isinstance(level, str) or level not in declared:
        return None
    profile["models"][0]["reasoningEfforts"] = declared
    profile["reasoning"] = level
    profile["compat"].update(supportsReasoningEffort=True, thinkingFormat=wire_format)
    return {"provider": PROVIDER, "model": profile["models"][0]["id"], "level": level}


def inject_env(env: dict, llm: dict) -> None:
    base, secret, model = (str(llm.get(key) or "") for key in ("base", "key", "model"))
    local_only = (llm or {}).get("localOnly") is True
    if not (base and model and (secret or local_only)):
        raise ValueError("DeepSeek Harness requires a managed model endpoint, credential and model")
    protocol = "anthropic-messages" if llm.get("kind") == "anthropic" else "openai-completions"
    context_limit = context_window.resolve(llm)["contextWindow"]
    output_limit, compaction = _request_budgets(
        context_limit, runtime_images.model_fields(llm).get("maxOutputTokens", DEFAULT_OUTPUT))
    profile = {
        "displayName": "SoduWork",
        "baseURL": base.rstrip("/"),
        "api": protocol,
        "models": [{"id": model, "name": model,
                    "input": ["text", "image"] if runtime_images.transport_supported(llm) else ["text"],
                    "contextWindow": context_limit, "maxTokens": output_limit}],
    }
    if secret:
        profile["apiKeyEnv"] = KEY_ENV
    env.pop(REASONING_ENV, None)
    if protocol == "openai-completions":
        profile["compat"] = {"supportsStore": False, "supportsDeveloperRole": False,
                             "supportsReasoningEffort": False, "maxTokensField": "max_tokens"}
        if reasoning := _apply_reasoning(profile, llm):
            env[REASONING_ENV] = json.dumps(reasoning, ensure_ascii=False)
    # A shared model service credential must not become the native DeepSeek search
    # credential, whose separate endpoint remains api.deepseek.com.
    for name in ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"):
        env.pop(name, None)
    if secret:
        env[KEY_ENV] = secret
    else:
        env.pop(KEY_ENV, None)
    env.update({PROFILE_ENV: json.dumps({PROVIDER: profile}, ensure_ascii=False),
                COMPACTION_ENV: json.dumps(compaction),
                "DSH_PROVIDER": PROVIDER, "DSH_MODEL": model, "DSH_ACP_MODELS": model,
                "DSH_MAX_TOKENS": str(output_limit)})
