---
name: Dev architecture — Vite e Express separados
description: Em dev, Vite roda como processo próprio na porta 5000 e faz proxy para Express na 5001. Não usar Vite como middleware no processo do servidor.
---

# Arquitetura dev: processos separados

## A regra
Vite NUNCA deve rodar como middleware dentro do processo Express neste projeto.

## Por quê
O Vite em modo middleware consome ~250 MB no mesmo processo que o servidor. O bot worker (Gateway Discord) consome mais ~150 MB. Juntos batem o teto de RAM do Replit (~512 MB), causando crash com OOM fatal que derruba o painel inteiro.

## Como está configurado
- `npm run dev` → `tsx server/index.ts & vite`
- Express escuta em **5001** (somente API + WebSocket)
- Vite escuta em **5000** (frontend + proxy para 5001)
- `vite.config.ts`: `server.host = true`, `server.port = 5000`, proxy `/api`, `/health`, `/ws` → `http://localhost:5001`
- `server/index.ts`: em dev, `PORT = 5001`, sem bloco Vite middleware
- Discovery roda em processo filho separado (`server/scripts/discovery-worker.ts`) com 256 MB próprios

## How to apply
Sempre que modificar `server/index.ts` ou `vite.config.ts`, manter essa separação. Em produção (`NODE_ENV=production`), o Express serve os arquivos buildados normalmente na porta 5000.
