#!/bin/bash
# usage: tools/batch.sh <matches-per-proc> <roster> [procs] [seed0]
N=${1:-10}; R=${2:-mine:1,brawler:15}; P=${3:-4}; S0=${4:-100}
OUT=$(mktemp -d)
for p in $(seq 0 $((P-1))); do
  bun sim/run.ts --n $N --seed $((S0 + p*1000)) --roster "$R" > $OUT/$p.txt 2>&1 &
done
wait
cat $OUT/*.txt | grep "^match" > $OUT/all.txt
python3 - "$OUT" <<'PY'
import sys,re,collections,glob
out=sys.argv[1]
sc=collections.defaultdict(list); causes=collections.defaultdict(collections.Counter)
for f in glob.glob(out+'/[0-9]*.txt'):
    for line in open(f):
        if not line.startswith('match'): continue
        for tok in line.split('|')[1].split():
            place,rest=tok.split(':',1); name=rest.split('#')[0]
            sc[name].append(16-int(place))
for name,s in sorted(sc.items()):
    s.sort()
    print(f"{name:14s} n={len(s):3d} mean={sum(s)/len(s):5.2f} median={s[len(s)//2]} top3={sum(1 for v in s if v>=13)/len(s):.2f} bottom4={sum(1 for v in s if v<=3)/len(s):.2f}")
PY
grep -h "^mine\|^   modes" $OUT/[0-9]*.txt | head -8
rm -rf $OUT
