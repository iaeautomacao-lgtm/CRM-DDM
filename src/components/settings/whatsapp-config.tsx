'use client';

import { apiFetch } from "@/lib/api-fetch";

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  QrCode,
  RefreshCw,
  Server,
  Settings,
  Key,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

function normalizeSessionName(input: string): string {
  return input
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/\s+/g, '_')                              // espacos -> underscore
    .replace(/[^a-z0-9_-]/g, '');                       // remove qualquer coisa que nao seja permitido
}
export function WhatsAppConfig() {
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  
  const [configs, setConfigs] = useState<any[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Provider selection: 'meta' | 'waha'
  const [provider, setProvider] = useState<'meta' | 'waha'>('meta');

  // Meta States
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // WAHA States
  const [wahaUrl, setWahaUrl] = useState('');
  const [wahaSession, setWahaSession] = useState('');
  const [wahaApiKey, setWahaApiKey] = useState('');
  const [wahaApiKeyEdited, setWahaApiKeyEdited] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string>('STOPPED');
  const [qrTrigger, setQrTrigger] = useState(0);
  const [wahaConnecting, setWahaConnecting] = useState(false);

  // VoIP States
  const [voipBaseUrl, setVoipBaseUrl] = useState<string>('');
  const [voipStatus, setVoipStatus] = useState<string>('NOT_CREATED');
  const [voipQr, setVoipQr] = useState<string>('');
  const [voipLoading, setVoipLoading] = useState(false);

  // Pairing Code States
  const [pairingPhone, setPairingPhone] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // Meta specific checks
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;
  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const metaWebhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const wahaWebhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook/waha`
      : '';

  const handleRequestPairingCode = async (e: React.FormEvent) => {
    e.preventDefault();
    let phoneCleaned = pairingPhone.replace(/\D/g, '');
    if ((phoneCleaned.length === 10 || phoneCleaned.length === 11) && !phoneCleaned.startsWith('55')) {
      phoneCleaned = '55' + phoneCleaned;
      setPairingPhone(phoneCleaned);
    }

    setPairingLoading(true);
    setPairingError(null);
    setPairingCode('');

    try {
      const res = await apiFetch('/api/whatsapp/waha/pairing-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phoneNumber: phoneCleaned,
          session: wahaSession,
          configId: activeConfigId
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao solicitar o código de pareamento');
      }

      setPairingCode(data.code);
      toast.success('Código de pareamento gerado!');
    } catch (err: any) {
      setPairingError(err.message || 'Falha ao gerar o código');
      toast.error(err.message || 'Erro ao gerar código');
    } finally {
      setPairingLoading(false);
    }
  };

  const selectConfig = useCallback((c: any) => {
    if (c) {
      setActiveConfigId(c.id);
      setConfig(c);
      setProvider(c.provider || 'meta');

      if (c.provider === 'meta') {
        setPhoneNumberId(c.phone_number_id || '');
        setWabaId(c.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
      } else {
        setWahaUrl(c.waha_url || '');
        setWahaSession(c.waha_session || '');
        setWahaApiKey(c.waha_api_key ? MASKED_TOKEN : '');
        setWahaApiKeyEdited(false);
        setSessionStatus(c.session_status || 'STOPPED');
      }
      setConnectionStatus(c.connected ? 'connected' : 'disconnected');
    } else {
      setActiveConfigId(null);
      setConfig(null);
      setProvider('meta');
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setPin('');
      setTokenEdited(false);

      setWahaUrl('');
      setWahaSession('');
      setWahaApiKey('');
      setWahaApiKeyEdited(false);
      setSessionStatus('STOPPED');
      setConnectionStatus('disconnected');
    }
  }, []);

  const checkWahaStatus = useCallback(async () => {
    if (!accountId || !wahaSession) return;
    try {
      const res = await apiFetch('/api/whatsapp/config');
      const data = await res.json();
      const list = data.configs || [];
      const current = list.find((c: any) => c.waha_session === wahaSession);
      if (current) {
        setSessionStatus(current.session_status || 'STOPPED');
        if (current.connected) {
          setConnectionStatus('connected');
        } else {
          setConnectionStatus('disconnected');
        }
      }
    } catch (err) {
      console.error('Failed to query WAHA status:', err);
    }
  }, [accountId, wahaSession]);

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();
      
      const list = payload.configs || [];
      setConfigs(list);

      // Keep active configuration selected, or select the first one, or leave empty/new if none exist
      let selected = null;
      if (list.length > 0) {
        selected = list.find((c: any) => c.id === activeConfigId) || list[0];
      }
      
      selectConfig(selected);
      setRegistrationProbe(null);
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Falha ao carregar configurações do WhatsApp');
    } finally {
      setLoading(false);
    }
  }, [activeConfigId, selectConfig]);

  // Hook for polling WAHA session status when needed
  useEffect(() => {
    if (provider !== 'waha' || !accountId) return;

    checkWahaStatus();

    const interval = setInterval(() => {
      checkWahaStatus();
      if (sessionStatus === 'SCAN_QR' || sessionStatus === 'SCAN_QR_CODE' || sessionStatus === 'STARTING') {
        setQrTrigger((prev) => prev + 1);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [provider, accountId, sessionStatus, checkWahaStatus]);

  const hasFetchedConfigRef = useRef(false);
  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoading(false);
      return;
    }
    if (!hasFetchedConfigRef.current) {
      hasFetchedConfigRef.current = true;
      fetchConfig(accountId);
    }
  }, [authLoading, profileLoading, user, accountId, fetchConfig]);

  // Fetch VoIP Base URL Config
  useEffect(() => {
    apiFetch('/api/whatsapp/voip-url')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.url) {
          setVoipBaseUrl(data.url);
        }
      })
      .catch((err) => console.warn("Failed to fetch VoIP URL:", err));
  }, []);

  // VoIP Live Status and Pairing Event Listener (Direct CORS Call)
  useEffect(() => {
    if (provider !== 'waha' || !wahaSession || !voipBaseUrl) return;

    let active = true;
    let es: EventSource | null = null;

    const checkVoipSession = async () => {
      try {
        const res = await fetch(`${voipBaseUrl}/api/sessions`);
        if (!res.ok) return;
        const data = await res.json();
        const existing = data.sessions?.find((s: any) => s.id === wahaSession);
        if (existing) {
          if (active) {
            setVoipStatus(existing.state);
            if (existing.qr) setVoipQr(existing.qr);
          }
        } else {
          if (active) setVoipStatus('NOT_CREATED');
        }
      } catch (err) {
        console.warn("Failed to fetch VoIP sessions:", err);
      }
    };

    checkVoipSession();

    // Check status every 5000 milliseconds
    const interval = setInterval(checkVoipSession, 5000);

    // Live Event Stream for QR and Auth status (Direct CORS SSE)
    try {
      const clientId = 'config-' + Math.random().toString(36).substring(2);
      es = new EventSource(`${voipBaseUrl}/api/events?clientId=${encodeURIComponent(clientId)}`);
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data);
          if (event.sessionId !== wahaSession) return;

          if (event.type === 'auth-state') {
            if (active) {
              setVoipStatus(event.state);
              if (event.qr) setVoipQr(event.qr);
            }
          } else if (event.type === 'session-qr') {
            if (active) {
              setVoipStatus('SCAN_QR');
              setVoipQr(event.qr);
            }
          }
        } catch {}
      };
    } catch {}

    return () => {
      active = false;
      clearInterval(interval);
      es?.close();
    };
  }, [provider, wahaSession, voipBaseUrl]);

  const handleCreateVoipSession = async () => {
    if (!wahaSession || !voipBaseUrl) return;
    setVoipLoading(true);
    try {
      // 1. Create session
      await fetch(`${voipBaseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: wahaSession }),
      });

      // 2. Trigger pair to output QR
      const pairRes = await fetch(`${voipBaseUrl}/api/sessions/${wahaSession}/pair`, {
        method: 'POST',
      });

      if (!pairRes.ok) throw new Error('Falha ao acionar pareamento');

      setVoipStatus('SCAN_QR');
      toast.success('Sessão de VoIP criada. Aguardando pareamento...');
    } catch (err: any) {
      toast.error(err.message || 'Erro ao inicializar ligações');
    } finally {
      setVoipLoading(false);
    }
  };

  // WAHA session actions
  async function handleWahaStart() {
    if (!wahaSession) return;
    setWahaConnecting(true);
    try {
      const res = await apiFetch('/api/whatsapp/waha/start', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: wahaSession, id: activeConfigId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao iniciar sessão');
      toast.success('Inicialização da sessão WAHA solicitada.');
      await checkWahaStatus();
    } catch (err: any) {
      toast.error(err.message || 'Falha ao iniciar sessão');
    } finally {
      setWahaConnecting(false);
    }
  }

  async function handleWahaStop() {
    if (!wahaSession) return;
    setWahaConnecting(true);
    try {
      const res = await apiFetch('/api/whatsapp/waha/stop', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: wahaSession, id: activeConfigId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao parar sessão');
      toast.success('Parada da sessão WAHA solicitada.');
      await checkWahaStatus();
    } catch (err: any) {
      toast.error(err.message || 'Falha ao parar sessão');
    } finally {
      setWahaConnecting(false);
    }
  }

  async function handleSave() {
    if (provider === 'waha') {
      if (!wahaUrl.trim()) {
        toast.error('URL do servidor WAHA é obrigatória');
        return;
      }
      if (!wahaSession.trim()) {
        toast.error('Nome da sessão WAHA é obrigatório');
        return;
      }

      setSaving(true);
      try {
        const payload: Record<string, any> = {
          provider: 'waha',
          waha_url: wahaUrl.trim(),
          waha_session: wahaSession.trim(),
          waha_api_key: wahaApiKeyEdited ? wahaApiKey.trim() : MASKED_TOKEN,
        };
        if (activeConfigId) {
          payload.id = activeConfigId;
        }

        const res = await apiFetch('/api/whatsapp/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Falha ao salvar configuração');
        }

        toast.success(data.message || 'Configuração do WAHA salva com sucesso.');
        if (accountId) fetchConfig(accountId);
      } catch (err: any) {
        console.error('Save WAHA config error:', err);
        toast.error(err.message || 'Falha ao salvar configuração do WAHA');
      } finally {
        setSaving(false);
      }
      return;
    }

    // Original Meta save path
    if (!phoneNumberId.trim()) {
      toast.error('ID do número de telefone é obrigatório');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Token de acesso é obrigatório para configuração inicial');
      return;
    }

    try {
      setSaving(true);
      const payload: Record<string, unknown> = {
        provider: 'meta',
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        pin: pin.trim() || null,
      };
      if (activeConfigId) {
        payload.id = activeConfigId;
      }

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        toast.error('Por favor, insira novamente o Token de Acesso para salvar as alterações');
        setSaving(false);
        return;
      }

      const res = await apiFetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Falha ao salvar configuração');
      }

      toast.success('Configuração da API do WhatsApp salva com sucesso!');
      if (accountId) fetchConfig(accountId);
    } catch (err: any) {
      console.error('Save config error:', err);
      toast.error(err.message || 'Falha ao salvar configuração');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    try {
      const res = await apiFetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        toast.success(
          provider === 'waha'
            ? 'Conectado com sucesso ao WhatsApp (WAHA)!'
            : 'Conectado com sucesso à Meta Cloud API!'
        );
      } else {
        setConnectionStatus('disconnected');
        toast.error(payload.message || 'Falha ao conectar. Verifique as credenciais.');
      }
    } catch (err: any) {
      console.error('Test connection failed:', err);
      toast.error(err.message || 'Falha ao testar conexão');
    } finally {
      setTesting(false);
    }
  }

  async function handleReset() {
    if (!confirm('Tem certeza de que deseja limpar esta configuração do WhatsApp?')) {
      return;
    }

    try {
      setResetting(true);
      const url = activeConfigId 
        ? `/api/whatsapp/config?id=${activeConfigId}`
        : '/api/whatsapp/config';
      
      const res = await apiFetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json();
        throw new Error(payload.error || 'Falha ao excluir configuração');
      }

      toast.success('Configuração removida com sucesso');
      setActiveConfigId(null);
      if (accountId) fetchConfig(accountId);
    } catch (err: any) {
      console.error('Reset config error:', err);
      toast.error(err.message || 'Falha ao limpar configuração');
    } finally {
      setResetting(false);
    }
  }

  // Meta specific function
  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    try {
      const res = await apiFetch('/api/whatsapp/config/register', { method: 'GET' });
      const payload = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(payload);

      if (payload.live) {
        toast.success('O registro está ativo e recebendo webhooks.');
      } else {
        toast.error('Falha nas verificações de registro. Veja os detalhes no bloco de status.');
      }
    } catch (err) {
      console.error('Failed to probe registration status:', err);
      toast.error('Falha ao consultar status do registro');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  function handleCopyWebhookUrl() {
    const url = provider === 'waha' ? wahaWebhookUrl : metaWebhookUrl;
    navigator.clipboard.writeText(url);
    toast.success('URL do webhook copiada para a área de transferência');
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="Conexão do WhatsApp"
          description="Conecte sua conta do WhatsApp ao CRM via Meta Cloud API oficial ou WAHA próprio (WhatsApp HTTP API)."
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Conexão do WhatsApp"
        description="Conecte sua conta do WhatsApp ao CRM via Meta Cloud API oficial ou WAHA próprio (WhatsApp HTTP API)."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Main config form */}
        <div className="space-y-6">
          {/* Configured Lines List */}
          <Card className="border-border bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 flex-wrap gap-2">
              <div>
                <CardTitle className="text-foreground">Canais de Atendimento (Linhas)</CardTitle>
                <CardDescription className="text-muted-foreground font-light">
                  Lista de números do WhatsApp conectados a esta conta do CRM.
                </CardDescription>
              </div>
              <Button
                size="sm"
                onClick={() => selectConfig(null)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold h-8"
              >
                + Conectar Nova Linha
              </Button>
            </CardHeader>
            <CardContent>
              {configs.length === 0 ? (
                <div className="text-center py-6 border border-dashed border-border rounded-lg bg-muted/10">
                  <p className="text-sm text-muted-foreground">Nenhuma linha conectada ainda.</p>
                </div>
              ) : (
                <div className="divide-y divide-border border border-border rounded-lg overflow-hidden bg-muted/10">
                  {configs.map((c) => {
                    const isActive = c.id === activeConfigId;
                    return (
                      <div
                        key={c.id}
                        className={`flex items-center justify-between p-3.5 transition-colors hover:bg-muted/40 ${
                          isActive ? 'bg-muted/50 border-l-2 border-primary' : ''
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {/* Status Dot */}
                          <span className="relative flex h-2.5 w-2.5">
                            {c.connected && (
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            )}
                            <span
                              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                                c.connected ? 'bg-emerald-500' : 'bg-red-500'
                              }`}
                            ></span>
                          </span>

                          <div className="flex flex-col">
                            <span className="text-sm font-semibold text-foreground">
                              {c.phone_info?.display_phone_number || c.waha_session || c.phone_number_id}
                            </span>
                            <span className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                              <span className="font-medium capitalize text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded text-[10px]">
                                {c.provider === 'waha' ? 'WAHA' : 'Meta API'}
                              </span>
                              {c.phone_info?.verified_name && (
                                <span className="truncate max-w-[220px]">{c.phone_info.verified_name}</span>
                              )}
                            </span>
                          </div>
                        </div>

                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant={isActive ? 'default' : 'outline'}
                            onClick={() => selectConfig(c)}
                            className="text-xs h-7 font-medium"
                          >
                            Gerenciar
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              if (confirm('Tem certeza que deseja remover esta linha do WhatsApp?')) {
                                try {
                                    const res = await apiFetch(`/api/whatsapp/config?id=${c.id}`, { method: 'DELETE' });
                                  if (!res.ok) throw new Error('Erro ao deletar linha');
                                  toast.success('Linha removida com sucesso!');
                                  if (isActive) setActiveConfigId(null);
                                  if (accountId) fetchConfig(accountId);
                                } catch (err: any) {
                                  toast.error(err.message || 'Erro ao deletar linha');
                                }
                              }
                            }}
                            className="text-xs h-7 font-medium border-red-900/50 text-red-400 hover:bg-red-950/20 hover:text-red-300"
                          >
                            Remover
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Corrupted-token reset banner (Meta only) */}
          {provider === 'meta' && showResetBanner && (
            <Alert className="bg-amber-950/40 border-amber-600/40">
              <div className="flex items-start gap-3">
                <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <AlertTitle className="text-amber-200 mb-1">
                    O token armazenado não pode ser descriptografado
                  </AlertTitle>
                  <AlertDescription className="text-amber-100/80 text-sm">
                    {statusMessage}
                  </AlertDescription>
                  <Button
                    onClick={handleReset}
                    disabled={resetting}
                    size="sm"
                    className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    {resetting ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Redefinindo...
                      </>
                    ) : (
                      <>
                        <RotateCcw className="size-4" />
                        Redefinir Configuração
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </Alert>
          )}

          {/* Provider Selection Card */}
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-foreground">Provedor de Conexão</CardTitle>
              <CardDescription className="text-muted-foreground font-light">
                Escolha se deseja conectar via Meta Cloud API oficial ou WAHA próprio.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-4">
                <Button
                  type="button"
                  variant={provider === 'meta' ? 'default' : 'outline'}
                  onClick={() => setProvider('meta')}
                  className="flex-1 flex gap-2 items-center"
                >
                  <Settings className="size-4" />
                  Meta Cloud API
                </Button>
                <Button
                  type="button"
                  variant={provider === 'waha' ? 'default' : 'outline'}
                  onClick={() => setProvider('waha')}
                  className="flex-1 flex gap-2 items-center"
                >
                  <Server className="size-4" />
                  WAHA (WhatsApp Web)
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Connection Status & QR Code (WAHA Specific) */}
          {provider === 'waha' && config && (
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-foreground flex items-center gap-2">
                  Controle da Sessão
                </CardTitle>
                <CardDescription className="text-muted-foreground font-light">
                  Gerencie sua conexão WAHA e leitura de QR Code.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between border border-border rounded-lg p-3 bg-muted/40">
                  <div className="flex items-center gap-3">
                    <span className="relative flex h-3 w-3">
                      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                        sessionStatus === 'WORKING' ? 'bg-emerald-400' :
                        (sessionStatus === 'SCAN_QR' || sessionStatus === 'SCAN_QR_CODE') ? 'bg-amber-400' :
                        sessionStatus === 'STARTING' ? 'bg-blue-400' : 'bg-red-400'
                      }`}></span>
                      <span className={`relative inline-flex rounded-full h-3 w-3 ${
                        sessionStatus === 'WORKING' ? 'bg-emerald-500' :
                        (sessionStatus === 'SCAN_QR' || sessionStatus === 'SCAN_QR_CODE') ? 'bg-amber-500' :
                        sessionStatus === 'STARTING' ? 'bg-blue-500' : 'bg-red-500'
                      }`}></span>
                    </span>
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">Status do WAHA</h4>
                      <p className="text-xs text-muted-foreground">{sessionStatus}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={checkWahaStatus}
                      className="border-border hover:bg-muted text-muted-foreground"
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                    {sessionStatus === 'STOPPED' || sessionStatus === 'FAILED' ? (
                      <Button
                        size="sm"
                        onClick={handleWahaStart}
                        disabled={wahaConnecting}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        {wahaConnecting ? 'Iniciando...' : 'Conectar'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={handleWahaStop}
                        disabled={wahaConnecting}
                        className="bg-red-600 hover:bg-red-700 text-white"
                      >
                        {wahaConnecting ? 'Parando...' : 'Desconectar'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* QR Code Container */}
                {(sessionStatus === 'SCAN_QR' || sessionStatus === 'SCAN_QR_CODE') && (
                  <div className="grid gap-6 md:grid-cols-2 items-start mt-4">
                    <div className="flex flex-col items-center justify-center p-6 border border-amber-600/30 bg-amber-950/10 rounded-lg space-y-3">
                      <div className="bg-white p-3 rounded-md">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/whatsapp/waha/qr?session=${encodeURIComponent(wahaSession)}&id=${encodeURIComponent(activeConfigId || '')}&t=${qrTrigger}`}
                          alt="WhatsApp WAHA QR Code"
                          className="w-48 h-48"
                        />
                      </div>
                      <div className="text-center">
                        <h5 className="text-sm font-semibold text-amber-200">Escanear QR Code</h5>
                        <p className="text-xs text-muted-foreground mt-1 max-w-[280px]">
                          Escaneie este QR code usando o WhatsApp no seu celular (Aparelhos conectados &gt; Conectar um aparelho) para autorizar a sessão.
                        </p>
                      </div>
                    </div>

                    {/* Pairing Code Section */}
                    <div className="border border-border rounded-lg p-5 bg-muted/20 space-y-4">
                      <div className="flex flex-col space-y-1">
                        <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                          <Key className="size-4 text-primary" />
                          Conectar por Código (Sem QR Code)
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          Digite o número do celular abaixo para gerar o código de conexão.
                        </p>
                      </div>

                      <form onSubmit={handleRequestPairingCode} className="flex gap-2 items-end">
                        <div className="flex-1 space-y-1.5">
                          <Label htmlFor="pairing-phone" className="text-xs text-muted-foreground">
                            Número do Celular (com DDD)
                          </Label>
                          <Input
                            id="pairing-phone"
                            placeholder="Ex: 21984354821"
                            value={pairingPhone}
                            onChange={(e) => setPairingPhone(e.target.value)}
                            disabled={pairingLoading}
                            className="bg-background border-border text-sm h-9"
                          />
                          <p className="text-[10px] text-amber-400 font-medium">
                            💡 Dica: Digite apenas o DDD + Número. O sistema adiciona o 55 automático se você esquecer!
                          </p>
                        </div>
                        <Button 
                          type="submit" 
                          disabled={pairingLoading || !pairingPhone}
                          className="bg-primary hover:bg-primary/90 text-primary-foreground h-9 font-medium text-xs px-3"
                        >
                          {pairingLoading ? 'Gerando...' : 'Gerar Código'}
                        </Button>
                      </form>

                      {pairingError && (
                        <p className="text-xs text-red-400">{pairingError}</p>
                      )}

                      {pairingCode && (
                        <div className="flex flex-col items-center justify-center p-4 bg-primary/10 border border-primary/20 rounded-lg text-center space-y-2">
                          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                            Código de Pareamento
                          </p>
                          <p className="text-3xl font-mono font-bold text-primary tracking-widest select-all">
                            {pairingCode}
                          </p>
                          <p className="text-[11px] text-muted-foreground max-w-[240px] mt-1">
                            No seu celular, vá em <strong>Aparelhos Conectados &gt; Conectar com número de telefone</strong> e digite o código acima.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Connection Status & QR Code (VoIP calling) */}
          {provider === 'waha' && config && (
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-foreground flex items-center gap-2">
                  Ligações de Voz (WhatsApp VoIP)
                </CardTitle>
                <CardDescription className="text-muted-foreground font-light">
                  Gerencie as ligações de voz integradas por WebRTC.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between border border-border rounded-lg p-3 bg-muted/40">
                  <div className="flex items-center gap-3">
                    <span className="relative flex h-3 w-3">
                      <span className={`relative inline-flex rounded-full h-3 w-3 ${
                        voipStatus === 'open' ? 'bg-emerald-500 animate-pulse' :
                        (voipStatus === 'qr' || voipStatus === 'SCAN_QR') ? 'bg-amber-500 animate-pulse' : 'bg-red-500'
                      }`}></span>
                    </span>
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">Status do VoIP</h4>
                      <p className="text-xs text-muted-foreground capitalize">
                        {voipStatus === 'open' ? 'Ativo e Conectado' : 
                         (voipStatus === 'qr' || voipStatus === 'SCAN_QR') ? 'Aguardando QR Code' : 
                         voipStatus === 'connecting' ? 'Conectando...' :
                         voipStatus === 'NOT_CREATED' ? 'Desativado' : voipStatus}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {(voipStatus === 'NOT_CREATED' || voipStatus === 'logged_out') && (
                      <Button
                        size="sm"
                        disabled={voipLoading || !wahaSession}
                        onClick={handleCreateVoipSession}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        {voipLoading ? 'Ativando...' : 'Ativar Ligações'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* VoIP QR Code Container */}
                {(voipStatus === 'qr' || voipStatus === 'SCAN_QR') && voipQr && (
                  <div className="flex flex-col items-center justify-center p-6 border border-amber-600/30 bg-amber-950/10 rounded-lg space-y-3">
                    <div className="bg-white p-3 rounded-md">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(voipQr)}`}
                        alt="WhatsApp VoIP QR Code"
                        className="w-48 h-48"
                      />
                    </div>
                    <div className="text-center">
                      <h5 className="text-sm font-semibold text-amber-200">Escanear QR Code de Ligações</h5>
                      <p className="text-xs text-muted-foreground mt-1 max-w-[280px]">
                        Escaneie este QR code usando seu celular no WhatsApp (Aparelhos Conectados) para permitir ligações no CRM.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Connection Status (Meta Specific) */}
          {provider === 'meta' && (
            <Alert className="bg-card border-border">
              <div className="flex items-center gap-2">
                {connectionStatus === 'connected' ? (
                  <CheckCircle2 className="size-4 text-primary" />
                ) : (
                  <XCircle className="size-4 text-red-500" />
                )}
                <AlertTitle className="text-foreground mb-0">
                  {connectionStatus === 'connected' ? 'Credenciais válidas' : 'Não conectado'}
                </AlertTitle>
              </div>
              <AlertDescription className="text-muted-foreground mt-1.5">
                {connectionStatus === 'connected'
                  ? 'Seu token de acesso autentica com a Meta. Veja o status do Registro abaixo para verificar se os webhooks estão conectados.'
                  : statusMessage ||
                    'Configure suas credenciais da Meta API abaixo para conectar sua conta do WhatsApp Business.'}
              </AlertDescription>
            </Alert>
          )}

          {/* Registration Status (Meta Specific) */}
          {provider === 'meta' && config && (
            <Alert
              className={
                isRegistered
                  ? 'bg-emerald-950/30 border-emerald-700/50'
                  : 'bg-amber-950/30 border-amber-700/50'
              }
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  {isRegistered ? (
                    <CheckCircle2 className="size-4 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-4 text-amber-400" />
                  )}
                  <AlertTitle
                    className={
                      'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                    }
                  >
                    {isRegistered
                      ? 'Registrado — A Meta enviará eventos para o wacrm'
                      : 'Não registrado — A Meta não enviará eventos'}
                  </AlertTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleVerifyRegistration}
                  disabled={verifyingRegistration}
                  className="border-border bg-transparent text-foreground hover:bg-muted h-7"
                >
                  {verifyingRegistration ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  Verificar com a Meta
                </Button>
              </div>
              <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {isRegistered ? (
                  <>
                    Inscrito desde{' '}
                    {config.registered_at
                      ? new Date(config.registered_at).toLocaleString()
                      : 'desconhecido'}
                    . Clique em <strong>Verificar com a Meta</strong> se os eventos
                    pararem de chegar.
                  </>
                ) : lastRegistrationError ? (
                  <>
                    Última tentativa falhou com:{' '}
                    <span className="text-red-300">
                      {lastRegistrationError}
                    </span>
                    .
                  </>
                ) : (
                  'Verificação pendente.'
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Credentials Card (Based on Provider) */}
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-foreground">
                {activeConfigId 
                  ? (provider === 'waha' ? 'Editar Servidor WAHA' : 'Editar Credenciais Meta') 
                  : (provider === 'waha' ? 'Configurar Nova Linha WAHA' : 'Configurar Nova Linha Meta')}
              </CardTitle>
              <CardDescription className="text-muted-foreground font-light">
                {provider === 'waha'
                  ? 'Forneça os detalhes do seu servidor WAHA auto-hospedado.'
                  : 'Insira as credenciais do seu aplicativo Meta Cloud API.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {provider === 'waha' ? (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">URL do Servidor WAHA</Label>
                    <Input
                      placeholder="ex.: http://localhost:3000 ou https://waha.minhaempresa.com"
                      value={wahaUrl}
                      onChange={(e) => setWahaUrl(e.target.value)}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">
                      A URL HTTP pública/local onde o container do WAHA está hospedado.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Nome da Sessão</Label>
                    <Input
                      placeholder="ex.: default"
                      value={wahaSession}
                      onChange={(e) => setWahaSession(normalizeSessionName(e.target.value))}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">
                      Um identificador único para sua sessão de conexão do WhatsApp.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Chave de API do WAHA (Secret Key)</Label>
                    <div className="relative">
                      <Input
                        type={showToken ? 'text' : 'password'}
                        placeholder="Insira o Token Secreto da API (opcional)"
                        value={wahaApiKey}
                        onChange={(e) => {
                          setWahaApiKey(e.target.value);
                          setWahaApiKeyEdited(true);
                        }}
                        onFocus={() => {
                          if (wahaApiKey === MASKED_TOKEN) {
                            setWahaApiKey('');
                            setWahaApiKeyEdited(true);
                          }
                        }}
                        className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    {config && !wahaApiKeyEdited && config.waha_api_key && (
                      <p className="text-xs text-muted-foreground">
                        A chave de API está oculta por segurança. Digite novamente para atualizar.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">ID do Número de Telefone</Label>
                    <Input
                      placeholder="ex.: 100234567890123"
                      value={phoneNumberId}
                      onChange={(e) => setPhoneNumberId(e.target.value)}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">ID da Conta WhatsApp Business (WABA)</Label>
                    <Input
                      placeholder="ex.: 100234567890456"
                      value={wabaId}
                      onChange={(e) => setWabaId(e.target.value)}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Token de Acesso Permanente</Label>
                    <div className="relative">
                      <Input
                        type={showToken ? 'text' : 'password'}
                        placeholder="Insira seu token de acesso"
                        value={accessToken}
                        onChange={(e) => {
                          setAccessToken(e.target.value);
                          setTokenEdited(true);
                        }}
                        onFocus={() => {
                          if (accessToken === MASKED_TOKEN) {
                            setAccessToken('');
                            setTokenEdited(true);
                          }
                        }}
                        className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    {config && !tokenEdited && (
                      <p className="text-xs text-muted-foreground">
                        O token está oculto por segurança. Digite novamente para atualizar a configuração.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Token de Verificação do Webhook</Label>
                    <Input
                      placeholder="Crie um token de verificação personalizado"
                      value={verifyToken}
                      onChange={(e) => setVerifyToken(e.target.value)}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">
                      Uma chave personalizada criada por você. Deve coincidir com o token definido nas configurações de webhook da Meta.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">
                      PIN de confirmação em duas etapas
                      <span className="ml-1 text-muted-foreground">(opcional)</span>
                    </Label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="PIN de 6 dígitos do Gerenciador do WhatsApp"
                      value={pin}
                      onChange={(e) =>
                        setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
                    />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Necessário apenas para receber mensagens <strong className="text-muted-foreground">de entrada</strong>
                      em um número de <strong className="text-muted-foreground">produção</strong>.
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Webhook Configuration Card */}
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-foreground">Configuração de Webhook</CardTitle>
              <CardDescription className="text-muted-foreground font-light">
                {provider === 'waha'
                  ? 'Configure esta URL nas configurações do seu WAHA para receber as conversas.'
                  : 'Use esta URL como callback de webhook no painel do app da Meta (Meta App Dashboard).'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label className="text-muted-foreground">URL de Callback do Webhook</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={provider === 'waha' ? wahaWebhookUrl : metaWebhookUrl}
                    className="bg-muted border-border text-muted-foreground font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleCopyWebhookUrl}
                    className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                'Salvar Configuração'
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !config}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {testing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Testando...
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  Testar Conexão da API
                </>
              )}
            </Button>
            {config && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={resetting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {resetting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Redefinindo...
                  </>
                ) : (
                  <>
                    <RotateCcw className="size-4" />
                    Redefinir Configuração
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Setup Instructions Sidebar */}
        <div>
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-foreground text-base">Instruções de Configuração</CardTitle>
              <CardDescription className="text-muted-foreground font-light">
                {provider === 'waha'
                  ? 'Siga estes passos para conectar sua conta do WhatsApp via WAHA.'
                  : 'Siga estes passos para conectar sua Meta WhatsApp Business API.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {provider === 'waha' ? (
                <Accordion>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                        Executar Container WAHA
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground text-sm leading-relaxed">
                      <p className="mb-2">Execute o container Docker do WAHA no seu servidor ou localmente:</p>
                      <pre className="bg-muted p-2 rounded text-xs overflow-x-auto text-foreground font-mono">
                        docker run -d \<br />
                        &nbsp;&nbsp;-p 3000:3000 \<br />
                        &nbsp;&nbsp;devlikeapro/waha
                      </pre>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                        Configurar Detalhes do Servidor
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground text-sm">
                      <ol className="list-decimal list-inside space-y-1">
                        <li>Insira a URL do seu servidor (ex.: <code className="text-foreground font-mono">http://localhost:3000</code>)</li>
                        <li>Defina um nome de sessão único (ex.: <code className="text-foreground font-mono">default</code>)</li>
                        <li>Informe o token secreto da API se configurado</li>
                        <li>Clique em <strong>Salvar Configuração</strong></li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                        Vincular Conta do WhatsApp
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground text-sm">
                      <ol className="list-decimal list-inside space-y-1">
                        <li>No painel <strong>Controle da Sessão</strong>, clique em <strong>Conectar</strong></li>
                        <li>Escaneie o QR code com o WhatsApp no seu celular</li>
                        <li>Aguarde até o status mudar para <strong className="text-emerald-400">WORKING</strong></li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                        Configurar Webhooks
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground text-sm">
                      <p className="mb-2">No painel ou API do WAHA, configure um webhook apontando para a URL do CRM:</p>
                      <ul className="list-disc list-inside space-y-1 text-xs">
                        <li>Eventos: <code className="text-foreground">message</code>, <code className="text-foreground">message.status</code></li>
                        <li>URL: Copie a URL de callback das configurações</li>
                      </ul>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : (
                <Accordion>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                        Criar Aplicativo na Meta
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Acesse <span className="text-primary">developers.facebook.com</span></li>
                        <li>Clique em &quot;Meus Aplicativos&quot; e depois em &quot;Criar Aplicativo&quot;</li>
                        <li>Selecione &quot;Empresa&quot; como tipo de aplicativo</li>
                        <li>Preencha os detalhes do aplicativo e crie</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                        Adicionar Produto WhatsApp
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>No painel do aplicativo, clique em &quot;Adicionar Produto&quot;</li>
                        <li>Encontre &quot;WhatsApp&quot; e clique em &quot;Configurar&quot;</li>
                        <li>Siga o assistente de configuração para vincular sua empresa</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                        Obter Credenciais da API
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Acesse WhatsApp &gt; Configuração da API</li>
                        <li>Copie o seu <strong className="text-foreground">ID do Número de Telefone</strong></li>
                        <li>Copie o seu <strong className="text-foreground">ID da Conta WhatsApp Business</strong></li>
                        <li>Gere um <strong className="text-foreground">Token de Acesso Permanente</strong> em Configurações do Negócio &gt; Usuários do Sistema</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                        Configurar Webhooks
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Acesse WhatsApp &gt; Configuração</li>
                        <li>Clique em &quot;Editar&quot; na seção do Webhook</li>
                        <li>Cole a <strong className="text-foreground">URL de Callback do Webhook</strong> acima</li>
                        <li>Insira o mesmo <strong className="text-foreground">Token de Verificação</strong> definido aqui</li>
                        <li>Assine o campo &quot;messages&quot; do webhook</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              {provider === 'meta' && (
                <div className="mt-4 pt-4 border-t border-border">
                  <a
                    href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                    Documentação da Meta WhatsApp API
                  </a>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}