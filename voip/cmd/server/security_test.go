package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestServiceAuthFailsClosed(t *testing.T) {
	for _, secret := range []string{"", "configured"} {
		t.Setenv("VOIP_SERVICE_SECRET", secret)
		s := &server{}
		called := false
		handler := s.withServiceAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/sessions", nil))
		if called || (response.Code != 401 && response.Code != 503) {
			t.Fatal("anonymous request reached handler")
		}
	}
}
func TestBrokerAccountScope(t *testing.T) {
	b := NewBroker()
	b.ScopeFn = func(account, sid string) bool { return account == "a" && sid == "a-session" }
	if b.scopedEvent([]byte(`{"type":"incoming","sessionId":"b-session"}`), "a", "agent") != nil {
		t.Fatal("foreign event leaked")
	}
	filtered := b.scopedEvent([]byte(`{"type":"session-list","sessions":[{"id":"a-session","qr":"secret"},{"id":"b-session"}]}`), "a", "agent")
	var payload struct {
		Sessions []map[string]any `json:"sessions"`
	}
	json.Unmarshal(filtered, &payload)
	if len(payload.Sessions) != 1 || payload.Sessions[0]["qr"] != nil {
		t.Fatal("foreign session or pairing code leaked")
	}
}
func TestAudioDestinations(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:192.168.1.1", "100.127.0.1", "64:ff9b::a00:1"} {
		if publicAudioIP(net.ParseIP(address)) {
			t.Fatalf("unsafe address allowed: %s", address)
		}
	}
	if !publicAudioIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("public address rejected")
	}
	t.Setenv("VOIP_AUDIO_ALLOWED_HOSTS", "")
	if _, err := downloadAudio(context.Background(), "https://example.com/audio"); err == nil {
		t.Fatal("unconfigured audio host allowed")
	}
}
