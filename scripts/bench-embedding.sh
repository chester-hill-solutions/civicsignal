#!/usr/bin/env bash
# Measure EmbeddingGemma 2 embedding throughput on CPU.
#
# The container case for self-hosting rests on one number that had only been
# estimated: how fast a 270M-parameter text encoder runs on a few vCPUs, with no
# GPU. Workers cannot thread, so the CPU figure is the conservative one.
#
# The GGUF is the text backbone only; the vision projector (mmproj) is not needed.
set -uo pipefail
cd "$(dirname "$0")/.."
TOOLS=tools/llama
mkdir -p "$TOOLS"

if [ ! -x "$TOOLS/llama-embedding" ]; then
  echo "fetching a prebuilt llama.cpp…"
  asset=$(curl -s --max-time 60 https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
    | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('assets',[]):
    n=a['name']
    if 'macos' in n and 'arm64' in n and n.endswith('.zip'):
        print(a['browser_download_url']); break
")
  [ -z "$asset" ] && { echo "no macOS arm64 asset found"; exit 1; }
  echo "  $asset"
  curl -sL --max-time 300 -o "$TOOLS/llama.zip" "$asset"
  unzip -o -q "$TOOLS/llama.zip" -d "$TOOLS"
  rm -f "$TOOLS/llama.zip"
  chmod +x "$TOOLS"/llama-* 2>/dev/null
  ls -1 "$TOOLS" | head -20
fi

GGUF="$TOOLS/embeddinggemma-2-Q8_0.gguf"
if [ ! -f "$GGUF" ]; then
  echo "downloading the text backbone (295 MB)…"
  curl -sL --max-time 900 -o "$GGUF" \
    "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf"
  ls -la "$GGUF" | awk '{print "  "$5" bytes"}'
fi

EMB=$(ls "$TOOLS"/llama-embedding 2>/dev/null | head -1)
[ -z "$EMB" ] && { echo "no llama-embedding binary"; exit 1; }

echo
echo "=== EmbeddingGemma 2, CPU only (-ngl 0) ==="
python3 - <<'PY' > /tmp/emb-bench.txt
lines = [
 "The Residential Tenancies Act sets out the rules a landlord must follow when increasing rent.",
 "Under the Canada Labour Code, an employer must give an employee written notice of termination.",
 "A person commits an offence who operates a conveyance while their ability to do so is impaired by alcohol.",
 "The Privacy Act prohibits a government institution from disclosing personal information without consent.",
 "Every person who commits theft fraudulently takes the property of another with intent to deprive.",
 "The Competition Act makes it an offence for competitors to conspire to fix prices.",
] * 20
print("\n".join(lines))
PY
wc -l /tmp/emb-bench.txt | awk '{print "  "$1" documents"}'

/usr/bin/time -l "$TOOLS/$EMB" \
  --model "$GGUF" --file /tmp/emb-bench.txt --pooling mean --embedding --normalize \
  --n-prompt 512 2>&1 | tail -25
