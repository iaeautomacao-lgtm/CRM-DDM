# Tarefas: Integração do Disparador no CRM Next.js

- [x] Criar as rotas de API do backend (Importação de contatos e Campanhas CRUD)
  - [x] Rota de importação de CSV/XLSX: `/api/disparador/contacts/import`
  - [x] Rotas de CRUD das campanhas: `/api/disparador/campaigns` (Já existentes no CRM)
  - [x] Lógica de enfileiramento na tabela `disp_message_queue` (Já existente no CRM)
- [x] Criar a interface visual (páginas do Frontend)
  - [x] Tela do Painel Principal: `/disparador` (Link para contatos adicionado)
  - [x] Tela de Criação de Campanhas: `/disparador/campanhas` (Já existente no CRM)
  - [x] Tela de Importação e Blacklist: `/disparador/contatos` (Criada)
- [x] Testar e validar o Worker integrado
  - [x] Validar a ativação do worker em background
  - [x] Enviar disparos reais de teste
