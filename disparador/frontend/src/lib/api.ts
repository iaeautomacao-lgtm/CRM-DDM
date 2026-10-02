import axios from 'axios';

/** Normaliza telefone: remove símbolos, garante prefixo +55.
 *  Ex: "(21) 9 9947-3307" → "+5521999473307", "5521999..." → "+5521999..." */
export const normalizePhoneInput = (raw: string): string => {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '+55';
  if (digits.startsWith('55')) return '+' + digits;
  return '+55' + digits;
};

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
});

// Injeta token JWT em toda requisição
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('access_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redireciona para login se 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined' && !err.config?.url?.startsWith('/auth/')) {
      localStorage.removeItem('access_token');
      document.cookie = 'access_token=;path=/;max-age=0;SameSite=Lax';
      if (!window.location.pathname.startsWith('/auth/')) {
        const next = window.location.pathname + window.location.search;
        window.location.replace(`/auth/login?next=${encodeURIComponent(next)}`);
      }
    }
    return Promise.reject(err);
  }
);

export default api;

// ── Contacts ──────────────────────────────────────────────
export const contactsApi = {
  list: (params?: any) => api.get('/contacts', { params }),
  tags: () => api.get('/contacts/tags'),
  get: (id: string) => api.get(`/contacts/${id}`),
  createOne: (data: any) => api.post('/contacts', data),
  createBulk: (contacts: any[]) => api.post('/contacts/bulk', { contacts }),
  updateStatus: (id: string, status: string) => api.patch(`/contacts/${id}/status`, { status }),
  block: (id: string) => api.patch(`/contacts/${id}/block`),
  update: (id: string, data: any) => api.patch(`/contacts/${id}`, data),
  delete: (id: string) => api.delete(`/contacts/${id}`),
  bulkDelete: (ids: string[]) => api.delete('/contacts/bulk', { data: { ids } }),
  importCsv: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/contacts/import/csv', fd);
  },
  importXlsx: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/contacts/import/xlsx', fd);
  },
};

// ── Uploads ───────────────────────────────────────────────
export const uploadsApi = {
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post<{ url: string }>('/uploads', fd);
  },
};

// ── Campaigns ─────────────────────────────────────────────
export const campaignsApi = {
  list: (params?: any) => api.get('/campaigns', { params }),
  get: (id: string) => api.get(`/campaigns/${id}`),
  create: (data: any) => api.post('/campaigns', data),
  update: (id: string, data: any) => api.patch(`/campaigns/${id}`, data),
  delete: (id: string) => api.delete(`/campaigns/${id}`),
  approve: (id: string) => api.post(`/campaigns/${id}/approve`),
  start: (id: string) => api.post(`/campaigns/${id}/start`),
  pause: (id: string) => api.post(`/campaigns/${id}/pause`),
  stop: (id: string) => api.post(`/campaigns/${id}/stop`),
  addContacts: (id: string, contact_ids: string[]) => api.post(`/campaigns/${id}/contacts`, { contact_ids }),
  duplicate: (id: string) => api.post(`/campaigns/${id}/duplicate`),
  requeue: (id: string) => api.post(`/campaigns/${id}/requeue`),
  queueStatus: (id: string) => api.get(`/message-queue/campaign/${id}`),
  queueDetails: (id: string) => api.get(`/message-queue/campaign/${id}/details`),
};

// ── Message Variations ────────────────────────────────────
export const variationsApi = {
  generate: (data: any) => api.post('/message-variations/generate', data),
  byCampaign: (campaignId: string, onlyApproved?: boolean) =>
    api.get(`/message-variations/campaign/${campaignId}`, { params: { only_approved: onlyApproved } }),
  approve: (id: string) => api.patch(`/message-variations/${id}/approve`),
  reject: (id: string) => api.patch(`/message-variations/${id}/reject`),
};

// ── Sessions ──────────────────────────────────────────────
export const sessionsApi = {
  list: () => api.get('/sessions'),
  listWahaAvailable: () => api.get('/sessions/waha/available'),
  get: (id: string) => api.get(`/sessions/${id}`),
  create: (data: any) => api.post('/sessions', data),
  remove: (id: string) => api.delete(`/sessions/${id}`),
  qrCode: (id: string) => api.get(`/sessions/${id}/qrcode`),
  start: (id: string) => api.post(`/sessions/${id}/start`),
  stop: (id: string) => api.post(`/sessions/${id}/stop`),
  sync: (id: string) => api.post(`/sessions/${id}/sync`),
  getStatus: (id: string) => api.get(`/sessions/${id}/status`),
  updateProxy: (id: string, data: any) => api.patch(`/sessions/${id}/proxy`, data),
  syncAll: () => api.post('/sessions/waha/sync-all'),
};

// ── Blacklist ─────────────────────────────────────────────
export const blacklistApi = {
  list: (params?: any) => api.get('/blacklist', { params }),
  add: (data: any) => api.post('/blacklist', data),
  remove: (id: string) => api.delete(`/blacklist/${id}`),
};

// ── Attendance ────────────────────────────────────────────
export const attendanceApi = {
  list: (params?: any) => api.get('/attendance', { params }),
  get: (id: string) => api.get(`/attendance/${id}`),
  assign: (id: string) => api.patch(`/attendance/${id}/assign`),
  updateStatus: (id: string, data: any) => api.patch(`/attendance/${id}/status`, data),
};

// ── Dashboard ─────────────────────────────────────────────
export const dashboardApi = {
  overview: () => api.get('/dashboard/overview'),
  campaignReport: (id: string) => api.get(`/dashboard/campaigns/${id}/report`),
};
