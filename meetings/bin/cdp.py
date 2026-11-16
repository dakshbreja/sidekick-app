import json, sys, time, urllib.request
import websocket

def targets(timeout=10):
    with urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=timeout) as response:
        return json.load(response)

def find_page(substr):
    for t in targets():
        if t.get("type") == "page" and substr in t.get("url", ""):
            return t
    raise SystemExit("no page target matching %r" % substr)

def evaluate(ws_url, expr, timeout=60):
    deadline = time.monotonic() + timeout
    ws = websocket.create_connection(ws_url, timeout=timeout, max_size=200*1024*1024, suppress_origin=True)
    try:
        def remaining():
            budget = deadline - time.monotonic()
            if budget <= 0:
                raise TimeoutError("CDP operation deadline reached")
            ws.settimeout(budget)
        remaining()
        ws.send(json.dumps({
            "id": 1, "method": "Runtime.evaluate",
            "params": {"expression": expr, "awaitPromise": True,
                       "returnByValue": True, "allowUnsafeEvalBlockedByCSP": True},
        }))
        while True:
            remaining()
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                return msg
    finally:
        ws.close(timeout=0)

if __name__ == "__main__":
    page = find_page(sys.argv[1] if len(sys.argv) > 1 else "#/dashboard")
    expr = sys.stdin.read()
    res = evaluate(page["webSocketDebuggerUrl"], expr)
    r = res.get("result", {})
    if "exceptionDetails" in r:
        print("EXCEPTION:", json.dumps(r["exceptionDetails"])[:2000]); sys.exit(1)
    val = r.get("result", {}).get("value")
    print(val if isinstance(val, str) else json.dumps(val, indent=2)[:200000])
