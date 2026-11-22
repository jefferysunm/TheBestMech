#!/bin/bash
# A/B: compare a git ref (default HEAD) against the working tree on the same seeds.
# usage: tools/ab.sh [ref] [matches-per-proc] [roster] [seed0]
REF=${1:-HEAD}; N=${2:-40}; R=${3:-mine:1,brawler:15}; S0=${4:-10000}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WT=$(mktemp -d)
git -C "$ROOT" worktree add -q --detach "$WT" "$REF" >/dev/null 2>&1
cp -r "$ROOT/kit" "$WT/" 2>/dev/null
echo "A=$REF  B=working tree  roster=$R  matches=$((N*4))"
for side in A B; do
  DIR=$WT; [ $side = B ] && DIR=$ROOT
  OUT=$(mktemp -d)
  for p in 0 1 2 3; do (cd "$DIR" && bun sim/run.ts --n $N --seed $((S0 + p*1000)) --roster "$R" > $OUT/$p.txt 2>&1) & done
  wait
  python3 - "$OUT" "$side" <<'PY'
import sys,glob,collections,math
sc=collections.defaultdict(list)
for f in glob.glob(sys.argv[1]+'/*.txt'):
    for line in open(f):
        if not line.startswith('match'): continue
        for tok in line.split('|')[1].split():
            place,rest=tok.split(':',1); sc[rest.split('#')[0]].append(16-int(place))
for name,s in sorted(sc.items()):
    if not name.startswith('mine'): continue
    m=sum(s)/len(s); sd=(sum((v-m)**2 for v in s)/len(s))**.5
    print(f"  {sys.argv[2]} {name:10s} n={len(s)} mean={m:.2f} ±{sd/math.sqrt(len(s)):.2f} wins={sum(1 for v in s if v==15)/len(s):.2f} early(<=3)={sum(1 for v in s if v<=3)/len(s):.2f}")
PY
  rm -rf $OUT
done
git -C "$ROOT" worktree remove --force "$WT"
