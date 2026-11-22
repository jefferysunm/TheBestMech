#!/usr/bin/env python3
"""Replay the kit's recorded stream to a bot and print the slowest answers (tick, ms). Usage: latency.py [--map-dir D] -- cmd..."""
import gzip, json, subprocess, sys, time, os, threading, queue
args = sys.argv[1:]
mapdir = None
if args and args[0] == "--map-dir":
    mapdir = args[1]; args = args[2:]
if args and args[0] == "--": args = args[1:]
here = os.path.dirname(os.path.abspath(__file__))
msgs = [json.loads(l) for l in gzip.open(os.path.join(here, "../kit/check/stream.jsonl.gz"), "rt") if l.strip()]
hello = msgs[0]; obs = [m for m in msgs if m.get("type") == "obs"]
hello["map"]["dir"] = mapdir or os.path.join(here, "../kit/arena")
p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
q = queue.Queue()
threading.Thread(target=lambda: [q.put((time.perf_counter(), l)) for l in p.stdout], daemon=True).start()
p.stdin.write((json.dumps(hello) + "\n").encode()); p.stdin.flush()
q.get(timeout=20)
times = []
for o in obs:
    t0 = time.perf_counter()
    p.stdin.write((json.dumps(o) + "\n").encode()); p.stdin.flush()
    t1, _ = q.get(timeout=5)
    times.append(((t1 - t0) * 1000, o["tick"]))
p.stdin.write((json.dumps(msgs[-1]) + "\n").encode()); p.stdin.close(); p.wait(timeout=5)
s = sorted(times, reverse=True)
print("slowest:", ", ".join(f"tick {t}: {ms:.1f}ms" for ms, t in s[:8]))
print("first 5:", ", ".join(f"{ms:.1f}" for ms, t in times[:5]))
