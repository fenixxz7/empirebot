# Imperiuns Bot — Painel

Painel em português para automatizar a entrada em filas de Free Fire em servidores Discord.

## Run & Operate

- `npm run dev`: Starts the server in development mode (Vite + Express on port 5000).
- `npm run build`: Builds the application for production.
- `npm run start`: Starts the production server.
- `npm run db:init`: Recreates/updates the database schema and seeds initial data.

**Environment Variables:**
- PostgreSQL connection string (managed by `server/db/`).
- Discord bot tokens (stored in DB, used by workers).

## Stack

- **Runtime:** Node.js 20 + TypeScript (ESM)
- **Backend:** Express, WebSocket (`ws`)
- **Frontend:** React 18, TailwindCSS (dark navy theme)
- **Database:** PostgreSQL (`pg`)
- **Build Tool:** Vite

## Where things live

- `server/`: Backend logic, Express app, database, Discord gateway workers.
  - `server/db/`: Database schema, connection pool, initialization scripts.
  - `server/worker/`: Discord Gateway client and instance manager.
- `shared/types.ts`: Shared TypeScript types between frontend and backend.
- `src/`: React frontend application.
- DB Schema: `server/db/init.ts`
- API Contracts: Defined implicitly by routes in `server/routes/` and types in `shared/types.ts`.

## Architecture decisions

- **Multi-Instance Support:** The system seeds bots (BOT1, BOT2, BOT3) with separate configurations and runtimes, manageable via UI tabs. To add more bots, just add names to the array in `server/db/init.ts`.
- **Real-time Stats:** WebSocket (`ws`) is used for real-time streaming of bot statistics and logs to the panel.
- **Dynamic Queue Discovery:** The system automatically discovers and registers queue channels and interactive buttons within Discord organizations based on configured criteria.
- **Anti-ban Measures:** Various humanization techniques (typing indicators, randomized delays, jitter, long breaks, rate limit backoff) are implemented to prevent Discord account bans.
- **Independent Match Handling:** The queue runner and match handler operate independently, allowing match detection and messaging even if the bot didn't initiate the queue entry.

## Product

- Manages multiple bot instances for Free Fire queue automation.
- Allows configuration of allowed categories (Mobile, Misto, Emulador, Tatico, Full-Soco) for queue channels.
- Supports multiple messages/cards per channel, enabling distinct queues within a single Discord channel.
- Automatically discovers and manages Discord organizations, channels, and interactive buttons.
- Features an intelligent queue runner that prioritizes queues with existing players.
- Detects new match channels and sends customizable match-found messages, including optional images.
- Provides a real-time log console for monitoring bot activity.
- Enables export and import of instance configurations.
- Implements automatic token rotation for bot instances.

## User preferences

- Comunicação em português.
- Sem login no painel (uso pessoal em VPS).
- Tokens são guardados em texto puro no Postgres (decisão explícita do usuário neste momento).
- BOT1, BOT2 e BOT3 todos ativos (abas no topo do painel).
- Orgs: o usuário vai mandar os IDs reais; quando vier, atualizar o seed em `server/db/init.ts` e cadastrar via `guild_id`.

## Gotchas

- **`npm run dev`:** Do not use `tsx watch` directly, as it can silently freeze in this environment. Use `npm run dev` which correctly runs `tsx server/index.ts`.
- **Saving Configuration:** Saving configuration while an instance is running will automatically stop the bot, requiring a manual restart. The UI will reflect this.
- **Channel Category Detection:** The order of suffix detection for channel categories is important (e.g., `full-soco` before `soco`).
- **Discord Gateway Flakiness:** `CHANNEL_CREATE`/`THREAD_CREATE` events might not always be dispatched for selfbots, especially in large guilds or private threads. The `MatchPoller` acts as a fallback.

## Pointers

- **Discord API Documentation:** [https://discord.com/developers/docs/intro](https://discord.com/developers/docs/intro)
- **Node.js Documentation:** [https://nodejs.org/docs/latest/api/](https://nodejs.org/docs/latest/api/)
- **React Documentation:** [https://react.dev/](https://react.dev/)
- **PostgreSQL Documentation:** [https://www.postgresql.org/docs/](https://www.postgresql.org/docs/)