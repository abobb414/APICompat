#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 mock 中转站 —— 零依赖，只用 Python 标准库。

同源提供页面 + 模型清单 + 各协议探针端点，让整条链路（拉清单 → 交叉实测 → 导出）
可以在**不消耗任何真实额度**的前提下跑通。默认端口 8788。

    python3 tests/mock.py            # 起服务
    python3 tests/mock.py 9000       # 换端口

构造出来的站点刻意保留了几处真实世界里会遇到的形态：

* ``supported_endpoint_types`` **声明**与**实测**不一致 —— 例如 glm / kimi / qwen
  只声明 ``openai``，但 dashscope 兼容路径实际也能跑通（矩阵里会标成 mismatch）；
* ``azure`` / ``cohere`` / ``ollama`` 三个端点一律 404，用来产生「协议不支持」的失败态；
* 各协议带不同的首块延迟区间，避免测出来一片 0 ms。

模型名与延迟区间是构造的，**不是任何真实站点的实测数据**，只用于自测与取景。
"""
import json
import os
import random
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 模型 -> 服务端声明的协议族（supported_endpoint_types）
DECLARED = {
    "deepseek-v4.1-flash": ["openai", "anthropic"],
    "deepseek-v4.1-pro":   ["openai", "anthropic"],
    "deepseek-v4-flash":   ["openai", "anthropic"],
    "glm-5.3":             ["openai"],
    "glm-5.3-air":         ["openai"],
    "kimi-k2.5":           ["openai"],
    "kimi-k2-turbo":       ["openai"],
    "qwen3.5-max":         ["openai"],
    "qwen3.5-plus":        ["openai"],
    "gpt-5.2":             ["openai", "openai-response"],
    "gpt-5.2-mini":        ["openai"],
    "o4-mini":             ["openai", "openai-response"],
    "claude-sonnet-4.5":   ["openai", "anthropic"],
    "claude-opus-4.1":     ["openai", "anthropic"],
    "gemini-3.0-pro":      ["openai", "google"],
    "gemini-3.0-flash":    ["openai", "google"],
}
MODELS = [{"id": k, "object": "model", "supported_endpoint_types": v} for k, v in DECLARED.items()]

# 各协议下上游真正能跑通的模型（故意多于声明，复现「声明 ≠ 实测」）
WORKS = {
    "openai":          lambda m: True,
    "anthropic":       lambda m: "anthropic" in DECLARED[m],
    "openai-response": lambda m: "openai-response" in DECLARED[m],
    "google":          lambda m: m.startswith("gemini"),
    "google-openai":   lambda m: m.startswith("gemini"),
    "dashscope":       lambda m: m.startswith("qwen"),
    "azure":           lambda m: False,
    "ollama":          lambda m: False,
    "cohere":          lambda m: False,
}
# 首个 token 的典型耗时区间（毫秒），按协议区分
LAT = {"openai": (280, 760), "anthropic": (240, 690), "openai-response": (520, 1180),
       "google": (640, 1600), "google-openai": (600, 1400), "dashscope": (420, 980),
       "azure": (300, 600), "ollama": (120, 300), "cohere": (350, 700)}

PATHS = {
    "/v1/chat/completions": "openai",
    "/v1beta/openai/chat/completions": "google-openai",
    "/compatible-mode/v1/chat/completions": "dashscope",
    "/v1/messages": "anthropic",
    "/v1/responses": "openai-response",
    "/v2/chat": "cohere",
    "/api/chat": "ollama",
}

# 故意做得「隔一次就 500」的组合：专供测试「重试了才通过」这条路径。
# 工具只对 5xx / 超时 / 网络错误重试（503 被归为「无可用渠道」，不重试，所以这里用 500）。
# 用奇偶计数而非「只失败第一次」，配合 GET /__reset 就能在任何一轮里稳定复现。
#
# ⚠️ 必须挑 anthropic 侧的组合：假站按「路径 → 协议」判归属，
# 而工具的「自定义协议」也打 /v1/chat/completions（即 openai 路径），
# 若把 flaky 放在 openai 侧，一次测试里两种协议会共用同一个计数器，重试结果就不可复现
# （实测过：glm-5.3 的 openai 列会变成「重试后仍失败」，全是串扰导致的）。
FLAKY = {("claude-sonnet-4.5", "anthropic"), ("claude-opus-4.1", "anthropic")}
HITS = {}


# ── 流式输出的形态 ──
# 早先这里是「2~3 个块、一次性写完」，工具命中首块即断开，看不出区别；
# 但「测速档」要收满采样窗口才算得出吐字速度，所以假站得真的逐字吐：
# 每个内容块 2 个汉字、间隔 50ms、共 24 块 ≈ 1.2s / 48 字，输出速度 ≈ 40 字/秒。
# 这个量级与真实 LLM 的流式输出接近，测试断言因此有个稳定可预期的靶子。
STREAM_BLOCKS = 24
STREAM_DELAY = 0.05
STREAM_TEXT = "模型接口兼容性测试正在逐字输出为的是量出真实的吐字速度"


def word(i):
    p = (i * 2) % len(STREAM_TEXT)
    return STREAM_TEXT[p:p + 2]


def sse(objs, delay=STREAM_DELAY):
    for o in objs:
        yield ("data: " + json.dumps(o, ensure_ascii=False) + "\n\n").encode()
        time.sleep(delay)
    yield b"data: [DONE]\n\n"


def openai_chunks(m):
    out = [{"id": "cc-1", "object": "chat.completion.chunk", "model": m,
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}}]}]
    for i in range(STREAM_BLOCKS):
        out.append({"id": "cc-1", "object": "chat.completion.chunk", "model": m,
                    "choices": [{"index": 0, "delta": {"content": word(i)}, "finish_reason": None}]})
    out.append({"id": "cc-1", "object": "chat.completion.chunk", "model": m,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
    return out


def anthropic_chunks(m):
    out = [
        {"type": "message_start", "message": {"id": "msg_1", "role": "assistant", "content": [], "model": m}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    ]
    for i in range(STREAM_BLOCKS):
        out.append({"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": word(i)}})
    out.append({"type": "content_block_stop", "index": 0})
    return out


def responses_chunks(m):
    out = [{"type": "response.created", "response": {"id": "resp_1", "object": "response", "model": m}}]
    for i in range(STREAM_BLOCKS):
        out.append({"type": "response.output_text.delta", "delta": word(i)})
    return out


def google_chunks(m):
    return [{"candidates": [{"content": {"parts": [{"text": word(i)}], "role": "model"}}]}
            for i in range(STREAM_BLOCKS)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/index.html"):
            page = os.path.join(ROOT, "index.html")
            return self._send(200, open(page, "rb").read(), "text/html; charset=utf-8")
        if p == "/v1/models":
            return self._send(200, json.dumps({"object": "list", "data": MODELS}).encode())
        if p == "/v1beta/models":
            data = [{"name": "models/" + m, "displayName": m} for m in DECLARED]
            return self._send(200, json.dumps({"models": data}).encode())
        if p == "/__reset":
            HITS.clear()
            return self._send(200, json.dumps({"ok": True, "reset": True}).encode())
        self._send(404, json.dumps({"error": {"message": "not found"}}).encode())

    def do_POST(self):
        p = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            req = {}
        model = req.get("model") or "unknown"

        if model not in DECLARED:
            return self._send(404, json.dumps(
                {"error": {"message": "The model `%s` does not exist" % model, "code": "model_not_found"}}).encode())

        if "/openai/deployments/" in p:
            proto = "azure"
        elif "/v1beta/models/" in p:
            proto = "google"
        else:
            proto = PATHS.get(p)
        if proto is None:
            return self._send(404, json.dumps({"error": {"message": "path not implemented"}}).encode())

        lo, hi = LAT[proto]
        time.sleep(random.uniform(lo, hi) / 1000.0)

        if not WORKS[proto](model):
            if proto in ("azure", "cohere", "ollama"):
                return self._send(404, json.dumps({"error": {"message": "no such route"}}).encode())
            return self._send(400, json.dumps(
                {"error": {"message": "unsupported_endpoint", "code": "unsupported_endpoint"}}).encode())

        key = (model, proto)
        HITS[key] = HITS.get(key, 0) + 1
        if key in FLAKY and HITS[key] % 2 == 1:
            return self._send(500, json.dumps(
                {"error": {"message": "upstream read timeout, please retry", "code": "server_error"}}).encode())

        if proto == "ollama":
            body = json.dumps({"model": model, "message": {"role": "assistant", "content": "OK"},
                               "done": True}).encode() + b"\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return self.wfile.write(body)

        chunks = {"anthropic": anthropic_chunks, "openai-response": responses_chunks,
                  "google": google_chunks}.get(proto, openai_chunks)(model)
        self._stream(chunks)

    def _stream(self, chunks):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        # 工具命中首块（快速档）或收满窗口（测速档）就会主动断开，
        # 这是预期行为 —— 这里静默收场，别把 BrokenPipe 刷满日志。
        try:
            for b in sse(chunks):
                self.wfile.write(b"%X\r\n%s\r\n" % (len(b), b))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    random.seed(20261003)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("mock relay  →  http://127.0.0.1:%d/  (%d models)" % (port, len(MODELS)))
    print("serving page from %s" % os.path.join(ROOT, "index.html"))
    srv.serve_forever()


if __name__ == "__main__":
    main()
