export type Category = "Mobile" | "Misto" | "Emulador" | "Tatico" | "Full-Soco";

export const ALL_CATEGORIES: Category[] = [
  "Mobile",
  "Misto",
  "Emulador",
  "Tatico",
  "Full-Soco",
];

export interface Org {
  id: number;
  guild_id: string | null;
  name: string;
  category: Category;
  max_queues: number;
  enabled: boolean;
  priority: number;
  channels_count?: number;
  last_scanned_at?: string | null;
}

export interface OrgChannelButton {
  label: string;
  custom_id: string | null;
  style: number;
  disabled: boolean;
  action: "enter" | "leave" | "play" | "other" | null;
  variant: "normal" | "gel_normal" | "gel_inf" | "full_ump_xm8" | null;
}

export interface OrgChannel {
  id: number;
  channel_id: string;
  channel_name: string | null;
  category: Category | null;
  mode: string | null;
  message_id: string | null;
  embed_title: string | null;
  application_id?: string | null;
  buttons: OrgChannelButton[];
  last_scanned_at: string | null;
}

export type TokenStrategy = "single" | "per_n_orgs" | "full_cycle";

export interface InstanceConfig {
  category: Category;
  allowed_categories: string;
  delay_seconds: number;
  rotation_minutes: number;
  allowed_modes: string;
  message_main: string;
  message_per_org: string;
  image_url: string | null;
  blocked_names: string;
  max_valor: number;
  token_strategy: TokenStrategy;
  token_strategy_n: number;
  timing_intra_min_ms: number;
  timing_intra_max_ms: number;
  timing_pause_min_ms: number;
  timing_pause_max_ms: number;
  timing_click_min_ms: number;
  timing_click_max_ms: number;
  clicks_per_org: number;
  hot_org_extra_clicks: number;
  match_msg_delay_ms: number;
  entry_cap_with_players_per_60s: number;
  entry_cap_empty_per_60s: number;
  entry_cap_total_per_60s: number;
}

export interface Token {
  id: number;
  position: number;
  value_preview: string;
  status: "unknown" | "connected" | "invalid" | "rate_limited" | "disconnected";
  username: string | null;
}

export interface InstanceState {
  id: number;
  name: string;
  running: boolean;
  connected: boolean;
  user_handle: string | null;
  uptime_seconds: number;
  stats: {
    entradas: number;
    na_fila: number;
    partidas: number;
    dms: number;
    bloqueadas: number;
    msgs_enviadas: number;
  };
  tokens_active: number;
  tokens_total: number;
  next_rotation_seconds: number;
}
