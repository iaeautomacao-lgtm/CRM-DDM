#!/usr/bin/env bash
# MODELO — não executado por ninguém ainda. Deploy ROLANTE do worker de envio (docs/disparador-worker.md).
#
#   scripts/deploy-worker.sh deploy   <usuario@host> [instâncias="a b"]   # build local + envia + reinicia uma instância por vez
#   scripts/deploy-worker.sh rollback <usuario@host> [instâncias="a b"]   # volta o symlink `current` para a release anterior
#
# Layout na máquina do worker: /opt/crm-worker/releases/<timestamp>/dispatch-worker.cjs  e  /opt/crm-worker/current -> release ativa.
# Rolling: reinicia UMA instância, espera ela estar ativa e só então a próxima (os leases migram; o resto do tempo o cron cobre).
set -euo pipefail

ACAO="${1:?uso: $0 deploy|rollback usuario@host [instâncias]}"
ALVO="${2:?informe usuario@host}"
INSTANCIAS="${3:-a}"
BASE=/opt/crm-worker

reiniciar_rolante() {
  for i in $INSTANCIAS; do
    echo "→ reiniciando dispatch-worker@$i"
    ssh "$ALVO" "sudo systemctl restart dispatch-worker@$i && sleep 5 && systemctl is-active --quiet dispatch-worker@$i"
  done
}

case "$ACAO" in
  deploy)
    npm run build:worker
    REL="$(date +%Y%m%d%H%M%S)"
    ssh "$ALVO" "mkdir -p $BASE/releases/$REL"
    scp dist/dispatch-worker.cjs dist/dispatch-worker.cjs.map "$ALVO:$BASE/releases/$REL/"
    # Teste de fumaça antes de trocar o symlink: o bundle carrega?
    ssh "$ALVO" "node $BASE/releases/$REL/dispatch-worker.cjs --check"
    ssh "$ALVO" "ln -sfn $BASE/releases/$REL $BASE/current.new && mv -T $BASE/current.new $BASE/current"
    reiniciar_rolante
    ;;
  rollback)
    ANTERIOR="$(ssh "$ALVO" "ls -1 $BASE/releases | sort | tail -2 | head -1")"
    echo "→ voltando para $ANTERIOR"
    ssh "$ALVO" "ln -sfn $BASE/releases/$ANTERIOR $BASE/current.new && mv -T $BASE/current.new $BASE/current"
    reiniciar_rolante
    ;;
  *) echo "ação desconhecida: $ACAO" >&2; exit 2 ;;
esac
