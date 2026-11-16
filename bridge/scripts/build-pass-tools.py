#!/usr/bin/env python3
"""Mirror the original stdio PASS schemas into HTTP Actions and remote MCP.

No credentials or runtime state are read. Existing Action operations stay byte
for byte intact outside the generated block.
"""
import importlib.util
import json
from pathlib import Path
import re
import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pass_source", ROOT / "mcp/school_bridge_mcp.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
tools = []
for original in source.PASS_TOOLS:
    tool = dict(original)
    tool["annotations"] = {"readOnlyHint": tool["name"] != "save_pass", "destructiveHint": False,
                           "idempotentHint": True, "openWorldHint": False}
    tool["outputSchema"] = {"type": "object", "additionalProperties": True}
    tools.append(tool)
(ROOT / "pass-tool-schema.json").write_text(json.dumps(tools, indent=2, ensure_ascii=False) + "\n")

descriptions = {
    "get_pass_protocol": "Read the latest original PASS protocol before Save/Resume a PASS. Its storage bucket does not limit its all-class scope.",
    "list_passes": "Discover canonical classes and retained PASS summaries. Resolve topic/date requests through these summaries, then read the selected record. Follow next_cursor.",
    "read_pass": "Read an exact original PASS, preserving provenance and portable Markdown. Missing or unavailable records are errors, never invented memory.",
    "resume_pass": "Resume by named class or exact session/record. Resolve ambiguity before continuing. Read the protocol first; source and saved facts never prove mastery or submission.",
    "save_pass": "Save requested factual PASS with sources and a next action. Require current revision and a stable retry key. Confirm only after matching receipt/readback. No learning/progress changes. Sandbox is only for explicit synthetic tests.",
}
paths = {}
for tool in tools:
    parts = tool["name"].split("_")
    operation = parts[0] + "".join(p.title() for p in parts[1:])
    paths["/pass/tools/" + tool["name"]] = {"post": {
        "operationId": operation,
        "summary": tool["name"].replace("_", " ").capitalize(),
        "description": descriptions[tool["name"]],
        "x-openai-isConsequential": tool["name"] == "save_pass",
        "requestBody": {"required": True, "content": {"application/json": {"schema": tool["inputSchema"]}}},
        "responses": {"200": {"description": "Complete PASS result, including fresh readback for confirmed saves.",
            "content": {"application/json": {"schema": {"type": "object", "additionalProperties": True,
                "properties": {"ok": {"type": "boolean"}, "error": {"type": "string"}, "markdown": {"type": "string"},
                    "operation_id": {"type": "string"}, "revision": {"type": "integer"}, "save_confirmation": {"type": "string"},
                    "record": {"type": "object"}, "recorded": {"type": "object"}, "records": {"type": "array", "items": {"type": "object"}},
                    "next_cursor": {"type": ["string", "null"]}, "retry_arguments": {"type": "object"}}}}}},
            "400": {"description": "Invalid or ambiguous input; nothing confirmed saved."},
            "401": {"description": "Original authorization required."},
            "409": {"description": "Revision or operation-key conflict. Reread before a new correction."},
            "503": {"description": "Unavailable/unconfirmed; retain the exact retry packet."}},
    }}
schema = ROOT / "gpt-action-schema.yaml"
text = schema.read_text()
text = re.sub(r"(?ms)^  # BEGIN GENERATED PASS ACTIONS\n.*?^  # END GENERATED PASS ACTIONS\n", "", text)
block = yaml.safe_dump(paths, sort_keys=False, allow_unicode=True, width=110)
block = "  # BEGIN GENERATED PASS ACTIONS\n" + "\n".join("  " + line if line else "" for line in block.splitlines()) + "\n  # END GENERATED PASS ACTIONS\n"
text = text.replace("paths:\n", "paths:\n" + block, 1)
text = re.sub(r"(?m)^  version: 1\.[0-9]+\.[0-9]+$", "  version: 1.4.0", text, count=1)
schema.write_text(text)
print("Generated five PASS HTTP Action schemas and remote MCP tool definitions.")
