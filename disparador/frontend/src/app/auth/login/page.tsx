'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, ArrowRight, AlertCircle } from 'lucide-react';
import api from '@/lib/api';
import { DDM_LOGO_WHITE } from '@/lib/brand';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('access_token', data.access_token);
      document.cookie = `access_token=${encodeURIComponent(data.access_token)};path=/;max-age=86400;SameSite=Lax${window.location.protocol === 'https:' ? ';Secure' : ''}`;
      const next = new URLSearchParams(window.location.search).get('next');
      const destination =
        next?.startsWith('/') &&
        !next.startsWith('//') &&
        !next.includes('\\') &&
        !next.startsWith('/auth')
          ? next
          : '/dashboard';
      router.replace(destination);
    } catch {
      setError('E-mail ou senha inválidos.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: '#0F172A' }}
    >
      {/* Glow laranja DDM ao fundo */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: '30%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 560,
          height: 560,
          background: 'radial-gradient(circle, rgba(255,87,6,0.08) 0%, transparent 70%)',
          borderRadius: '50%',
        }}
      />

      <div className="w-full max-w-sm relative z-10">
        {/* ── Marca DDM ── */}
        <div className="text-center mb-8">
          <img src={DDM_LOGO_WHITE} alt="Grupo DDM" className="h-12 w-auto mx-auto mb-4" />
          <p className="text-sm" style={{ color: '#64748B', fontFamily: 'Inter, sans-serif' }}>
            Plataforma de Disparo — WhatsApp IA
          </p>
        </div>

        {/* ── Card de login ── */}
        <div
          className="rounded-2xl p-8"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <h2
            className="font-semibold text-white mb-6 text-base"
            style={{ fontFamily: 'Poppins, sans-serif' }}
          >
            Acesse sua conta
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* E-mail */}
            <div>
              <label
                className="block text-xs font-medium mb-1.5"
                style={{ color: '#94A3B8', fontFamily: 'Inter, sans-serif' }}
              >
                E-mail
              </label>
              <div className="relative">
                <Mail
                  size={15}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: '#64748B' }}
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu@email.com"
                  required
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    paddingLeft: 40,
                    paddingRight: 16,
                    paddingTop: 10,
                    paddingBottom: 10,
                    fontSize: 14,
                    color: '#F1F5F9',
                    outline: 'none',
                    fontFamily: 'Inter, sans-serif',
                    minHeight: 44,
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--ddm-primary)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(255,87,6,0.2)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'rgba(255,255,255,0.1)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>

            {/* Senha */}
            <div>
              <label
                className="block text-xs font-medium mb-1.5"
                style={{ color: '#94A3B8', fontFamily: 'Inter, sans-serif' }}
              >
                Senha
              </label>
              <div className="relative">
                <Lock
                  size={15}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: '#64748B' }}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    paddingLeft: 40,
                    paddingRight: 16,
                    paddingTop: 10,
                    paddingBottom: 10,
                    fontSize: 14,
                    color: '#F1F5F9',
                    outline: 'none',
                    fontFamily: 'Inter, sans-serif',
                    minHeight: 44,
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--ddm-primary)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(255,87,6,0.2)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'rgba(255,255,255,0.1)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>

            {/* Erro */}
            {error && (
              <div
                className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-lg"
                style={{
                  color: '#FCA5A5',
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  fontFamily: 'Inter, sans-serif',
                }}
              >
                <AlertCircle size={14} className="flex-shrink-0" />
                {error}
              </div>
            )}

            {/* Botão */}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 text-white font-semibold py-2.5 rounded-lg transition-all mt-2"
              style={{
                background: loading ? '#CC4500' : 'var(--ddm-primary)',
                fontFamily: 'Poppins, sans-serif',
                fontSize: 14,
                minHeight: 44,
                boxShadow: '0 4px 16px rgba(255,87,6,0.3)',
                opacity: loading ? 0.7 : 1,
                cursor: loading ? 'not-allowed' : 'pointer',
                border: 'none',
              }}
            >
              {loading ? (
                'Entrando...'
              ) : (
                <>
                  Entrar <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>
        </div>

        <p
          className="text-center text-xs mt-6"
          style={{ color: '#334155', fontFamily: 'Inter, sans-serif' }}
        >
          Grupo DDM · Plataforma Interna
        </p>
      </div>
    </div>
  );
}
