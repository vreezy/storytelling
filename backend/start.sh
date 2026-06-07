#!/bin/sh
# Auto-detect Windows host IP from /proc/net/route (the default gateway).
# Falls back to OLLAMA_HOST env var if already set or detection fails.
if [ -z "$OLLAMA_HOST" ]; then
    GATEWAY=$(python3 -c "
import struct
try:
    with open('/proc/net/route') as f:
        for line in list(f)[1:]:
            p = line.split()
            if p[1] == '00000000' and p[2] != '00000000':
                print('.'.join(str(b) for b in struct.unpack('<4B', bytes.fromhex(p[2]))))
                break
except Exception as e:
    pass
" 2>/dev/null)
    if [ -n "$GATEWAY" ]; then
        export OLLAMA_HOST="http://${GATEWAY}:11434"
    fi
fi

echo "OLLAMA_HOST: ${OLLAMA_HOST:-not set -- Ollama may be unreachable}"
exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload
