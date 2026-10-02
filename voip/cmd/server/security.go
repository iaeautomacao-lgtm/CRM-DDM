package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Isolamento multi-conta do servidor VoIP.
//
// O navegador nunca fala direto com este serviço: todas as chamadas passam
// pelo proxy do CRM (src/app/api/calls/[...path]/route.ts), que valida a
// sessão do usuário e repassa conta/papel em headers internos assinados
// pelo segredo compartilhado VOIP_SERVICE_SECRET.

// accountFor retorna a conta dona da sessão VoIP, ou "" se a sessão não
// estiver mapeada. Sessões antigas sem mapeamento ficam bloqueadas até
// alguém preencher session_accounts manualmente após conferir o dono.
func (s *sessionStore) accountFor(ctx context.Context, id string) string {
	var account string
	if err := s.db.QueryRowContext(ctx, "SELECT account_id FROM session_accounts WHERE session_id = ?", id).Scan(&account); err != nil {
		return ""
	}
	return account
}

// bindAccount registra a conta dona de uma sessão recém-criada. INSERT
// simples (sem upsert): uma sessão nunca troca de dono.
func (s *sessionStore) bindAccount(ctx context.Context, id, account string) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO session_accounts(session_id,account_id) VALUES (?,?)", id, account)
	return err
}

// withServiceAuth é o middleware de autorização de toda a API HTTP:
//  1. exige Authorization: Bearer VOIP_SERVICE_SECRET (comparação em tempo
//     constante; sem a variável configurada responde 503 — fail-closed);
//  2. exige X-Voip-Account e um papel válido (owner/admin/agent);
//  3. em /api/sessions/{id}/..., a sessão precisa pertencer à conta, e uma
//     chamada {callId} precisa pertencer à sessão da URL — responde 404
//     para não revelar recursos de outras contas;
//  4. operações administrativas (criar/remover sessão, pair, logout) ficam
//     restritas a owner/admin.
func (s *server) withServiceAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secret := os.Getenv("VOIP_SERVICE_SECRET")
		if secret == "" {
			http.Error(w, "VoIP not configured", http.StatusServiceUnavailable)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		account, role := r.Header.Get("X-Voip-Account"), r.Header.Get("X-Voip-Role")
		if account == "" || (role != "owner" && role != "admin" && role != "agent") {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 2 || parts[0] != "api" {
			http.NotFound(w, r)
			return
		}
		if parts[1] == "sessions" && len(parts) >= 3 {
			if s.sessions.store.accountFor(r.Context(), parts[2]) != account {
				http.NotFound(w, r)
				return
			}
			if len(parts) >= 5 && parts[3] == "calls" {
				if record, ok := s.broker.getCall(parts[4]); ok && record.SessionID != parts[2] {
					http.NotFound(w, r)
					return
				}
			}
		}
		administrative := r.Method != "GET" && parts[1] == "sessions" && (len(parts) <= 3 || (len(parts) == 4 && (parts[3] == "pair" || parts[3] == "logout")))
		if administrative && role == "agent" {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// scopedEvent filtra um evento SSE para o assinante (conta + papel).
// Retorna nil quando o evento não deve ser entregue. Eventos de sessão de
// outra conta são descartados; listas "sessions"/"calls" são filtradas
// item a item; agentes nunca recebem o QR code (que daria controle do
// número). Payload que não é JSON válido é descartado (fail-closed).
func (b *Broker) scopedEvent(data []byte, account, role string) []byte {
	if account == "" {
		return data
	} // Internal subscribers/tests, never HTTP-authenticated.
	var event map[string]any
	if json.Unmarshal(data, &event) != nil || b.ScopeFn == nil {
		return nil
	}
	if sid, ok := event["sessionId"].(string); ok && !b.ScopeFn(account, sid) {
		return nil
	}
	if role == "agent" {
		delete(event, "qr")
	}
	for _, key := range []string{"sessions", "calls"} {
		if rows, ok := event[key].([]any); ok {
			filtered := []any{}
			for _, raw := range rows {
				row, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				sid, _ := row["sessionId"].(string)
				if key == "sessions" {
					sid, _ = row["id"].(string)
				}
				if b.ScopeFn(account, sid) {
					if role == "agent" {
						delete(row, "qr")
					}
					filtered = append(filtered, row)
				}
			}
			event[key] = filtered
		}
	}
	result, _ := json.Marshal(event)
	return result
}

// audioSlots limita a 4 downloads de áudio simultâneos (semáforo).
var audioSlots = make(chan struct{}, 4)

// publicAudioIP diz se o IP é público e roteável. Bloqueia redes privadas,
// loopback, link-local e faixas reservadas/de documentação (CGNAT, TEST-NET,
// benchmark, NAT64) — proteção contra SSRF para a rede interna.
func publicAudioIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "64:ff9b::/96", "64:ff9b:1::/48"} {
		_, network, _ := net.ParseCIDR(cidr)
		if network.Contains(ip) {
			return false
		}
	}
	return true
}
// downloadAudio baixa o áudio a ser tocado numa ligação, com defesas
// contra SSRF e abuso:
//   - só HTTPS na porta 443, sem credenciais na URL;
//   - host precisa estar na allowlist VOIP_AUDIO_ALLOWED_HOSTS (exato);
//   - o IP é validado no momento da conexão (DialContext), não só na URL,
//     o que bloqueia DNS rebinding; todos os IPs resolvidos devem ser públicos;
//   - redirects proibidos, timeout de 15s e limite de 16 MiB.
func downloadAudio(ctx context.Context, raw string) ([]byte, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || (parsed.Port() != "" && parsed.Port() != "443") {
		return nil, errors.New("invalid audio URL")
	}
	approved := false
	for _, host := range strings.Split(os.Getenv("VOIP_AUDIO_ALLOWED_HOSTS"), ",") {
		if strings.EqualFold(strings.TrimSpace(host), parsed.Hostname()) && host != "" {
			approved = true
		}
	}
	if !approved {
		return nil, errors.New("audio host not allowed")
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, errors.New("no audio address")
		}
		for _, ip := range ips {
			if !publicAudioIP(ip.IP) {
				return nil, errors.New("private audio address")
			}
		}
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("audio redirects denied") }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("audio download rejected")
	}
	const limit = 16 * 1024 * 1024
	if response.ContentLength > limit {
		return nil, errors.New("audio too large")
	}
	// Content-Length pode estar ausente ou mentir: lê no máximo limit+1
	// bytes e rejeita se passar do limite.
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, errors.New("audio too large")
	}
	return data, nil
}
