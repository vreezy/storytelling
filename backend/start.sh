#!/bin/sh
# Auto-detect the Windows host IP so the container can reach Ollama.
# Priority: OLLAMA_HOST env var → host.containers.internal (Podman 4.7+) → default gateway.
# Override any time by setting OLLAMA_HOST in a .env file next to compose.yml.
if [ -z "$OLLAMA_HOST" ]; then
    # Podman 4.7+ writes the Windows host IP under this hostname
    HOST_IP=$(awk '/host\.containers\.internal/{print $1; exit}' /etc/hosts 2>/dev/null)

    # Fall back: default gateway from the kernel routing table
    if [ -z "$HOST_IP" ]; then
        HOST_IP=$(python3 -c "
try:
    with open('/proc/net/route') as f:
        for line in list(f)[1:]:
            p = line.split()
            if p[1] == '00000000' and p[2] != '00000000':
                print('.'.join(str(x) for x in bytes.fromhex(p[2])[::-1]))
                break
except Exception:
    pass
" 2>/dev/null)
    fi

    if [ -n "$HOST_IP" ]; then
        export OLLAMA_HOST="http://${HOST_IP}:11434"
    fi
fi

echo "OLLAMA_HOST: ${OLLAMA_HOST:-not set -- Ollama may be unreachable}"

# Ensure frontend libs (Bootstrap, jQuery) are present before serving
LIBS_DIR=/app/libs python3 /app/download.py --libs-only

exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload
